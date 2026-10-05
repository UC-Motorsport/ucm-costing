import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  mkdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { QueryResultRow } from "pg";

import {
  appendAuditEntry,
  type AuditContext,
} from "../audit/audit-ledger";
import {
  getAppPaths,
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../config";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import {
  createVerifiedReadStream,
  openVerifiedFile,
  sha256File,
  type VerifiedFile,
} from "../integrity/file-integrity";
import {
  renderUcm25CompatibleReport,
  type ReportEvidence,
} from "../report/ucm25-renderer";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  getProjectDetailFromExecutor,
} from "./project-detail-service";
import type {
  CostLineRow,
  ProjectDetail,
  ProjectNode,
} from "./project-types";
import {
  validateProject,
  type ValidationResult,
} from "./validation-service";

export type ReportMode =
  | "draft"
  | "deadline"
  | "competition-ready"
  | "export";

export const REPORT_RENDER_HEARTBEAT_INTERVAL_MS = 15_000;
export const REPORT_RENDER_LEASE_TIMEOUT_MS = 120_000;
export const REPORT_MAINTENANCE_INTERVAL_MS = 30_000;

export interface ReportSnapshotRow extends QueryResultRow {
  id: string;
  project_id: string;
  mode: ReportMode;
  status: "rendering" | "complete" | "failed";
  snapshot_json: Record<string, unknown>;
  validation_json: ValidationResult;
  source_hashes_json: Record<string, string>;
  pdf_path: string | null;
  pdf_sha256: string | null;
  pdf_bytes: string | number | null;
  page_count: number | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  render_owner: string | null;
  render_heartbeat_at: string | null;
}

interface ReportSourceRow extends QueryResultRow {
  rule_document_id: string;
  rule_version: string;
  rule_sha256: string;
  rule_local_path: string;
  catalogue_release_id: string;
  catalogue_revision: string;
  catalogue_sha256: string;
  catalogue_local_path: string;
}

interface ReportEvidenceRow extends QueryResultRow {
  id: string;
  node_id: string | null;
  kind: string;
  display_name: string;
  content_sha256: string;
  mime_type: string;
  report_caption: string;
  storage_path: string;
}

interface CatalogueProvenanceRow extends QueryResultRow {
  id: string;
  release_id: string;
  revision: string;
  catalogue_id: string;
  source_sheet: string;
  source_row: number;
}

interface ReportReservation {
  id: string;
  renderOwner: string;
  createdAt: string;
  detail: ProjectDetail;
  validation: ValidationResult;
  evidence: ReportEvidenceRow[];
  sources: ReportSourceRow;
  snapshot: Record<string, unknown>;
}

export interface CreateReportOptions {
  paths?: AppPaths;
  /** Explicit test/development provenance; never inferred from an ID. */
  developerDemo?: boolean;
}

export class ReportValidationError extends Error {
  readonly code = "report-blocked";

  constructor(readonly validation: ValidationResult) {
    super(
      `Competition-ready report is blocked by ${validation.blockers} validation issue(s)`,
    );
  }
}

export function assertReportGenerationAllowed(
  mode: ReportMode,
  validation: ValidationResult,
): void {
  if (
    mode === "competition-ready" &&
    validation.blockers > 0
  ) {
    throw new ReportValidationError(validation);
  }
}

export async function createReport(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  mode: ReportMode,
  options: CreateReportOptions = {},
): Promise<ReportSnapshotRow> {
  const paths = options.paths ?? getAppPaths();
  const reservation = await reserveReport(
    database,
    actor,
    projectId,
    mode,
    options.developerDemo ?? false,
  );
  const temporaryPdf = path.join(
    paths.reportRoot,
    `.${reservation.id}.pdf.tmp`,
  );
  const finalPdf = path.join(paths.reportRoot, `${reservation.id}.pdf`);
  let heartbeatLost = false;
  let committed = false;
  const heartbeat = setInterval(() => {
    void refreshReportLease(
      database,
      reservation.id,
      reservation.renderOwner,
    )
      .then((owned) => {
        heartbeatLost ||= !owned;
      })
      .catch(() => undefined);
  }, REPORT_RENDER_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    await mkdir(paths.reportRoot, { recursive: true });
    await verifyGoverningSources(reservation.sources, paths);
    const evidence = await loadVerifiedEvidence(
      reservation.evidence,
      paths,
    );
    const pageCount = await renderUcm25CompatibleReport({
      destination: temporaryPdf,
      detail: reservation.detail,
      validation: reservation.validation,
      mode,
      evidence,
      paths,
      createdAt: reservation.createdAt,
    });
    const [pdfSha256, pdfStats] = await Promise.all([
      sha256File(temporaryPdf),
      stat(temporaryPdf),
    ]);
    if (
      heartbeatLost ||
      !(await refreshReportLease(
        database,
        reservation.id,
        reservation.renderOwner,
      ))
    ) {
      throw new Error("report-render-lease-lost");
    }
    await rename(temporaryPdf, finalPdf);
    const completed = await database.transaction(async (transaction) => {
      const row = await transaction.maybeOne<ReportSnapshotRow>(
        `
          UPDATE report_snapshots
          SET status = 'complete', pdf_path = $1, pdf_sha256 = $2,
              pdf_bytes = $3, page_count = $4,
              completed_at = clock_timestamp(),
              render_owner = NULL, render_heartbeat_at = NULL
          WHERE id = $5 AND status = 'rendering' AND render_owner = $6
          RETURNING *
        `,
        [
          toStoredDataPath(finalPdf, paths),
          pdfSha256,
          pdfStats.size,
          pageCount,
          reservation.id,
          reservation.renderOwner,
        ],
      );
      if (!row) {
        throw new Error("report-render-lease-lost");
      }
      await appendAuditEntry(transaction, actor, {
        projectId,
        action: "report.completed",
        entityType: "report-snapshot",
        entityId: reservation.id,
        after: auditReport(row),
      });
      return row;
    });
    committed = true;
    return completed;
  } catch (error) {
    await failReservedReport(
      database,
      actor,
      reservation,
      error,
    ).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (!committed) {
      await removeUncommittedReportFiles([
        temporaryPdf,
        finalPdf,
      ]);
    }
  }
}

export async function getReport(
  database: DbExecutor,
  actor: ActorContext,
  reportId: string,
): Promise<ReportSnapshotRow | null> {
  const report = await database.maybeOne<ReportSnapshotRow>(
    "SELECT * FROM report_snapshots WHERE id = $1",
    [reportId],
  );
  if (!report) {
    return null;
  }
  await assertProjectPermission(
    database,
    actor,
    report.project_id,
    "read",
  );
  return report;
}

export async function listReports(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
  limit = 100,
  offset = 0,
): Promise<ReportSnapshotRow[]> {
  await assertProjectPermission(database, actor, projectId, "read");
  assertPagination(limit, offset);
  const result = await database.query<ReportSnapshotRow>(
    `
      SELECT *
      FROM report_snapshots
      WHERE project_id = $1
      ORDER BY created_at DESC, id
      LIMIT $2 OFFSET $3
    `,
    [projectId, limit, offset],
  );
  return result.rows;
}

export async function openReportDownload(
  database: DbExecutor,
  actor: ActorContext,
  reportId: string,
  paths: AppPaths = getAppPaths(),
): Promise<{ report: ReportSnapshotRow; verified: VerifiedFile }> {
  const report = await getReport(database, actor, reportId);
  if (
    !report ||
    report.status !== "complete" ||
    !report.pdf_path ||
    !report.pdf_sha256
  ) {
    throw new Error("report-not-complete");
  }
  const verified = await openVerifiedFile(
    resolveStoredDataPath(report.pdf_path, paths),
    report.pdf_sha256,
  );
  if (
    report.pdf_bytes !== null &&
    verified.stats.size !== Number(report.pdf_bytes)
  ) {
    await verified.handle.close();
    throw new Error("report-byte-size-mismatch");
  }
  return { report, verified };
}

export async function copyReportToOutput(
  database: DbExecutor,
  actor: ActorContext,
  reportId: string,
  filename: string,
  paths: AppPaths = getAppPaths(),
): Promise<string> {
  assertSafeFilename(filename);
  await mkdir(paths.outputPdfRoot, { recursive: true });
  const destination = path.join(paths.outputPdfRoot, filename);
  const { verified } = await openReportDownload(
    database,
    actor,
    reportId,
    paths,
  );
  try {
    await pipeline(
      createVerifiedReadStream(verified),
      fs.createWriteStream(destination, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    return destination;
  } catch (error) {
    await verified.handle.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function refreshReportLease(
  database: DbExecutor,
  reportId: string,
  renderOwner: string,
): Promise<boolean> {
  const result = await database.query(
    `
      UPDATE report_snapshots
      SET render_heartbeat_at = clock_timestamp()
      WHERE id = $1 AND status = 'rendering' AND render_owner = $2
    `,
    [reportId, renderOwner],
  );
  return result.rowCount === 1;
}

export async function reconcileStaleReportLeases(
  database: DatabaseHandle,
  now = new Date(),
  leaseTimeoutMs = REPORT_RENDER_LEASE_TIMEOUT_MS,
  audit: AuditContext = {
    actorUserId: null,
    requestId: `maintenance:${randomUUID()}`,
  },
): Promise<number> {
  const staleBefore = new Date(now.getTime() - leaseTimeoutMs);
  return await database.transaction(async (transaction) => {
    const stale = await transaction.query<ReportSnapshotRow>(
      `
        UPDATE report_snapshots
        SET status = 'failed',
            error_message = 'Report rendering lease expired before completion',
            completed_at = $1,
            render_owner = NULL,
            render_heartbeat_at = NULL
        WHERE status = 'rendering'
          AND (
            render_owner IS NULL
            OR render_heartbeat_at IS NULL
            OR render_heartbeat_at <= $2
          )
        RETURNING *
      `,
      [now.toISOString(), staleBefore.toISOString()],
    );
    for (const report of stale.rows) {
      await appendAuditEntry(transaction, audit, {
        projectId: report.project_id,
        action: "report.render-lease-expired",
        entityType: "report-snapshot",
        entityId: report.id,
        after: auditReport(report),
      });
    }
    return stale.rowCount ?? 0;
  });
}

async function reserveReport(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  mode: ReportMode,
  developerDemo: boolean,
): Promise<ReportReservation> {
  return await database.transaction(
    async (transaction) => {
      await assertProjectPermission(
        transaction,
        actor,
        projectId,
        "write",
        // Report generation freezes and renders existing records; it does not
        // mutate the historical project. Keep editor/admin authorization while
        // allowing a read-only historical workspace to produce an artifact.
        { allowHistorical: true },
      );
      const detail = await getProjectDetailFromExecutor(
        transaction,
        projectId,
      );
      if (!detail) {
        throw new Error("project-not-found");
      }
      const validation = await validateProject(
        transaction,
        detail,
        mode,
      );
      assertReportGenerationAllowed(mode, validation);
      // A PostgreSQL PoolClient executes one statement at a time. Keep these
      // reads sequential so the snapshot works with pg@9 as well as pg@8.
      const sources = await loadReportSources(transaction, projectId);
      const evidenceResult = await transaction.query<ReportEvidenceRow>(
        `
          SELECT id, node_id, kind, display_name, content_sha256,
                 mime_type, report_caption, storage_path
          FROM evidence
          WHERE project_id = $1 AND visibility = 'report'
          ORDER BY CASE kind
            WHEN 'drawing' THEN 1
            WHEN 'image' THEN 2
            WHEN 'manufacturing' THEN 3
            WHEN 'bulk-deviation' THEN 4
            WHEN 'other' THEN 5
            WHEN 'datasheet' THEN 6
            ELSE 7
          END, lower(display_name), id
        `,
        [projectId],
      );
      const timestamp = await transaction.one<{ created_at: string }>(
        "SELECT clock_timestamp() AS created_at",
      );
      const catalogue = await loadCatalogueProvenance(
        transaction,
        detail,
      );
      const id = randomUUID();
      const renderOwner = randomUUID();
      const evidence = evidenceResult.rows;
      const snapshot = {
        schemaVersion: 2,
        snapshotId: id,
        createdAt: timestamp.created_at,
        mode,
        provenance: {
          developerDemo,
          contentSource: "persisted-project-records",
          syntheticTechnicalContent: false,
        },
        sources: {
          rulePack: {
            documentId: sources.rule_document_id,
            version: sources.rule_version,
            sha256: sources.rule_sha256,
          },
          catalogue: {
            releaseId: sources.catalogue_release_id,
            revision: sources.catalogue_revision,
            sha256: sources.catalogue_sha256,
          },
        },
        project: detail.project,
        breakdown: detail.breakdown,
        tree: sanitizeNode(detail.tree, catalogue),
        evidence: evidence.map(
          ({
            storage_path: _storagePath,
            ...metadata
          }) => metadata,
        ),
      };
      const sourceHashes = {
        localAddendum: sources.rule_sha256,
        catalogue: sources.catalogue_sha256,
      };
      const inserted = await transaction.one<ReportSnapshotRow>(
        `
          INSERT INTO report_snapshots(
            id, project_id, mode, status, snapshot_json,
            validation_json, source_hashes_json, created_by,
            created_at, render_owner, render_heartbeat_at
          )
          VALUES (
            $1, $2, $3, 'rendering', $4::jsonb,
            $5::jsonb, $6::jsonb, $7,
            $8, $9, $8
          )
          RETURNING *
        `,
        [
          id,
          projectId,
          mode,
          JSON.stringify(snapshot),
          JSON.stringify(validation),
          JSON.stringify(sourceHashes),
          actor.actorUserId,
          timestamp.created_at,
          renderOwner,
        ],
      );
      await appendAuditEntry(transaction, actor, {
        projectId,
        action: "report.reserved",
        entityType: "report-snapshot",
        entityId: id,
        after: auditReport(inserted),
      });
      return {
        id,
        renderOwner,
        createdAt: timestamp.created_at,
        detail,
        validation,
        evidence,
        sources,
        snapshot,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

async function failReservedReport(
  database: DatabaseHandle,
  actor: ActorContext,
  reservation: ReportReservation,
  error: unknown,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const failed = await transaction.maybeOne<ReportSnapshotRow>(
      `
        UPDATE report_snapshots
        SET status = 'failed', error_message = $1,
            completed_at = clock_timestamp(),
            render_owner = NULL, render_heartbeat_at = NULL
        WHERE id = $2 AND status = 'rendering' AND render_owner = $3
        RETURNING *
      `,
      [
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : "Unknown PDF rendering error",
        reservation.id,
        reservation.renderOwner,
      ],
    );
    if (failed) {
      await appendAuditEntry(transaction, actor, {
        projectId: failed.project_id,
        action: "report.failed",
        entityType: "report-snapshot",
        entityId: failed.id,
        after: auditReport(failed),
      });
    }
  });
}

async function loadReportSources(
  database: DbExecutor,
  projectId: string,
): Promise<ReportSourceRow> {
  return await database.one<ReportSourceRow>(
    `
      SELECT
        rule.id AS rule_document_id,
        p.rule_pack_version AS rule_version,
        rule.sha256 AS rule_sha256,
        rule.local_path AS rule_local_path,
        cr.id AS catalogue_release_id,
        cr.revision_code AS catalogue_revision,
        catalogue.sha256 AS catalogue_sha256,
        catalogue.local_path AS catalogue_local_path
      FROM projects p
      JOIN source_documents rule ON rule.id = p.rule_source_document_id
      JOIN catalogue_releases cr ON cr.id = p.catalogue_release_id
      JOIN source_documents catalogue
        ON catalogue.id = cr.source_document_id
      WHERE p.id = $1
    `,
    [projectId],
  );
}

async function loadCatalogueProvenance(
  database: DbExecutor,
  detail: ProjectDetail,
): Promise<Map<string, CatalogueProvenanceRow>> {
  const ids = [
    ...new Set(
      detail.flatNodes.flatMap(({ costLines }) =>
        costLines.flatMap((line) => [
          line.catalogue_item_id,
          line.multiplier_catalogue_item_id,
        ]),
      ).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) {
    return new Map();
  }
  const result = await database.query<CatalogueProvenanceRow>(
    `
      SELECT ci.id, ci.release_id, cr.revision_code AS revision,
             ci.catalogue_id, ci.source_sheet, ci.source_row
      FROM catalogue_items ci
      JOIN catalogue_releases cr ON cr.id = ci.release_id
      WHERE ci.id = ANY($1::text[])
    `,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function verifyGoverningSources(
  sources: ReportSourceRow,
  paths: AppPaths,
): Promise<void> {
  const candidates = [
    [sources.rule_local_path, sources.rule_sha256],
    [sources.catalogue_local_path, sources.catalogue_sha256],
  ] as const;
  for (const [storedPath, expectedHash] of candidates) {
    const absolutePath = resolveRepositoryPath(storedPath, paths);
    const verified = await openVerifiedFile(
      absolutePath,
      expectedHash,
    );
    await verified.handle.close();
  }
}

async function loadVerifiedEvidence(
  rows: readonly ReportEvidenceRow[],
  paths: AppPaths,
): Promise<ReportEvidence[]> {
  return await Promise.all(
    rows.map(async (row) => {
      const verified = await openVerifiedFile(
        resolveStoredDataPath(row.storage_path, paths),
        row.content_sha256,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of createVerifiedReadStream(verified)) {
        chunks.push(chunk as Buffer);
      }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      return {
        id: row.id,
        nodeId: row.node_id,
        kind: row.kind,
        displayName: row.display_name,
        contentSha256: row.content_sha256,
        mimeType: row.mime_type,
        reportCaption: row.report_caption,
        verifiedBytes: bytes,
      };
    }),
  );
}

function sanitizeNode(
  node: ProjectNode,
  catalogue: ReadonlyMap<string, CatalogueProvenanceRow>,
): Record<string, unknown> {
  const {
    internal_note: _internalNote,
    children,
    costLines,
    ...fields
  } = node;
  return {
    ...fields,
    costLines: costLines.map((line) =>
      sanitizeCostLine(line, catalogue),
    ),
    children: children.map((child) =>
      sanitizeNode(child, catalogue),
    ),
  };
}

function sanitizeCostLine(
  line: CostLineRow,
  catalogue: ReadonlyMap<string, CatalogueProvenanceRow>,
): Record<string, unknown> {
  const item = line.catalogue_item_id
    ? catalogue.get(line.catalogue_item_id)
    : undefined;
  const multiplier = line.multiplier_catalogue_item_id
    ? catalogue.get(line.multiplier_catalogue_item_id)
    : undefined;
  return {
    ...line,
    catalogue: item
      ? {
          releaseId: item.release_id,
          revision: item.revision,
          itemId: item.id,
          catalogueId: item.catalogue_id,
          sourceSheet: item.source_sheet,
          sourceRow: item.source_row,
        }
      : null,
    multiplierCatalogue: multiplier
      ? {
          releaseId: multiplier.release_id,
          revision: multiplier.revision,
          itemId: multiplier.id,
          catalogueId: multiplier.catalogue_id,
          sourceSheet: multiplier.source_sheet,
          sourceRow: multiplier.source_row,
        }
      : null,
  };
}

function resolveRepositoryPath(
  storedPath: string,
  paths: AppPaths,
): string {
  const resolved = path.resolve(paths.repositoryRoot, storedPath);
  const relative = path.relative(paths.repositoryRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("source-path-outside-repository");
  }
  return resolved;
}

function auditReport(
  report: ReportSnapshotRow,
): Record<string, unknown> {
  return {
    id: report.id,
    projectId: report.project_id,
    mode: report.mode,
    status: report.status,
    pdfSha256: report.pdf_sha256,
    pdfBytes: report.pdf_bytes,
    pageCount: report.page_count,
    createdBy: report.created_by,
    createdAt: report.created_at,
    completedAt: report.completed_at,
    errorMessage: report.error_message,
  };
}

function assertPagination(limit: number, offset: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid-report-pagination");
  }
}

function assertSafeFilename(filename: string): void {
  if (
    !filename ||
    filename !== path.basename(filename) ||
    path.extname(filename).toLowerCase() !== ".pdf" ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new Error("invalid-report-output-filename");
  }
}

async function removeUncommittedReportFiles(
  paths: readonly string[],
): Promise<void> {
  await Promise.all(
    paths.map((candidate) =>
      unlink(candidate).catch(() => undefined),
    ),
  );
}
