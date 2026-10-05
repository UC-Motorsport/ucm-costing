import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import {
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
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import { appendAuditEntry } from "../audit/audit-ledger";
import { VersionConflictError } from "./project-lifecycle-service";

const reportEvidenceMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

const evidenceInputSchema = z.object({
  kind: z.enum([
    "drawing",
    "image",
    "datasheet",
    "manufacturing",
    "bulk-deviation",
    "other",
  ]),
  nodeId: z.string().min(1).nullable().optional(),
  visibility: z.enum(["internal", "report"]).default("internal"),
  reportCaption: z.string().trim().max(500).default(""),
});

const evidenceMetadataInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    visibility: z.enum(["internal", "report"]).optional(),
    reportCaption: z.string().trim().max(500).optional(),
  })
  .refine(
    ({ visibility, reportCaption }) =>
      visibility !== undefined || reportCaption !== undefined,
    { message: "At least one evidence field must be provided" },
  );

const evidenceReplacementInputSchema = z.object({
  expectedVersion: z.coerce.number().int().nonnegative(),
});

export interface EvidenceRow extends QueryResultRow {
  id: string;
  node_id: string | null;
  project_id: string;
  kind:
    | "drawing"
    | "image"
    | "datasheet"
    | "manufacturing"
    | "bulk-deviation"
    | "other";
  display_name: string;
  content_sha256: string;
  byte_size: string | null;
  storage_path: string;
  mime_type: string;
  visibility: "internal" | "report";
  report_caption: string;
  version: number;
  created_at: string;
  updated_at: string;
}

type EvidenceFileCleanupReason =
  | "replacement"
  | "deletion"
  | "staged-file";

interface EvidenceFileCleanupRow extends QueryResultRow {
  storage_path: string;
  project_id: string;
  reason: EvidenceFileCleanupReason;
  queued_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

export interface EvidenceFileCleanupResult {
  processed: number;
  removed: number;
  failed: number;
}

export interface EvidenceFileCleanupStatus {
  pending: number;
  failed: number;
}

export interface StoreEvidenceResult {
  evidence: EvidenceRow;
  alreadyStored: boolean;
}

interface StoreEvidenceOptions {
  allowHistorical?: boolean;
  idempotentByNameAndHash?: boolean;
}

export async function listEvidence(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
): Promise<EvidenceRow[]> {
  await assertProjectPermission(database, actor, projectId, "read");
  const result = await database.query<EvidenceRow>(
    `
      SELECT *
      FROM evidence
      WHERE project_id = $1
      ORDER BY created_at DESC, lower(display_name), id
    `,
    [projectId],
  );
  return result.rows;
}

export async function getEvidence(
  database: DbExecutor,
  evidenceId: string,
): Promise<EvidenceRow | null> {
  return await database.maybeOne<EvidenceRow>(
    "SELECT * FROM evidence WHERE id = $1",
    [evidenceId],
  );
}

export async function getEvidenceForActor(
  database: DbExecutor,
  actor: ActorContext,
  evidenceId: string,
): Promise<EvidenceRow | null> {
  const evidence = await getEvidence(database, evidenceId);
  if (!evidence) {
    return null;
  }
  await assertProjectPermission(database, actor, evidence.project_id, "read");
  return evidence;
}

export async function storeEvidence(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  projectId: string,
  file: Express.Multer.File,
  rawInput: unknown,
  options: StoreEvidenceOptions = {},
): Promise<EvidenceRow> {
  return (
    await storeEvidenceWithResult(
      database,
      paths,
      actor,
      projectId,
      file,
      rawInput,
      options,
    )
  ).evidence;
}

export async function storeEvidenceIdempotently(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  projectId: string,
  file: Express.Multer.File,
  rawInput: unknown,
  options: Omit<StoreEvidenceOptions, "idempotentByNameAndHash"> = {},
): Promise<StoreEvidenceResult> {
  return await storeEvidenceWithResult(
    database,
    paths,
    actor,
    projectId,
    file,
    rawInput,
    { ...options, idempotentByNameAndHash: true },
  );
}

async function storeEvidenceWithResult(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  projectId: string,
  file: Express.Multer.File,
  rawInput: unknown,
  options: StoreEvidenceOptions,
): Promise<StoreEvidenceResult> {
  const input = evidenceInputSchema.parse(rawInput);
  assertSupportedEvidence(file);
  assertEvidenceCanUseVisibility(
    input.visibility,
    file.mimetype,
    input.reportCaption,
  );
  await assertProjectPermission(database, actor, projectId, "write", {
    allowHistorical: options.allowHistorical,
  });

  const id = randomUUID();
  const extension = extensionForMime(file.mimetype);
  const projectDirectory = path.join(paths.uploadRoot, projectId);
  const finalPath = path.join(projectDirectory, `${id}${extension}`);
  const temporaryPath = path.join(projectDirectory, `.${id}.uploading`);
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const storedPath = toStoredDataPath(finalPath, paths);

  await mkdir(projectDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, file.buffer, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await Promise.all(
      [temporaryPath, finalPath].map((candidate) =>
        removeAbsoluteFileOrQueueCleanup(
          database,
          paths,
          projectId,
          candidate,
          "staged-file",
        ),
      ),
    );
    throw error;
  }

  try {
    const evidence = await database.transaction(async (transaction) => {
      await lockProjectForEvidence(transaction, projectId);
      await assertProjectPermission(transaction, actor, projectId, "write", {
        allowHistorical: options.allowHistorical,
      });
      if (input.nodeId) {
        const node = await transaction.maybeOne<{ id: string }>(
          `
            SELECT id
            FROM cost_nodes
            WHERE id = $1 AND project_id = $2
          `,
          [input.nodeId, projectId],
        );
        if (!node) {
          throw new Error("node-not-found");
        }
      }
      if (options.idempotentByNameAndHash) {
        const matchingName = await transaction.query<EvidenceRow>(
          `
            SELECT *
            FROM evidence
            WHERE project_id = $1 AND display_name = $2
            ORDER BY created_at, id
          `,
          [projectId, file.originalname],
        );
        if (matchingName.rows.length > 0) {
          const existing = matchingName.rows.find(
            (candidate) =>
              candidate.content_sha256 === sha256 &&
              Number(candidate.byte_size) === file.buffer.byteLength &&
              candidate.mime_type === file.mimetype &&
              candidate.kind === input.kind &&
              candidate.node_id === (input.nodeId ?? null) &&
              candidate.visibility === input.visibility &&
              candidate.report_caption === input.reportCaption,
          );
          if (existing) {
            return existing;
          }
          throw new Error("archive-sidecar-identity-conflict");
        }
      }
      const evidence = await transaction.one<EvidenceRow>(
        `
          INSERT INTO evidence(
            id, node_id, project_id, kind, display_name, content_sha256,
            byte_size, storage_path, mime_type, visibility, report_caption,
            version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, now(), now()
          )
          RETURNING *
        `,
        [
          id,
          input.nodeId ?? null,
          projectId,
          input.kind,
          file.originalname,
          sha256,
          file.buffer.byteLength,
          storedPath,
          file.mimetype || "application/octet-stream",
          input.visibility,
          input.reportCaption,
        ],
      );
      await touchProject(transaction, projectId, actor.actorUserId);
      await appendAuditEntry(transaction, actor, {
        projectId,
        action: "evidence.created",
        entityType: "evidence",
        entityId: id,
        after: auditEvidenceState(evidence),
      });
      return evidence;
    });
    const alreadyStored = evidence.id !== id;
    if (alreadyStored) {
      await removeAbsoluteFileOrQueueCleanup(
        database,
        paths,
        projectId,
        finalPath,
        "staged-file",
      );
    }
    return { evidence, alreadyStored };
  } catch (error) {
    await removeAbsoluteFileOrQueueCleanup(
      database,
      paths,
      projectId,
      finalPath,
      "staged-file",
    );
    throw error;
  }
}

export async function updateEvidenceMetadata(
  database: DatabaseHandle,
  actor: ActorContext,
  evidenceId: string,
  rawInput: unknown,
): Promise<EvidenceRow> {
  const input = evidenceMetadataInputSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const projectId = await projectIdForEvidence(transaction, evidenceId);
    await lockProjectForEvidence(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const existing = await requireEvidenceForUpdate(transaction, evidenceId);
    assertExpectedVersion(existing, input.expectedVersion);
    await assertEvidenceNotFrozenByCair(transaction, evidenceId);
    const visibility = input.visibility ?? existing.visibility;
    const reportCaption = input.reportCaption ?? existing.report_caption;
    assertEvidenceCanUseVisibility(
      visibility,
      existing.mime_type,
      reportCaption,
    );
    const updatedResult = await transaction.query<EvidenceRow>(
      `
        UPDATE evidence
        SET visibility = $1, report_caption = $2,
            version = version + 1, updated_at = now()
        WHERE id = $3 AND version = $4
        RETURNING *
      `,
      [visibility, reportCaption, evidenceId, input.expectedVersion],
    );
    if (updatedResult.rowCount !== 1) {
      throw new VersionConflictError("Evidence changed while saving");
    }
    const updated = updatedResult.rows[0]!;
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "evidence.metadata-updated",
      entityType: "evidence",
      entityId: evidenceId,
      before: auditEvidenceState(existing),
      after: auditEvidenceState(updated),
    });
    return updated;
  });
}

export async function replaceEvidenceFile(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  evidenceId: string,
  file: Express.Multer.File,
  rawInput: unknown,
): Promise<EvidenceRow> {
  const input = evidenceReplacementInputSchema.parse(rawInput);
  assertSupportedEvidence(file);
  const initial = await getEvidence(database, evidenceId);
  if (!initial) {
    throw new Error("evidence-not-found");
  }
  await assertProjectPermission(database, actor, initial.project_id, "write");
  assertExpectedVersion(initial, input.expectedVersion);
  assertEvidenceCanUseVisibility(
    initial.visibility,
    file.mimetype,
    initial.report_caption,
  );

  const replacementId = randomUUID();
  const extension = extensionForMime(file.mimetype);
  const projectDirectory = path.join(paths.uploadRoot, initial.project_id);
  const finalPath = path.join(
    projectDirectory,
    `${evidenceId}-${replacementId}${extension}`,
  );
  const temporaryPath = path.join(
    projectDirectory,
    `.${evidenceId}-${replacementId}.uploading`,
  );
  const storedPath = toStoredDataPath(finalPath, paths);
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");

  await mkdir(projectDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, file.buffer, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await Promise.all(
      [temporaryPath, finalPath].map((candidate) =>
        removeAbsoluteFileOrQueueCleanup(
          database,
          paths,
          initial.project_id,
          candidate,
          "staged-file",
        ),
      ),
    );
    throw error;
  }

  let replacement: {
    evidence: EvidenceRow;
    previousStoragePath: string;
  };
  try {
    replacement = await database.transaction(async (transaction) => {
      await lockProjectForEvidence(transaction, initial.project_id);
      await assertProjectPermission(
        transaction,
        actor,
        initial.project_id,
        "write",
      );
      const existing = await requireEvidenceForUpdate(transaction, evidenceId);
      assertExpectedVersion(existing, input.expectedVersion);
      await assertEvidenceNotFrozenByCair(transaction, evidenceId);
      await assertNoRenderingReport(transaction, existing.project_id);
      assertEvidenceCanUseVisibility(
        existing.visibility,
        file.mimetype,
        existing.report_caption,
      );
      await enqueueEvidenceFileCleanup(
        transaction,
        existing.storage_path,
        existing.project_id,
        "replacement",
      );
      const updatedResult = await transaction.query<EvidenceRow>(
        `
          UPDATE evidence
          SET display_name = $1, content_sha256 = $2, byte_size = $3,
              storage_path = $4, mime_type = $5,
              version = version + 1, updated_at = now()
          WHERE id = $6 AND version = $7
          RETURNING *
        `,
        [
          file.originalname,
          sha256,
          file.buffer.byteLength,
          storedPath,
          file.mimetype,
          evidenceId,
          input.expectedVersion,
        ],
      );
      if (updatedResult.rowCount !== 1) {
        throw new VersionConflictError(
          "Evidence changed while replacing its file",
        );
      }
      const evidence = updatedResult.rows[0]!;
      await touchProject(
        transaction,
        existing.project_id,
        actor.actorUserId,
      );
      await appendAuditEntry(transaction, actor, {
        projectId: existing.project_id,
        action: "evidence.file-replaced",
        entityType: "evidence",
        entityId: evidenceId,
        before: auditEvidenceState(existing),
        after: auditEvidenceState(evidence),
      });
      return {
        evidence,
        previousStoragePath: existing.storage_path,
      };
    });
  } catch (error) {
    await removeAbsoluteFileOrQueueCleanup(
      database,
      paths,
      initial.project_id,
      finalPath,
      "staged-file",
    );
    throw error;
  }

  await processEvidenceFileCleanup(database, paths, {
    storagePath: replacement.previousStoragePath,
  });
  return replacement.evidence;
}

export async function deleteEvidence(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  evidenceId: string,
  expectedVersion: number,
): Promise<void> {
  const removed = await database.transaction(async (transaction) => {
    const projectId = await projectIdForEvidence(transaction, evidenceId);
    await lockProjectForEvidence(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const existing = await requireEvidenceForUpdate(transaction, evidenceId);
    assertExpectedVersion(existing, expectedVersion);
    await assertEvidenceHasNoCairAttachment(transaction, evidenceId);
    await assertNoRenderingReport(transaction, projectId);
    await enqueueEvidenceFileCleanup(
      transaction,
      existing.storage_path,
      projectId,
      "deletion",
    );
    const deleted = await transaction.query(
      `
        DELETE FROM evidence
        WHERE id = $1 AND version = $2
        RETURNING id
      `,
      [evidenceId, expectedVersion],
    );
    if (deleted.rowCount !== 1) {
      throw new VersionConflictError("Evidence changed while deleting");
    }
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "evidence.deleted",
      entityType: "evidence",
      entityId: evidenceId,
      before: auditEvidenceState(existing),
      after: null,
    });
    return existing;
  });

  await processEvidenceFileCleanup(database, paths, {
    storagePath: removed.storage_path,
  });
}

export async function processEvidenceFileCleanup(
  database: DatabaseHandle,
  paths: AppPaths,
  options: { storagePath?: string; limit?: number } = {},
): Promise<EvidenceFileCleanupResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  const workerId = randomUUID();
  const rows = await claimEvidenceCleanupRows(
    database,
    workerId,
    options.storagePath,
    limit,
  );
  const result: EvidenceFileCleanupResult = {
    processed: rows.length,
    removed: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      await unlink(resolveStoredDataPath(row.storage_path, paths));
      await completeEvidenceCleanup(database, workerId, row.storage_path);
      result.removed += 1;
    } catch (error) {
      if (isMissingFileError(error)) {
        await completeEvidenceCleanup(database, workerId, row.storage_path);
        result.removed += 1;
        continue;
      }
      await recordEvidenceCleanupFailure(
        database,
        workerId,
        row.storage_path,
        error,
      );
      result.failed += 1;
    }
  }
  return result;
}

export async function getEvidenceFileCleanupStatus(
  database: DbExecutor,
): Promise<EvidenceFileCleanupStatus> {
  return await database.one<EvidenceFileCleanupStatus & QueryResultRow>(
    `
      SELECT
        COUNT(*)::int AS pending,
        COUNT(*) FILTER (WHERE attempts > 0)::int AS failed
      FROM evidence_file_cleanup
    `,
  );
}

async function claimEvidenceCleanupRows(
  database: DatabaseHandle,
  workerId: string,
  storagePath: string | undefined,
  limit: number,
): Promise<EvidenceFileCleanupRow[]> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<EvidenceFileCleanupRow>(
      `
        WITH candidates AS (
          SELECT storage_path
          FROM evidence_file_cleanup
          WHERE ($1::text IS NULL OR storage_path = $1)
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at < now()
            )
          ORDER BY queued_at, storage_path
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE evidence_file_cleanup cleanup
        SET lease_owner = $3,
            lease_expires_at = now() + interval '2 minutes'
        FROM candidates
        WHERE cleanup.storage_path = candidates.storage_path
        RETURNING cleanup.*
      `,
      [storagePath ?? null, limit, workerId],
    );
    return result.rows;
  });
}

async function completeEvidenceCleanup(
  database: DbExecutor,
  workerId: string,
  storagePath: string,
): Promise<void> {
  await database.query(
    `
      DELETE FROM evidence_file_cleanup
      WHERE storage_path = $1 AND lease_owner = $2
    `,
    [storagePath, workerId],
  );
}

async function enqueueEvidenceFileCleanup(
  database: DbExecutor,
  storagePath: string,
  projectId: string,
  reason: EvidenceFileCleanupReason,
): Promise<void> {
  await database.query(
    `
      INSERT INTO evidence_file_cleanup(
        storage_path, project_id, reason, queued_at, attempts
      )
      VALUES ($1, $2, $3, now(), 0)
      ON CONFLICT (storage_path) DO NOTHING
    `,
    [storagePath, projectId, reason],
  );
}

async function removeAbsoluteFileOrQueueCleanup(
  database: DbExecutor,
  paths: AppPaths,
  projectId: string,
  absolutePath: string,
  reason: EvidenceFileCleanupReason,
): Promise<void> {
  try {
    await unlink(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    try {
      const storagePath = toStoredDataPath(absolutePath, paths);
      await enqueueEvidenceFileCleanup(
        database,
        storagePath,
        projectId,
        reason,
      );
      await database.query(
        `
          UPDATE evidence_file_cleanup
          SET attempts = attempts + 1, last_attempt_at = now(),
              last_error = $1, lease_owner = NULL, lease_expires_at = NULL
          WHERE storage_path = $2
        `,
        [cleanupErrorMessage(error), storagePath],
      );
    } catch {
      // The caller still receives the original operation error. A filesystem
      // reconciliation command remains the operator fallback if queue storage
      // itself is unavailable.
    }
  }
}

async function recordEvidenceCleanupFailure(
  database: DbExecutor,
  workerId: string,
  storagePath: string,
  error: unknown,
): Promise<void> {
  await database.query(
    `
      UPDATE evidence_file_cleanup
      SET attempts = attempts + 1, last_attempt_at = now(),
          last_error = $1, lease_owner = NULL, lease_expires_at = NULL
      WHERE storage_path = $2 AND lease_owner = $3
    `,
    [cleanupErrorMessage(error), storagePath, workerId],
  );
}

async function projectIdForEvidence(
  database: DbExecutor,
  evidenceId: string,
): Promise<string> {
  const row = await database.maybeOne<{ project_id: string }>(
    "SELECT project_id FROM evidence WHERE id = $1",
    [evidenceId],
  );
  if (!row) {
    throw new Error("evidence-not-found");
  }
  return row.project_id;
}

async function requireEvidenceForUpdate(
  transaction: TransactionHandle,
  evidenceId: string,
): Promise<EvidenceRow> {
  const evidence = await transaction.maybeOne<EvidenceRow>(
    "SELECT * FROM evidence WHERE id = $1 FOR UPDATE",
    [evidenceId],
  );
  if (!evidence) {
    throw new Error("evidence-not-found");
  }
  return evidence;
}

async function lockProjectForEvidence(
  transaction: TransactionHandle,
  projectId: string,
): Promise<void> {
  const project = await transaction.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
}

async function assertNoRenderingReport(
  database: DbExecutor,
  projectId: string,
): Promise<void> {
  const rendering = await database.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM report_snapshots
      WHERE project_id = $1 AND status = 'rendering'
      LIMIT 1
    `,
    [projectId],
  );
  if (rendering) {
    throw new Error("evidence-report-rendering-conflict");
  }
}

async function touchProject(
  transaction: TransactionHandle,
  projectId: string,
  actorUserId: string,
): Promise<void> {
  const result = await transaction.query(
    `
      UPDATE projects
      SET version = version + 1, updated_by = $1, updated_at = now()
      WHERE id = $2
      RETURNING id
    `,
    [actorUserId, projectId],
  );
  if (result.rowCount !== 1) {
    throw new Error("project-not-found");
  }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "application/pdf":
      return ".pdf";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "text/plain":
      return ".txt";
    default:
      throw new Error("evidence-file-type-unsupported");
  }
}

function assertSupportedEvidence(file: Express.Multer.File): void {
  const bytes = file.buffer;
  const valid =
    (file.mimetype === "application/pdf" &&
      bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (file.mimetype === "image/png" &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) ||
    (file.mimetype === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (file.mimetype === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    (file.mimetype === "text/plain" && !bytes.includes(0));
  if (!valid) {
    throw new Error("evidence-file-type-unsupported");
  }
}

function assertEvidenceCanUseVisibility(
  visibility: EvidenceRow["visibility"],
  mimeType: string,
  reportCaption: string,
): void {
  if (visibility !== "report") {
    return;
  }
  if (!reportEvidenceMimeTypes.has(mimeType)) {
    throw new Error("report-evidence-type-unsupported");
  }
  if (!reportCaption.trim()) {
    throw new Error("report-evidence-caption-required");
  }
}

function assertExpectedVersion(
  evidence: EvidenceRow,
  expectedVersion: number,
): void {
  if (evidence.version !== expectedVersion) {
    throw new VersionConflictError(
      `Evidence changed from version ${expectedVersion} to ${evidence.version}`,
    );
  }
}

function auditEvidenceState(evidence: EvidenceRow): Record<string, unknown> {
  return {
    id: evidence.id,
    nodeId: evidence.node_id,
    projectId: evidence.project_id,
    kind: evidence.kind,
    displayName: evidence.display_name,
    contentSha256: evidence.content_sha256,
    byteSize: evidence.byte_size,
    mimeType: evidence.mime_type,
    visibility: evidence.visibility,
    reportCaption: evidence.report_caption,
    version: evidence.version,
  };
}

async function assertEvidenceNotFrozenByCair(
  database: DbExecutor,
  evidenceId: string,
): Promise<void> {
  const frozen = await database.maybeOne<{ cair_id: string }>(
    `
      SELECT ce.cair_id
      FROM cair_evidence ce
      JOIN cair_requests cr ON cr.id = ce.cair_id
      WHERE ce.evidence_id = $1
        AND (ce.frozen_at IS NOT NULL OR cr.status <> 'draft')
      LIMIT 1
    `,
    [evidenceId],
  );
  if (frozen) {
    throw new Error("evidence-cair-reference-protected");
  }
}

async function assertEvidenceHasNoCairAttachment(
  database: DbExecutor,
  evidenceId: string,
): Promise<void> {
  const attached = await database.maybeOne<{ cair_id: string }>(
    "SELECT cair_id FROM cair_evidence WHERE evidence_id = $1 LIMIT 1",
    [evidenceId],
  );
  if (attached) {
    throw new Error("evidence-cair-reference-protected");
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error &&
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? `${(error as NodeJS.ErrnoException).code}: `
        : "";
    return `${code}${error.message}`.slice(0, 1_000);
  }
  return "Unknown evidence file cleanup failure";
}
