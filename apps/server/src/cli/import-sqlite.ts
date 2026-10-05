import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { getAppPaths } from "../config";
import {
  applyMigrations,
  closeDatabase,
  getDatabase,
  type TransactionHandle,
} from "../db/database";
import { DEMO_PROJECT_ID } from "../services/demo-seed-service";

const LEGACY_IMPORT_USER_ID = "legacy-sqlite-import-system";
const importedTables = [
  "app_metadata",
  "source_documents",
  "catalogue_releases",
  "catalogue_items",
  "projects",
  "cost_nodes",
  "cost_lines",
  "evidence",
  "import_batches",
  "import_rows",
  "import_issues",
  "report_snapshots",
  "evidence_file_cleanup",
] as const;

interface Options {
  sqlitePath: string;
  dataRoot: string;
  includeDemo: boolean;
  entryNumbers: Map<string, string>;
}

type LegacyRow = Record<string, unknown>;

const options = parseArguments(process.argv.slice(2));
if (options.includeDemo && process.env.NODE_ENV === "production") {
  throw new Error("--include-demo is forbidden when NODE_ENV=production");
}

const sqliteBytes = await readFile(options.sqlitePath);
const sqliteSha256 = createHash("sha256").update(sqliteBytes).digest("hex");
const legacy = new BetterSqlite3(options.sqlitePath, {
  fileMustExist: true,
  readonly: true,
});
legacy.pragma("foreign_keys = ON");
const quickCheck = String(legacy.pragma("quick_check", { simple: true }));
if (quickCheck !== "ok") {
  legacy.close();
  throw new Error(`Legacy SQLite quick_check failed: ${quickCheck}`);
}

const database = getDatabase();
try {
  await applyMigrations(database);
  await assertEmptyTarget(database);
  const sourceRows = rows(legacy, "source_documents");
  const releaseRows = rows(legacy, "catalogue_releases");
  const catalogueRows = rows(legacy, "catalogue_items");
  const allProjects = rows(legacy, "projects");
  const projectRows = allProjects.filter(
    (row) => options.includeDemo || row.id !== DEMO_PROJECT_ID,
  );
  const projectIds = new Set(projectRows.map((row) => String(row.id)));
  const allNodes = rows(legacy, "cost_nodes");
  const nodeRows = allNodes.filter((row) =>
    projectIds.has(String(row.project_id)),
  );
  const nodeIds = new Set(nodeRows.map((row) => String(row.id)));
  const lineRows = rows(legacy, "cost_lines").filter((row) =>
    nodeIds.has(String(row.node_id)),
  );
  const evidenceRows = rows(legacy, "evidence").filter((row) =>
    projectIds.has(String(row.project_id)),
  );
  const batchRows = rows(legacy, "import_batches").filter((row) =>
    projectIds.has(String(row.project_id)),
  );
  const batchIds = new Set(batchRows.map((row) => String(row.id)));
  const importRows = rows(legacy, "import_rows").filter((row) =>
    batchIds.has(String(row.batch_id)),
  );
  const issueRows = rows(legacy, "import_issues").filter((row) =>
    batchIds.has(String(row.batch_id)),
  );
  const reportRows = rows(legacy, "report_snapshots").filter((row) =>
    projectIds.has(String(row.project_id)),
  );
  const cleanupRows = rows(legacy, "evidence_file_cleanup").filter((row) =>
    projectIds.has(String(row.project_id)),
  );
  const metadataRows = rows(legacy, "app_metadata");

  const sourceByHash = new Map(
    sourceRows.map((row) => [String(row.sha256), String(row.id)]),
  );
  const projectEntryNumbers = resolveEntryNumbers(projectRows, options);
  for (const project of projectRows) {
    const ruleHash = String(project.rule_pack_sha256);
    if (!sourceByHash.has(ruleHash)) {
      throw new Error(
        `Project ${String(project.id)} rule_pack_sha256 has no matching source document`,
      );
    }
  }
  await verifyStoredFiles(
    sourceRows,
    evidenceRows,
    reportRows,
    options.dataRoot,
  );

  const expectedCounts = new Map<string, number>();
  await database.transaction(async (transaction) => {
    await insertLegacyImportUser(transaction);
    expectedCounts.set("users", 1);

    await insertRows(transaction, "app_metadata", [
      "key",
      "value",
      "updated_at",
    ], metadataRows.map((row) => [
      row.key,
      row.value,
      row.updated_at,
    ]));
    await transaction.query(
      `
        INSERT INTO app_metadata(key, value, updated_at)
        VALUES ($1, $2, clock_timestamp())
      `,
      [
        `legacy-sqlite-import:${sqliteSha256}`,
        JSON.stringify({
          sqliteSha256,
          sourcePath: path.basename(options.sqlitePath),
          demoIncluded: options.includeDemo,
        }),
      ],
    );
    expectedCounts.set("app_metadata", metadataRows.length + 1);

    await insertRows(
      transaction,
      "source_documents",
      [
        "id", "kind", "title", "version", "original_url", "local_path",
        "sha256", "applicability", "retrieved_at",
      ],
      sourceRows.map((row) => [
        row.id, row.kind, row.title, row.version, row.original_url,
        normalizeSourcePath(String(row.local_path)), row.sha256,
        row.applicability, row.retrieved_at,
      ]),
    );
    expectedCounts.set("source_documents", sourceRows.length);

    await insertRows(
      transaction,
      "catalogue_releases",
      [
        "id", "competition_year", "revision_code", "released_on",
        "source_document_id", "imported_at",
      ],
      releaseRows.map((row) => [
        row.id, row.competition_year, row.revision_code, row.released_on,
        row.source_document_id, row.imported_at,
      ]),
    );
    expectedCounts.set("catalogue_releases", releaseRows.length);

    await insertRows(
      transaction,
      "catalogue_items",
      [
        "id", "release_id", "kind", "catalogue_id", "name", "category",
        "supplier", "unit", "unit_2", "raw_formula", "fixed_cost",
        "coefficients_json", "metadata_json", "source_sheet", "source_row",
        "raw_json",
      ],
      catalogueRows.map((row) => [
        row.id, row.release_id, row.kind, row.catalogue_id, row.name,
        row.category, row.supplier, row.unit, row.unit_2, row.raw_formula,
        row.fixed_cost, row.coefficients_json, row.metadata_json,
        row.source_sheet, row.source_row, row.raw_json,
      ]),
      new Set(["coefficients_json", "metadata_json", "raw_json"]),
    );
    expectedCounts.set("catalogue_items", catalogueRows.length);

    await insertRows(
      transaction,
      "projects",
      [
        "id", "name", "season", "vehicle_type", "entry_number", "status",
        "rule_pack_version", "rule_pack_sha256", "rule_source_document_id",
        "catalogue_release_id", "cost_model", "project_summary",
        "numbering_convention", "bulk_method_summary", "focus_systems_json",
        "created_at", "updated_at", "version",
      ],
      projectRows.map((row) => [
        row.id, row.name, row.season, row.vehicle_type,
        projectEntryNumbers.get(String(row.id)), row.status,
        row.rule_pack_version, row.rule_pack_sha256,
        sourceByHash.get(String(row.rule_pack_sha256)),
        row.catalogue_release_id, row.cost_model, row.project_summary,
        row.numbering_convention, row.bulk_method_summary,
        row.focus_systems_json, row.created_at, row.updated_at, row.version,
      ]),
      new Set(["focus_systems_json"]),
    );
    expectedCounts.set("projects", projectRows.length);

    await insertNodeRows(transaction, nodeRows);
    expectedCounts.set("cost_nodes", nodeRows.length);
    await insertRows(
      transaction,
      "cost_lines",
      [
        "id", "node_id", "kind", "catalogue_item_id", "description",
        "use_description", "unit_cost", "quantity", "multiplier",
        "multiplier_name", "multiplier_catalogue_item_id",
        "fraction_included", "production_volume_factor", "size_inputs_json",
        "calculation_json", "subtotal", "sort_order", "version",
        "created_at", "updated_at",
      ],
      lineRows.map((row) => [
        row.id, row.node_id, row.kind, row.catalogue_item_id, row.description,
        row.use_description, row.unit_cost, row.quantity, row.multiplier,
        row.multiplier_name, row.multiplier_catalogue_item_id ?? null,
        row.fraction_included, row.production_volume_factor,
        row.size_inputs_json, row.calculation_json, row.subtotal,
        row.sort_order, row.version, row.created_at, row.updated_at,
      ]),
      new Set(["size_inputs_json", "calculation_json"]),
    );
    expectedCounts.set("cost_lines", lineRows.length);

    await insertRows(
      transaction,
      "evidence",
      [
        "id", "node_id", "project_id", "kind", "display_name",
        "content_sha256", "storage_path", "mime_type", "visibility",
        "report_caption", "created_at", "version", "updated_at",
      ],
      evidenceRows.map((row) => [
        row.id, row.node_id, row.project_id, row.kind, row.display_name,
        row.content_sha256, normalizeManagedPath(String(row.storage_path)),
        row.mime_type, row.visibility, row.report_caption, row.created_at,
        row.version ?? 0, row.updated_at || row.created_at,
      ]),
    );
    expectedCounts.set("evidence", evidenceRows.length);

    await insertRows(
      transaction,
      "import_batches",
      [
        "id", "project_id", "template", "source_name", "source_sha256",
        "source_encoding", "source_blob_path", "status", "preview_json",
        "committed_at", "cancelled_at", "created_at", "created_by",
        "committed_by", "cancelled_by", "idempotency_key", "version",
      ],
      batchRows.map((row) => [
        row.id, row.project_id, row.template, row.source_name,
        row.source_sha256, row.source_encoding, null, row.status,
        row.preview_json, row.committed_at, null, row.created_at,
        null, null, null, row.idempotency_key, 0,
      ]),
      new Set(["preview_json"]),
    );
    expectedCounts.set("import_batches", batchRows.length);
    await insertRows(
      transaction,
      "import_rows",
      [
        "id", "batch_id", "row_number", "raw_json", "candidate_json",
        "outcome", "node_id",
      ],
      importRows.map((row) => [
        row.id, row.batch_id, row.row_number, row.raw_json,
        row.candidate_json, row.outcome, row.node_id,
      ]),
      new Set(["raw_json", "candidate_json"]),
    );
    expectedCounts.set("import_rows", importRows.length);
    await insertRows(
      transaction,
      "import_issues",
      [
        "id", "batch_id", "severity", "code", "message", "row_number",
        "field", "issue_json",
      ],
      issueRows.map((row) => [
        row.id, row.batch_id, row.severity, row.code, row.message,
        row.row_number, row.field, row.issue_json,
      ]),
      new Set(["issue_json"]),
    );
    expectedCounts.set("import_issues", issueRows.length);

    await insertRows(
      transaction,
      "report_snapshots",
      [
        "id", "project_id", "mode", "status", "snapshot_json",
        "validation_json", "source_hashes_json", "pdf_path", "pdf_sha256",
        "pdf_bytes", "page_count", "created_by", "created_at", "completed_at",
        "error_message", "render_owner", "render_heartbeat_at",
      ],
      reportRows.map((row) => [
        row.id, row.project_id, row.mode, row.status, row.snapshot_json,
        row.validation_json, row.source_hashes_json,
        row.pdf_path ? normalizeManagedPath(String(row.pdf_path)) : null,
        row.pdf_sha256, row.pdf_bytes, row.page_count,
        LEGACY_IMPORT_USER_ID, row.created_at, row.completed_at,
        row.error_message, row.render_owner ?? null,
        row.render_heartbeat_at ?? null,
      ]),
      new Set(["snapshot_json", "validation_json", "source_hashes_json"]),
    );
    expectedCounts.set("report_snapshots", reportRows.length);

    await insertRows(
      transaction,
      "evidence_file_cleanup",
      [
        "storage_path", "project_id", "reason", "queued_at", "attempts",
        "last_attempt_at", "last_error", "lease_owner", "lease_expires_at",
      ],
      cleanupRows.map((row) => [
        normalizeManagedPath(String(row.storage_path)), row.project_id,
        row.reason, row.queued_at, row.attempts, row.last_attempt_at,
        row.last_error, null, null,
      ]),
    );
    expectedCounts.set("evidence_file_cleanup", cleanupRows.length);
    await verifyCounts(transaction, expectedCounts);
  });

  process.stdout.write(
    `${JSON.stringify({
      status: "imported-and-verified",
      sqliteSha256,
      demoIncluded: options.includeDemo,
      counts: Object.fromEntries(expectedCounts),
    }, null, 2)}\n`,
  );
} finally {
  legacy.close();
  await closeDatabase();
}

async function assertEmptyTarget(
  database: ReturnType<typeof getDatabase>,
): Promise<void> {
  const tables = [...importedTables, "users"];
  const result = await database.query<{ table_name: string; count: number }>(
    tables
      .map(
        (table, index) =>
          `SELECT '${table}' AS table_name,
                  COUNT(*)::integer AS count FROM ${table}`,
      )
      .join(" UNION ALL "),
  );
  const occupied = result.rows.filter((row) => row.count !== 0);
  if (occupied.length > 0) {
    throw new Error(
      `PostgreSQL target is not empty: ${occupied
        .map((row) => `${row.table_name}=${row.count}`)
        .join(", ")}`,
    );
  }
}

async function insertLegacyImportUser(
  transaction: TransactionHandle,
): Promise<void> {
  await transaction.query(
    `
      INSERT INTO users(
        id, email, display_name, role, status
      )
      VALUES (
        $1, 'legacy-import@invalid.local', 'Legacy SQLite import',
        'admin', 'disabled'
      )
    `,
    [LEGACY_IMPORT_USER_ID],
  );
}

async function insertNodeRows(
  transaction: TransactionHandle,
  allRows: LegacyRow[],
): Promise<void> {
  const remaining = new Map(allRows.map((row) => [String(row.id), row]));
  const inserted = new Set<string>();
  while (remaining.size > 0) {
    const layer = [...remaining.values()].filter(
      (row) =>
        row.parent_id === null ||
        row.parent_id === undefined ||
        inserted.has(String(row.parent_id)),
    );
    if (layer.length === 0) {
      throw new Error("Legacy cost node hierarchy contains a cycle or orphan");
    }
    await insertRows(
      transaction,
      "cost_nodes",
      [
        "id", "project_id", "parent_id", "kind", "system_code", "raw_hla",
        "raw_subassembly", "raw_part_number", "reference_id", "full_number",
        "name", "description", "revision", "procurement_type", "quantity",
        "internal_note", "source_import_batch_id", "source_import_row",
        "sort_order", "version", "created_at", "updated_at",
      ],
      layer.map((row) => [
        row.id, row.project_id, row.parent_id, row.kind, row.system_code,
        row.raw_hla, row.raw_subassembly, row.raw_part_number,
        row.reference_id, row.full_number, row.name, row.description,
        row.revision, row.procurement_type, row.quantity, row.internal_note,
        row.source_import_batch_id, row.source_import_row, row.sort_order,
        row.version, row.created_at, row.updated_at,
      ]),
    );
    for (const row of layer) {
      const id = String(row.id);
      remaining.delete(id);
      inserted.add(id);
    }
  }
}

async function insertRows(
  transaction: TransactionHandle,
  table: string,
  columns: string[],
  data: unknown[][],
  jsonColumns = new Set<string>(),
): Promise<void> {
  if (data.length === 0) {
    return;
  }
  assertIdentifier(table);
  columns.forEach(assertIdentifier);
  const batchSize = Math.max(1, Math.floor(50_000 / columns.length));
  for (let offset = 0; offset < data.length; offset += batchSize) {
    const batch = data.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      if (row.length !== columns.length) {
        throw new Error(`Legacy ${table} row has the wrong column count`);
      }
      values.push(...row.map((value) => value ?? null));
      const start = rowIndex * columns.length;
      return `(${columns
        .map((column, columnIndex) => {
          const parameter = `$${start + columnIndex + 1}`;
          return jsonColumns.has(column) ? `${parameter}::jsonb` : parameter;
        })
        .join(", ")})`;
    });
    await transaction.query(
      `INSERT INTO ${table}(${columns.join(", ")})
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

async function verifyCounts(
  transaction: TransactionHandle,
  expectedCounts: Map<string, number>,
): Promise<void> {
  for (const [table, expected] of expectedCounts) {
    assertIdentifier(table);
    const actual = await transaction.one<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM ${table}`,
    );
    if (actual.count !== expected) {
      throw new Error(
        `Legacy import count mismatch for ${table}: expected ${expected}, found ${actual.count}`,
      );
    }
  }
}

function rows(
  sqlite: BetterSqlite3.Database,
  table: string,
): LegacyRow[] {
  assertIdentifier(table);
  const exists = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return exists
    ? (sqlite.prepare(`SELECT * FROM ${table}`).all() as LegacyRow[])
    : [];
}

function resolveEntryNumbers(
  projects: LegacyRow[],
  input: Options,
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const project of projects) {
    const id = String(project.id);
    const value =
      text(project.entry_number) ??
      input.entryNumbers.get(id) ??
      (id === DEMO_PROJECT_ID && input.includeDemo ? "E13" : null);
    if (!value) {
      throw new Error(
        `Project ${id} needs --entry-number ${id}=VALUE; no entry number is inferred`,
      );
    }
    if (value.length > 64 || value.trim() !== value) {
      throw new Error(`Project ${id} has an invalid entry number`);
    }
    resolved.set(id, value);
  }
  return resolved;
}

async function verifyStoredFiles(
  sources: LegacyRow[],
  evidence: LegacyRow[],
  reports: LegacyRow[],
  dataRoot: string,
): Promise<void> {
  const paths = getAppPaths();
  for (const source of sources) {
    const storedPath = String(source.local_path);
    const filename = path.isAbsolute(storedPath)
      ? storedPath
      : path.resolve(paths.repositoryRoot, normalizeSourcePath(storedPath));
    await verifyFileHash(filename, String(source.sha256), "source document");
  }
  for (const item of evidence) {
    const filename = path.resolve(
      dataRoot,
      normalizeManagedPath(String(item.storage_path)),
    );
    await verifyFileHash(filename, String(item.content_sha256), "evidence");
  }
  for (const report of reports) {
    if (!report.pdf_path && !report.pdf_sha256) {
      continue;
    }
    if (!report.pdf_path || !report.pdf_sha256) {
      throw new Error(`Report ${String(report.id)} has incomplete file provenance`);
    }
    const filename = path.resolve(
      dataRoot,
      normalizeManagedPath(String(report.pdf_path)),
    );
    await verifyFileHash(filename, String(report.pdf_sha256), "report");
  }
}

async function verifyFileHash(
  filename: string,
  expectedHash: string,
  label: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`${label} has an invalid stored SHA-256: ${filename}`);
  }
  const metadata = await stat(filename);
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file: ${filename}`);
  }
  const actual = createHash("sha256").update(await readFile(filename)).digest("hex");
  if (actual !== expectedHash) {
    throw new Error(`${label} SHA-256 mismatch: ${filename}`);
  }
}

function normalizeSourcePath(storedPath: string): string {
  const normalized = storedPath.split(path.sep).join("/");
  const marker = "/docs/";
  const portable = normalized.includes(marker)
    ? normalized.slice(normalized.indexOf(marker) + 1)
    : normalized.replace(/^\/+/, "");
  const safe = path.posix.normalize(portable);
  if (
    safe === ".." ||
    safe.startsWith("../") ||
    !safe.startsWith("docs/")
  ) {
    throw new Error(`Unsafe legacy source path: ${storedPath}`);
  }
  return safe;
}

function normalizeManagedPath(storedPath: string): string {
  const normalized = storedPath.split(path.sep).join("/");
  for (const marker of ["/uploads/", "/reports/"]) {
    if (normalized.includes(marker)) {
      return normalizeManagedPath(
        normalized.slice(normalized.indexOf(marker) + 1),
      );
    }
  }
  const portable = path.posix.normalize(normalized);
  if (
    path.posix.isAbsolute(portable) ||
    portable === ".." ||
    portable.startsWith("../") ||
    (!portable.startsWith("uploads/") &&
      !portable.startsWith("reports/"))
  ) {
    throw new Error(`Unsafe legacy managed path: ${storedPath}`);
  }
  return portable;
}

function parseArguments(values: string[]): Options {
  let sqlitePath = "";
  let dataRoot = getAppPaths().dataRoot;
  let includeDemo = false;
  const entryNumbers = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--sqlite") {
      sqlitePath = requireValue(values, ++index, value);
    } else if (value === "--data-root") {
      dataRoot = path.resolve(requireValue(values, ++index, value));
    } else if (value === "--entry-number") {
      const mapping = requireValue(values, ++index, value);
      const separator = mapping.indexOf("=");
      if (separator <= 0 || separator === mapping.length - 1) {
        throw new Error("--entry-number requires PROJECT_ID=VALUE");
      }
      entryNumbers.set(
        mapping.slice(0, separator),
        mapping.slice(separator + 1),
      );
    } else if (value === "--include-demo") {
      includeDemo = true;
    } else {
      throw new Error(`Unknown argument: ${value ?? ""}`);
    }
  }
  if (!sqlitePath) {
    throw new Error(
      "Usage: npm run db:migrate:sqlite -- --sqlite PATH [--entry-number PROJECT_ID=VALUE] [--data-root PATH] [--include-demo]",
    );
  }
  return {
    sqlitePath: path.resolve(sqlitePath),
    dataRoot,
    includeDemo,
    entryNumbers,
  };
}

function requireValue(
  values: string[],
  index: number,
  option: string,
): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function assertIdentifier(identifier: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
}
