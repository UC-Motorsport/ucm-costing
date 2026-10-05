import { createHash } from "node:crypto";

import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type { DatabaseHandle } from "../db/database";
import { detectAndPreviewCsv, type CsvPreview } from "../import";
import type { ActorContext } from "../security/authorization";
import {
  commitImportPreview,
  createImportPreview,
  getImportPreview,
  type ImportCommitResult,
} from "./import-service";
import {
  getProjectRow,
  type ProjectRow,
} from "./project-lifecycle-service";
import { createSeasonWorkspaceRecord } from "./workspace-service";

const historicalProjectInputSchema = z.object({
  season: z.number().int().min(2020).max(2100),
  name: z.string().trim().min(2).max(120),
  entryNumber: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
  vehicleType: z.enum(["electric", "combustion", "dual"]),
});

const historicalCommitInputSchema = historicalProjectInputSchema.extend({
  expectedSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().min(8).max(200),
  commitValidOnly: z.boolean().default(true),
});

export interface HistoricalProjectPreview {
  sourceName: string;
  sourceSha256: string;
  season: number;
  name: string;
  entryNumber: string;
  vehicleType: "electric" | "combustion" | "dual";
  template: CsvPreview["template"];
  candidates: number;
  fatalRows: number;
  errors: number;
  warnings: number;
  limitations: string[];
  preview: CsvPreview;
}

export interface HistoricalProjectCommitResult {
  project: ProjectRow;
  import: ImportCommitResult;
  alreadyImported: boolean;
}

export async function previewHistoricalProject(
  database: DatabaseHandle,
  sourceName: string,
  buffer: Buffer,
  rawInput: unknown,
): Promise<HistoricalProjectPreview> {
  const input = historicalProjectInputSchema.parse(rawInput);
  await assertHistoricalSeasonAvailable(database, input.season);
  const preview = detectAndPreviewCsv(buffer, { sourceName });
  if (preview.template !== "legacy-master") {
    throw new Error("historical-import-requires-legacy-master");
  }
  return historicalPreviewForApi(sourceName, buffer, input, preview);
}

export async function commitHistoricalProject(
  database: DatabaseHandle,
  actor: ActorContext,
  sourceName: string,
  buffer: Buffer,
  rawInput: unknown,
): Promise<HistoricalProjectCommitResult> {
  const input = historicalCommitInputSchema.parse(rawInput);
  const sourceSha256 = createHash("sha256").update(buffer).digest("hex");
  if (sourceSha256 !== input.expectedSourceSha256) {
    throw new Error("historical-import-source-changed");
  }
  const parsed = detectAndPreviewCsv(buffer, { sourceName });
  if (parsed.template !== "legacy-master") {
    throw new Error("historical-import-requires-legacy-master");
  }

  let project = await projectForSeason(database, input.season);
  if (project && !project.is_historical) {
    throw new Error("project-season-already-exists");
  }
  if (!project) {
    const projectId = await database.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtext('ucm:project-seasons'))",
      );
      const duplicate = await transaction.maybeOne<{ id: string }>(
        `
          SELECT id
          FROM projects
          WHERE season = $1 AND archived_at IS NULL
          FOR UPDATE
        `,
        [input.season],
      );
      if (duplicate) {
        return duplicate.id;
      }
      return await createSeasonWorkspaceRecord(transaction, {
        name: input.name,
        season: input.season,
        vehicleType: input.vehicleType,
        entryNumber: input.entryNumber,
        isHistorical: true,
        createdBy: actor.actorUserId,
        projectSummary:
          `Historical UC Motorsport ${input.season} costing reference imported from the team master-parts index. ` +
          "Cost calculations and evidence require separate source files.",
        numberingConvention:
          `Historical ${input.season} identifiers are retained as source provenance; copied records receive target-season identifiers.`,
        bulkMethodSummary:
          "Historical reference only. Bulk costing methods were not present in the imported master-parts index.",
      });
    });
    project = await getProjectRow(database, projectId);
    if (!project.is_historical) {
      throw new Error("project-season-already-exists");
    }
  }

  const existingBatch = await database.maybeOne<{
    id: string;
    status: "preview" | "committed" | "cancelled";
  }>(
    `
      SELECT id, status
      FROM import_batches
      WHERE project_id = $1 AND source_sha256 = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [project.id, sourceSha256],
  );
  let storedPreview =
    existingBatch && existingBatch.status !== "cancelled"
      ? await getImportPreview(database, actor, existingBatch.id)
      : null;
  if (!storedPreview) {
    storedPreview = await createImportPreview(
      database,
      actor,
      project.id,
      sourceName,
      buffer,
      { allowHistorical: true },
    );
  }
  const alreadyImported = storedPreview.status === "committed";
  const committed = await commitImportPreview(
    database,
    actor,
    storedPreview.id,
    {
      expectedVersion: storedPreview.version,
      commitValidOnly: input.commitValidOnly,
      idempotencyKey: input.idempotencyKey,
      allowHistorical: true,
    },
  );
  if (!alreadyImported) {
    await database.transaction(async (transaction) => {
      await appendAuditEntry(transaction, actor, {
        projectId: project!.id,
        action: "historical-project.imported",
        entityType: "project",
        entityId: project!.id,
        after: {
          season: input.season,
          sourceName,
          sourceSha256,
          insertedNodes: committed.insertedNodes,
          skippedRows: committed.skippedRows,
          historical: true,
        },
        metadata: {
          idempotencyKey: input.idempotencyKey,
          limitations: [
            "source-does-not-contain-cost-lines",
            "source-does-not-contain-evidence-bytes",
          ],
        },
      });
    });
  }
  return {
    project: await getProjectRow(database, project.id),
    import: committed,
    alreadyImported,
  };
}

function historicalPreviewForApi(
  sourceName: string,
  buffer: Buffer,
  input: z.infer<typeof historicalProjectInputSchema>,
  preview: CsvPreview,
): HistoricalProjectPreview {
  const fatalRows = new Set(
    preview.issues
      .filter(
        (issue) => issue.severity === "error" && issue.rowNumber !== undefined,
      )
      .map((issue) => issue.rowNumber!),
  );
  const candidates =
    preview.template === "legacy-master"
      ? preview.records.length
      : preview.template === "assembly-index"
        ? preview.claims.length
        : 0;
  return {
    sourceName,
    sourceSha256: createHash("sha256").update(buffer).digest("hex"),
    season: input.season,
    name: input.name,
    entryNumber: input.entryNumber,
    vehicleType: input.vehicleType,
    template: preview.template,
    candidates,
    fatalRows: fatalRows.size,
    errors: preview.issues.filter((issue) => issue.severity === "error").length,
    warnings: preview.issues.filter((issue) => issue.severity === "warning")
      .length,
    limitations: [
      "The master-parts CSV contains hierarchy and workflow fields, not material, process, fastener, or tooling costs.",
      "Drawing, isometric image, datasheet, and other evidence bytes are not embedded in the CSV.",
    ],
    preview,
  };
}

async function assertHistoricalSeasonAvailable(
  database: DatabaseHandle,
  season: number,
): Promise<void> {
  const state = await database.one<{
    duplicate: boolean;
    current_season: number | null;
  }>(
    `
      SELECT
        EXISTS (
          SELECT 1 FROM projects
          WHERE season = $1 AND archived_at IS NULL
        ) AS duplicate,
        MAX(season) FILTER (
          WHERE archived_at IS NULL AND is_historical = false
        )::int AS current_season
      FROM projects
    `,
    [season],
  );
  if (state.duplicate) {
    throw new Error("project-season-already-exists");
  }
  if (state.current_season !== null && season >= state.current_season) {
    throw new Error("historical-season-must-precede-current");
  }
}

async function projectForSeason(
  database: DatabaseHandle,
  season: number,
): Promise<ProjectRow | null> {
  const row = await database.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM projects
      WHERE season = $1 AND archived_at IS NULL
      LIMIT 1
    `,
    [season],
  );
  return row ? await getProjectRow(database, row.id) : null;
}
