import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { appendAuditEntry } from "../audit/audit-ledger";
import type { DatabaseHandle, DbExecutor } from "../db/database";
import type { CsvPreview, LegacyMasterRecord } from "../import";
import { detectAndPreviewCsv } from "../import";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import { VersionConflictError } from "./project-lifecycle-service";

export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
}

export interface StoredImportPreview {
  id: string;
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  status: "preview" | "committed" | "cancelled";
  version: number;
  preview: CsvPreview;
  createdAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  createdBy: UserSummary;
}

export interface ImportBatchSummary {
  id: string;
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  template: CsvPreview["template"];
  status: "preview" | "committed" | "cancelled";
  version: number;
  createdAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  createdBy: UserSummary;
  errors: number;
  warnings: number;
  insertedNodes: number;
  skippedRows: number;
}

export interface ImportCommitResult {
  batchId: string;
  status: "committed";
  version: number;
  insertedNodes: number;
  skippedRows: number;
  alreadyCommitted: boolean;
  committedAt: string;
}

interface ImportBatchRow extends QueryResultRow {
  id: string;
  project_id: string;
  template: CsvPreview["template"];
  source_name: string;
  source_sha256: string;
  status: "preview" | "committed" | "cancelled";
  version: number;
  preview_json: CsvPreview;
  created_at: string;
  committed_at: string | null;
  cancelled_at: string | null;
  created_by: string;
  creator_display_name: string;
  creator_email: string;
}

interface NodeInsert {
  id: string;
  project_id: string;
  parent_id: string;
  kind: "assembly" | "part";
  system_code: string;
  raw_hla: string | null;
  raw_subassembly: string | null;
  raw_part_number: string | null;
  reference_id: string | null;
  name: string;
  description: string;
  revision: string | null;
  procurement_type: "made" | "bought" | "unknown";
  quantity: string;
  internal_note: string;
  source_import_batch_id: string;
  source_import_row: number;
  sort_order: number;
}

export async function createImportPreview(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  sourceName: string,
  buffer: Buffer,
  options: { allowHistorical?: boolean } = {},
): Promise<StoredImportPreview> {
  await assertProjectPermission(database, actor, projectId, "write", {
    allowHistorical: options.allowHistorical,
  });
  const preview = detectAndPreviewCsv(buffer, { sourceName });
  const id = randomUUID();
  const sourceSha256 = createHash("sha256").update(buffer).digest("hex");
  const candidatesByRow = candidatesFromPreview(preview);
  const rows = preview.rawRows.map((rawRow) => ({
    id: randomUUID(),
    row_number: rawRow.rowNumber,
    raw_json: rawRow,
    candidate_json: candidatesByRow.get(rawRow.rowNumber) ?? null,
  }));
  const issues = preview.issues.map((issue) => ({
    id: randomUUID(),
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    row_number: issue.rowNumber ?? null,
    field: issue.field ?? null,
    issue_json: issue,
  }));

  return database.transaction(async (transaction) => {
    await lockProject(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write", {
      allowHistorical: options.allowHistorical,
    });
    const batch = await transaction.one<ImportBatchRow>(
      `
        WITH inserted AS (
          INSERT INTO import_batches(
            id, project_id, template, source_name, source_sha256,
            source_encoding, status, preview_json, created_at, version,
            created_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'preview', $7::jsonb, now(), 0, $8
          )
          RETURNING *
        )
        SELECT inserted.*, u.display_name AS creator_display_name,
               u.email AS creator_email
        FROM inserted
        JOIN users u ON u.id = inserted.created_by
      `,
      [
        id,
        projectId,
        preview.template,
        sourceName.slice(0, 255),
        sourceSha256,
        preview.encoding,
        JSON.stringify(preview),
        actor.actorUserId,
      ],
    );
    if (rows.length > 0) {
      await transaction.query(
        `
          INSERT INTO import_rows(
            id, batch_id, row_number, raw_json, candidate_json, outcome
          )
          SELECT
            row.id, $1, row.row_number, row.raw_json, row.candidate_json,
            'preview'
          FROM jsonb_to_recordset($2::jsonb) AS row(
            id text,
            row_number integer,
            raw_json jsonb,
            candidate_json jsonb
          )
        `,
        [id, JSON.stringify(rows)],
      );
    }
    if (issues.length > 0) {
      await transaction.query(
        `
          INSERT INTO import_issues(
            id, batch_id, severity, code, message, row_number, field,
            issue_json
          )
          SELECT
            issue.id, $1, issue.severity, issue.code, issue.message,
            issue.row_number, issue.field, issue.issue_json
          FROM jsonb_to_recordset($2::jsonb) AS issue(
            id text,
            severity text,
            code text,
            message text,
            row_number integer,
            field text,
            issue_json jsonb
          )
        `,
        [id, JSON.stringify(issues)],
      );
    }
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "import.preview-created",
      entityType: "import-batch",
      entityId: id,
      after: {
        sourceName: batch.source_name,
        sourceSha256,
        template: preview.template,
        encoding: preview.encoding,
        rawRows: rows.length,
        issues: issues.length,
      },
      metadata: {
        originalBytesStored: false,
        retainedProvenance: "sha256-and-parsed-raw-rows",
      },
    });
    return importPreviewForApi(batch);
  });
}

export async function getImportPreview(
  database: DbExecutor,
  actor: ActorContext,
  batchId: string,
): Promise<StoredImportPreview | null> {
  const row = await findImportBatch(database, batchId);
  if (!row) {
    return null;
  }
  await assertProjectPermission(database, actor, row.project_id, "read");
  return importPreviewForApi(row);
}

export async function listImportBatches(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
  options: {
    status?: "preview" | "committed" | "cancelled";
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ batches: ImportBatchSummary[]; nextCursor: string | null }> {
  await assertProjectPermission(database, actor, projectId, "read");
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const result = await database.query<ImportBatchSummaryRow>(
    `
      SELECT
        b.id, b.project_id, b.source_name, b.source_sha256, b.template,
        b.status, b.version, b.created_at, b.committed_at, b.cancelled_at,
        u.id AS creator_id, u.display_name AS creator_display_name,
        u.email AS creator_email,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'error')::int AS errors,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'warning')::int
          AS warnings,
        COUNT(DISTINCT r.id) FILTER (WHERE r.outcome = 'committed')::int
          AS inserted_nodes,
        COUNT(DISTINCT r.id) FILTER (WHERE r.outcome = 'skipped')::int
          AS skipped_rows
      FROM import_batches b
      JOIN users u ON u.id = b.created_by
      LEFT JOIN import_issues i ON i.batch_id = b.id
      LEFT JOIN import_rows r ON r.batch_id = b.id
      WHERE b.project_id = $1
        AND ($2::text IS NULL OR b.status = $2)
        AND (
          $3::timestamptz IS NULL
          OR (b.created_at, b.id) < ($3::timestamptz, $4::text)
        )
      GROUP BY b.id, u.id
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $5
    `,
    [
      projectId,
      options.status ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit).map(importSummaryForApi);
  const last = page.at(-1);
  return {
    batches: page,
    nextCursor:
      hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function cancelImportPreview(
  database: DatabaseHandle,
  actor: ActorContext,
  batchId: string,
  expectedVersion: number,
): Promise<StoredImportPreview> {
  return database.transaction(async (transaction) => {
    const summary = await findImportBatch(transaction, batchId);
    if (!summary) {
      throw new Error("import-not-found");
    }
    await lockProject(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
    );
    const current = await findImportBatchForUpdate(transaction, batchId);
    if (!current) {
      throw new Error("import-not-found");
    }
    if (current.version !== expectedVersion) {
      throw new VersionConflictError("Import preview changed before cancellation");
    }
    if (current.status !== "preview") {
      throw new Error(
        current.status === "cancelled"
          ? "import-cancelled"
          : "import-already-committed",
      );
    }
    const updated = await transaction.one<ImportBatchRow>(
      `
        WITH changed AS (
          UPDATE import_batches
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $1,
              version = version + 1
          WHERE id = $2 AND status = 'preview' AND version = $3
          RETURNING *
        )
        SELECT changed.*, u.display_name AS creator_display_name,
               u.email AS creator_email
        FROM changed
        JOIN users u ON u.id = changed.created_by
      `,
      [actor.actorUserId, batchId, expectedVersion],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "import.cancelled",
      entityType: "import-batch",
      entityId: batchId,
      before: { status: current.status, version: current.version },
      after: { status: updated.status, version: updated.version },
    });
    return importPreviewForApi(updated);
  });
}

export async function commitImportPreview(
  database: DatabaseHandle,
  actor: ActorContext,
  batchId: string,
  options: {
    expectedVersion: number;
    commitValidOnly: boolean;
    idempotencyKey: string;
    allowHistorical?: boolean;
  },
): Promise<ImportCommitResult> {
  const summary = await findImportBatch(database, batchId);
  if (!summary) {
    throw new Error("import-not-found");
  }

  return database.transaction(async (transaction) => {
    await lockProject(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
      { allowHistorical: options.allowHistorical },
    );
    const stored = await findImportBatchForUpdate(transaction, batchId);
    if (!stored) {
      throw new Error("import-not-found");
    }
    if (stored.status === "cancelled") {
      throw new Error("import-cancelled");
    }
    if (stored.status === "committed") {
      return await committedImportResult(transaction, stored, true);
    }
    if (stored.version !== options.expectedVersion) {
      throw new VersionConflictError("Import preview changed before commit");
    }
    if (stored.preview_json.template === "unknown") {
      throw new Error("unsupported-import-template");
    }
    const fatalRows = new Set(
      stored.preview_json.issues
        .filter(
          ({ severity, rowNumber }) =>
            severity === "error" && rowNumber !== undefined,
        )
        .map(({ rowNumber }) => rowNumber!),
    );
    if (fatalRows.size > 0 && !options.commitValidOnly) {
      throw new Error("import-has-row-errors");
    }

    const hierarchy = await projectHierarchyRoots(
      transaction,
      stored.project_id,
    );
    const prepared = prepareImportedNodes(
      stored,
      hierarchy.vehicleId,
      hierarchy.systemIds,
      fatalRows,
    );
    const insertedIds = await insertImportedNodes(
      transaction,
      prepared.nodes,
    );
    const outcomes = prepared.outcomes.map((outcome) => ({
      ...outcome,
      outcome:
        outcome.outcome === "committed" && !insertedIds.has(outcome.node_id!)
          ? "skipped"
          : outcome.outcome,
      node_id:
        outcome.outcome === "committed" && insertedIds.has(outcome.node_id!)
          ? outcome.node_id
          : null,
    }));
    await applyImportOutcomes(transaction, batchId, outcomes);
    const committed = await transaction.one<ImportBatchRow>(
      `
        WITH changed AS (
          UPDATE import_batches
          SET status = 'committed', committed_at = now(), committed_by = $1,
              idempotency_key = $2, version = version + 1
          WHERE id = $3 AND status = 'preview' AND version = $4
          RETURNING *
        )
        SELECT changed.*, u.display_name AS creator_display_name,
               u.email AS creator_email
        FROM changed
        JOIN users u ON u.id = changed.created_by
      `,
      [
        actor.actorUserId,
        options.idempotencyKey,
        batchId,
        options.expectedVersion,
      ],
    );
    await transaction.query(
      `
        UPDATE projects
        SET version = version + 1, updated_by = $1, updated_at = now()
        WHERE id = $2
      `,
      [actor.actorUserId, stored.project_id],
    );
    const insertedNodes = outcomes.filter(
      ({ outcome }) => outcome === "committed",
    ).length;
    const skippedRows = outcomes.filter(
      ({ outcome }) => outcome === "skipped",
    ).length;
    await appendAuditEntry(transaction, actor, {
      projectId: stored.project_id,
      action: "import.committed",
      entityType: "import-batch",
      entityId: batchId,
      before: { status: "preview", version: stored.version },
      after: {
        status: "committed",
        version: committed.version,
        insertedNodes,
        skippedRows,
      },
      metadata: { idempotencyKey: options.idempotencyKey },
    });
    return {
      batchId,
      status: "committed",
      version: committed.version,
      insertedNodes,
      skippedRows,
      alreadyCommitted: false,
      committedAt: committed.committed_at!,
    };
  });
}

interface ImportBatchSummaryRow extends QueryResultRow {
  id: string;
  project_id: string;
  source_name: string;
  source_sha256: string;
  template: CsvPreview["template"];
  status: "preview" | "committed" | "cancelled";
  version: number;
  created_at: string;
  committed_at: string | null;
  cancelled_at: string | null;
  creator_id: string;
  creator_display_name: string;
  creator_email: string;
  errors: number;
  warnings: number;
  inserted_nodes: number;
  skipped_rows: number;
}

async function findImportBatch(
  database: DbExecutor,
  batchId: string,
): Promise<ImportBatchRow | null> {
  return await database.maybeOne<ImportBatchRow>(
    `
      SELECT b.*, u.display_name AS creator_display_name,
             u.email AS creator_email
      FROM import_batches b
      JOIN users u ON u.id = b.created_by
      WHERE b.id = $1
    `,
    [batchId],
  );
}

async function findImportBatchForUpdate(
  database: DbExecutor,
  batchId: string,
): Promise<ImportBatchRow | null> {
  return await database.maybeOne<ImportBatchRow>(
    `
      SELECT b.*, u.display_name AS creator_display_name,
             u.email AS creator_email
      FROM import_batches b
      JOIN users u ON u.id = b.created_by
      WHERE b.id = $1
      FOR UPDATE OF b
    `,
    [batchId],
  );
}

async function committedImportResult(
  database: DbExecutor,
  stored: ImportBatchRow,
  alreadyCommitted: boolean,
): Promise<ImportCommitResult> {
  const counts = await database.one<{
    inserted: number;
    skipped: number;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'committed')::int AS inserted,
        COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
      FROM import_rows
      WHERE batch_id = $1
    `,
    [stored.id],
  );
  if (!stored.committed_at) {
    throw new Error("import-committed-timestamp-missing");
  }
  return {
    batchId: stored.id,
    status: "committed",
    version: stored.version,
    insertedNodes: counts.inserted,
    skippedRows: counts.skipped,
    alreadyCommitted,
    committedAt: stored.committed_at,
  };
}

function prepareImportedNodes(
  stored: ImportBatchRow,
  vehicleId: string,
  systemIds: ReadonlyMap<string, string>,
  fatalRows: ReadonlySet<number>,
): {
  nodes: NodeInsert[];
  outcomes: Array<{
    row_number: number;
    outcome: "committed" | "skipped";
    node_id: string | null;
  }>;
} {
  const nodes: NodeInsert[] = [];
  const outcomes: Array<{
    row_number: number;
    outcome: "committed" | "skipped";
    node_id: string | null;
  }> = [];
  const preview = stored.preview_json;

  if (preview.template === "legacy-master") {
    const assemblies = new Map<string, string>();
    for (const record of preview.records.filter(
      ({ recordKind }) => recordKind === "assembly",
    )) {
      const rowNumber = record.provenance.rowNumber;
      const parentId = record.system
        ? systemIds.get(record.system)
        : undefined;
      if (fatalRows.has(rowNumber) || !parentId) {
        outcomes.push({ row_number: rowNumber, outcome: "skipped", node_id: null });
        continue;
      }
      const id = stableUuid(`import-node:${stored.id}:${rowNumber}`);
      nodes.push(
        legacyNode(stored, record, id, parentId, "assembly"),
      );
      if (record.sourceKey) {
        assemblies.set(record.sourceKey, id);
      }
      outcomes.push({ row_number: rowNumber, outcome: "committed", node_id: id });
    }
    for (const record of preview.records.filter(
      ({ recordKind }) => recordKind === "component",
    )) {
      const rowNumber = record.provenance.rowNumber;
      const assemblyKey =
        record.system && record.hla && record.subassembly
          ? `${record.system}.${record.hla}.${record.subassembly}.00`
          : null;
      const parentId =
        (assemblyKey ? assemblies.get(assemblyKey) : undefined) ??
        (record.system ? systemIds.get(record.system) : undefined);
      if (fatalRows.has(rowNumber) || !parentId) {
        outcomes.push({ row_number: rowNumber, outcome: "skipped", node_id: null });
        continue;
      }
      const id = stableUuid(`import-node:${stored.id}:${rowNumber}`);
      nodes.push(legacyNode(stored, record, id, parentId, "part"));
      outcomes.push({ row_number: rowNumber, outcome: "committed", node_id: id });
    }
  } else if (preview.template === "assembly-index") {
    for (const claim of preview.claims) {
      const rowNumber = claim.provenance.rowNumber;
      const parentId = systemIds.get(claim.system);
      if (fatalRows.has(rowNumber) || !parentId) {
        outcomes.push({ row_number: rowNumber, outcome: "skipped", node_id: null });
        continue;
      }
      const id = stableUuid(`import-node:${stored.id}:${rowNumber}`);
      nodes.push({
        id,
        project_id: stored.project_id,
        parent_id: parentId,
        kind: "assembly",
        system_code: claim.system,
        raw_hla: claim.hla,
        raw_subassembly: null,
        raw_part_number: null,
        reference_id: claim.hla,
        name: claim.assemblyName ?? `Unassigned ${claim.system}-${claim.hla}`,
        description: "Imported high-level assembly claim",
        revision: null,
        procurement_type: "unknown",
        quantity: "1",
        internal_note: claim.ownerName
          ? `Imported owner: ${claim.ownerName}`
          : "Imported owner not assigned",
        source_import_batch_id: stored.id,
        source_import_row: rowNumber,
        sort_order: rowNumber,
      });
      outcomes.push({ row_number: rowNumber, outcome: "committed", node_id: id });
    }
  } else {
    throw new Error("unsupported-import-template");
  }

  void vehicleId;
  return { nodes, outcomes };
}

function legacyNode(
  stored: ImportBatchRow,
  record: LegacyMasterRecord,
  id: string,
  parentId: string,
  kind: "assembly" | "part",
): NodeInsert {
  const reportName =
    kind === "assembly"
      ? (record.assemblyName ?? record.componentName ?? "Unnamed assembly")
      : (record.componentName ?? record.assemblyName ?? "Unnamed part");
  const internalNotes = [
    record.notesRaw,
    ...record.provenance.overflowCells
      .filter(({ rawValue }) => rawValue.trim() !== "")
      .map(
        ({ columnNumber, rawValue }) =>
          `Imported column ${columnNumber}: ${rawValue}`,
      ),
  ]
    .filter((note): note is string => Boolean(note))
    .join("\n");
  const referenceId = record.sixDigitCode
    ? `${record.sixDigitCode}${record.variant ? `-${record.variant}` : ""}`
    : null;
  return {
    id,
    project_id: stored.project_id,
    parent_id: parentId,
    kind,
    system_code: record.system!,
    raw_hla: record.hla,
    raw_subassembly: record.subassembly,
    raw_part_number: record.partNumber,
    reference_id: referenceId,
    name: reportName,
    description: record.description ?? "",
    revision: record.revisionRaw,
    procurement_type: record.procurementType ?? "unknown",
    quantity: String(record.quantityOnCar ?? record.quantityTotal ?? 1),
    internal_note: internalNotes,
    source_import_batch_id: stored.id,
    source_import_row: record.provenance.rowNumber,
    sort_order: record.provenance.rowNumber,
  };
}

async function insertImportedNodes(
  database: DbExecutor,
  nodes: NodeInsert[],
): Promise<Set<string>> {
  if (nodes.length === 0) {
    return new Set();
  }
  const result = await database.query<{ id: string }>(
    `
      INSERT INTO cost_nodes(
        id, project_id, parent_id, kind, system_code, raw_hla,
        raw_subassembly, raw_part_number, reference_id, full_number,
        name, description, revision, procurement_type, quantity,
        internal_note, source_import_batch_id, source_import_row,
        sort_order, version, created_at, updated_at
      )
      SELECT
        node.id, node.project_id, node.parent_id, node.kind, node.system_code,
        node.raw_hla, node.raw_subassembly, node.raw_part_number,
        node.reference_id, NULL, node.name, node.description, node.revision,
        node.procurement_type, node.quantity::numeric, node.internal_note,
        node.source_import_batch_id, node.source_import_row,
        node.sort_order, 0, now(), now()
      FROM jsonb_to_recordset($1::jsonb) AS node(
        id text,
        project_id text,
        parent_id text,
        kind text,
        system_code text,
        raw_hla text,
        raw_subassembly text,
        raw_part_number text,
        reference_id text,
        name text,
        description text,
        revision text,
        procurement_type text,
        quantity text,
        internal_note text,
        source_import_batch_id text,
        source_import_row integer,
        sort_order integer
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `,
    [JSON.stringify(nodes)],
  );
  return new Set(result.rows.map(({ id }) => id));
}

async function applyImportOutcomes(
  database: DbExecutor,
  batchId: string,
  outcomes: Array<{
    row_number: number;
    outcome: "committed" | "skipped";
    node_id: string | null;
  }>,
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }
  await database.query(
    `
      UPDATE import_rows row
      SET outcome = outcome.outcome, node_id = outcome.node_id
      FROM jsonb_to_recordset($1::jsonb) AS outcome(
        row_number integer,
        outcome text,
        node_id text
      )
      WHERE row.batch_id = $2 AND row.row_number = outcome.row_number
    `,
    [JSON.stringify(outcomes), batchId],
  );
}

async function projectHierarchyRoots(
  database: DbExecutor,
  projectId: string,
): Promise<{ vehicleId: string; systemIds: Map<string, string> }> {
  const result = await database.query<{
    id: string;
    kind: "vehicle" | "system";
    system_code: string | null;
  }>(
    `
      SELECT id, kind, system_code
      FROM cost_nodes
      WHERE project_id = $1 AND kind IN ('vehicle', 'system')
      ORDER BY sort_order, id
    `,
    [projectId],
  );
  const vehicle = result.rows.find(({ kind }) => kind === "vehicle");
  if (!vehicle) {
    throw new Error("project-vehicle-root-missing");
  }
  return {
    vehicleId: vehicle.id,
    systemIds: new Map(
      result.rows
        .filter(
          (row): row is typeof row & { system_code: string } =>
            row.kind === "system" && Boolean(row.system_code),
        )
        .map((row) => [row.system_code, row.id]),
    ),
  };
}

async function lockProject(
  database: DbExecutor,
  projectId: string,
): Promise<void> {
  const project = await database.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
}

function importPreviewForApi(row: ImportBatchRow): StoredImportPreview {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    status: row.status,
    version: row.version,
    preview: row.preview_json,
    createdAt: row.created_at,
    committedAt: row.committed_at,
    cancelledAt: row.cancelled_at,
    createdBy: {
      id: row.created_by,
      displayName: row.creator_display_name,
      email: row.creator_email,
    },
  };
}

function importSummaryForApi(row: ImportBatchSummaryRow): ImportBatchSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    template: row.template,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    committedAt: row.committed_at,
    cancelledAt: row.cancelled_at,
    createdBy: {
      id: row.creator_id,
      displayName: row.creator_display_name,
      email: row.creator_email,
    },
    errors: row.errors,
    warnings: row.warnings,
    insertedNodes: row.inserted_nodes,
    skippedRows: row.skipped_rows,
  };
}

function candidatesFromPreview(preview: CsvPreview): Map<number, unknown> {
  if (preview.template === "legacy-master") {
    return new Map(
      preview.records.map((record) => [record.provenance.rowNumber, record]),
    );
  }
  if (preview.template === "assembly-index") {
    return new Map(
      preview.claims.map((claim) => [claim.provenance.rowNumber, claim]),
    );
  }
  return new Map();
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("invalid-import-cursor");
  }
  if (
    !parsedValue ||
    typeof parsedValue !== "object" ||
    !("createdAt" in parsedValue) ||
    !("id" in parsedValue) ||
    typeof parsedValue.createdAt !== "string" ||
    typeof parsedValue.id !== "string" ||
    parsedValue.id.length === 0
  ) {
    throw new Error("invalid-import-cursor");
  }
  const parsedDate = new Date(parsedValue.createdAt);
  if (Number.isNaN(parsedDate.valueOf())) {
    throw new Error("invalid-import-cursor");
  }
  return { createdAt: parsedDate.toISOString(), id: parsedValue.id };
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
