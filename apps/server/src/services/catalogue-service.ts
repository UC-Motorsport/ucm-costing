import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  evaluateCatalogFormula,
  type CatalogFormulaInputs,
  type CostKind,
} from "@ucm/domain";
import Decimal from "decimal.js";
import type { QueryResultRow } from "pg";
import { z } from "zod";

import {
  profileCatalogue,
  type CatalogueSheetName,
  type ParsedCatalogueCell,
  type ParsedCatalogueRow,
  type ParsedCatalogueSheet,
} from "../catalog";
import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import type { ActorContext } from "../security/authorization";
import {
  findCatalogueFormulaCorrection,
  type CatalogueFormulaCorrection,
} from "./catalogue-corrections";
import { VersionConflictError } from "./project-lifecycle-service";

export const catalogueItemKinds = [
  "material",
  "process",
  "multiplier",
  "fastener",
  "tooling",
  "stock-size",
] as const;

export type CatalogueItemKind = (typeof catalogueItemKinds)[number];

interface SheetImportDefinition {
  sheet: CatalogueSheetName;
  kind: CatalogueItemKind;
  nameHeader: string;
  costHeader?: string;
  formulaHeader?: string;
  formulaColumn?: number;
}

const sheetDefinitions: SheetImportDefinition[] = [
  {
    sheet: "Materials",
    kind: "material",
    nameHeader: "material",
    costHeader: "cost",
    formulaHeader: "formula",
  },
  {
    sheet: "Processes",
    kind: "process",
    nameHeader: "process",
    costHeader: "unitcost",
  },
  {
    sheet: "Process Multipliers",
    kind: "multiplier",
    nameHeader: "multiplier",
    costHeader: "multipliervalue",
  },
  {
    sheet: "Fasteners",
    kind: "fastener",
    nameHeader: "fastener",
    costHeader: "cost",
    formulaHeader: "formula",
  },
  {
    sheet: "Tooling",
    kind: "tooling",
    nameHeader: "tool",
    costHeader: "cost",
    formulaColumn: 12,
  },
  {
    sheet: "Stock Sizes",
    kind: "stock-size",
    nameHeader: "profile",
  },
];

const formulaProbeInputs: CatalogFormulaInputs = {
  size1: 1,
  size2: 1,
  size3: 1,
  size4: 1,
  c1: 1,
  c2: 1,
  c3: 1,
  c4: 1,
  area: 1,
  length: 1,
  density: 1,
};

const optionalText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .nullable()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed || null;
    });

const coefficientSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value): string | null => {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }
    return String(value).trim();
  })
  .refine((value) => {
    if (value === null) {
      return true;
    }
    try {
      return new Decimal(value).isFinite();
    } catch {
      return false;
    }
  }, {
    message: "Coefficient must be a finite decimal",
  });

const cataloguePublicationSchema = z
  .object({
    releaseId: z.string().trim().min(1).max(100),
    kind: z.enum(catalogueItemKinds),
    name: z.string().trim().min(1).max(500),
    category: optionalText(300),
    supplier: optionalText(300),
    unit: optionalText(100),
    unit2: optionalText(100),
    costMode: z.enum(["fixed", "formula"]),
    fixedCost: z.union([z.string(), z.number()]).optional(),
    formula: z.string().max(2_000).nullable().optional(),
    coefficients: z
      .object({
        c1: coefficientSchema,
        c2: coefficientSchema,
        c3: coefficientSchema,
        c4: coefficientSchema,
      })
      .default({ c1: null, c2: null, c3: null, c4: null }),
    size1Label: optionalText(200),
    size2Label: optionalText(200),
    size3Label: optionalText(200),
    size4Label: optionalText(200),
    reason: z.string().trim().min(3).max(2_000),
    evidence: optionalText(4_000),
  })
  .superRefine((input, context) => {
    if (input.costMode === "fixed") {
      const raw = input.fixedCost === undefined ? "" : String(input.fixedCost);
      try {
        const cost = new Decimal(raw);
        if (!cost.isFinite() || cost.isNegative()) {
          throw new Error("invalid");
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["fixedCost"],
          message: "Fixed cost must be a finite decimal at least zero",
        });
      }
      return;
    }
    const formula = input.formula?.trim() ?? "";
    if (!formula) {
      context.addIssue({
        code: "custom",
        path: ["formula"],
        message: "Formula is required",
      });
      return;
    }
    const evaluation = evaluateCatalogFormula(formula, formulaProbeInputs);
    if (!evaluation.ok) {
      context.addIssue({
        code: "custom",
        path: ["formula"],
        message: evaluation.error,
      });
    }
  })
  .transform((input) => ({
    ...input,
    fixedCost:
      input.costMode === "fixed" ? new Decimal(input.fixedCost!).toString() : null,
    formula: input.costMode === "formula" ? input.formula!.trim() : null,
  }));

export interface CatalogueImportStats {
  releaseId: string;
  inserted: number;
  existing: number;
  invalidFormulaRows: number;
  byKind: Record<CatalogueItemKind, number>;
}

export interface CatalogueCostInput {
  kind: CostKind;
  catalogueItemId?: string | null;
  multiplierCatalogueItemId?: string | null;
  unitCost?: string;
  sizeInputs: Record<string, string>;
}

export interface ResolvedCatalogueMultiplier {
  value: string;
  name: string | null;
  catalogueItemId: string | null;
}

interface CatalogueCostRow extends QueryResultRow {
  id: string;
  kind: string;
  catalogue_id: string;
  raw_formula: string | null;
  source_raw_formula: string | null;
  fixed_cost: string | null;
  coefficients_json: string;
  metadata_json: string;
  effective_revision: number;
}

interface CatalogueApiRow extends QueryResultRow {
  id: string;
  kind: string;
  catalogueId: string;
  name: string;
  category: string | null;
  supplier: string | null;
  unit: string | null;
  unit2: string | null;
  rawFormula: string | null;
  sourceFormula: string | null;
  fixedCost: string | null;
  coefficientsJson: string;
  metadataJson: string;
  sourceSheet: string;
  sourceRow: number;
  origin: "official" | "team";
  revision: number;
  changeReason: string | null;
  changeEvidence: string | null;
  changeCreatedAt: string | null;
  changeCreatedById: string | null;
  changeCreatedByName: string | null;
  itemCreatedAt: string;
  itemCreatedById: string | null;
  itemCreatedByName: string | null;
}

interface CatalogueInsertRow {
  id: string;
  releaseId: string;
  kind: CatalogueItemKind;
  catalogueId: string;
  name: string;
  category: string | null;
  supplier: string | null;
  unit: string | null;
  unit2: string | null;
  rawFormula: string | null;
  fixedCost: string | null;
  coefficientsJson: string;
  metadataJson: string;
  sourceSheet: string;
  sourceRow: number;
  rawJson: string;
}

const CATALOGUE_INSERT_BATCH_SIZE = 250;

const CATALOGUE_API_SELECT = `
  effective.id,
  effective.kind,
  effective.catalogue_id AS "catalogueId",
  effective.name,
  effective.category,
  effective.supplier,
  effective.unit,
  effective.unit_2 AS "unit2",
  effective.raw_formula AS "rawFormula",
  effective.source_raw_formula AS "sourceFormula",
  effective.fixed_cost::text AS "fixedCost",
  effective.coefficients_json::text AS "coefficientsJson",
  effective.metadata_json::text AS "metadataJson",
  effective.source_sheet AS "sourceSheet",
  effective.source_row AS "sourceRow",
  effective.origin,
  effective.effective_revision AS revision,
  effective.change_reason AS "changeReason",
  effective.change_evidence AS "changeEvidence",
  effective.change_created_at AS "changeCreatedAt",
  effective.change_created_by AS "changeCreatedById",
  change_actor.display_name AS "changeCreatedByName",
  effective.item_created_at AS "itemCreatedAt",
  effective.item_created_by AS "itemCreatedById",
  item_actor.display_name AS "itemCreatedByName"
`;

export async function importCatalogueRelease(
  database: DatabaseHandle,
  releaseId: string,
  workbookPath: string,
): Promise<CatalogueImportStats> {
  const profile = profileCatalogue(await readFile(workbookPath));
  const counts = Object.fromEntries(
    sheetDefinitions.map(({ kind }) => [kind, 0]),
  ) as Record<CatalogueItemKind, number>;
  let invalidFormulaRows = 0;
  const rows: CatalogueInsertRow[] = [];

  for (const definition of sheetDefinitions) {
    const sheet = profile.sheets[definition.sheet];
    const header = findHeaderRow(sheet, definition.nameHeader);
    const headers = headerMap(header);
    const idColumn = requiredColumn(headers, "id", definition.sheet);
    const nameColumn = requiredColumn(
      headers,
      definition.nameHeader,
      definition.sheet,
    );
    const formulaColumn =
      definition.formulaColumn ??
      optionalColumn(headers, definition.formulaHeader ?? "");
    const costColumn = optionalColumn(headers, definition.costHeader ?? "");

    for (const row of sheet.rows) {
      if (row.rowNumber <= header.rowNumber) {
        continue;
      }
      const id = valueAt(row, idColumn);
      const name = valueAt(row, nameColumn);
      if (id === null || id === "" || name === null || name === "") {
        continue;
      }

      const rawFormulaValue =
        formulaColumn === null ? null : valueAt(row, formulaColumn);
      const rawFormula =
        typeof rawFormulaValue === "string" &&
        rawFormulaValue.trim() !== "" &&
        rawFormulaValue.toLowerCase() !== "[needs calc]" &&
        rawFormulaValue.toLowerCase() !== "[needs calculation]"
          ? rawFormulaValue
          : null;
      const fixedCostValue =
        costColumn === null ? null : valueAt(row, costColumn);
      const fixedCost =
        typeof fixedCostValue === "number"
          ? String(fixedCostValue)
          : isNumericText(fixedCostValue)
            ? String(fixedCostValue)
            : null;
      const formulaEvaluation = rawFormula
        ? evaluateCatalogFormula(rawFormula, formulaProbeInputs)
        : null;
      if (formulaEvaluation && !formulaEvaluation.ok) {
        invalidFormulaRows += 1;
      }

      const record = rowToRecord(row, header);
      const catalogueId = String(id);
      rows.push({
        id: stableUuid(
          `catalogue-item:${releaseId}:${definition.kind}:${catalogueId}`,
        ),
        releaseId,
        kind: definition.kind,
        catalogueId,
        name: String(name),
        category: textValue(record.category),
        supplier: textValue(record.supplier),
        unit: firstTextValue(
          record.unit,
          record.unit1,
          record.units,
          record.size1unit,
        ),
        unit2: firstTextValue(record.unit2, record.size2unit),
        rawFormula,
        fixedCost,
        coefficientsJson: JSON.stringify({
          c1: record.c1 ?? null,
          c2: record.c2 ?? null,
          c3: record.c3 ?? null,
          c4: record.c4 ?? null,
        }),
        metadataJson: JSON.stringify({
          ...record,
          formulaValidation: formulaEvaluation
            ? formulaEvaluation.ok
              ? { ok: true, normalized: formulaEvaluation.normalized }
              : { ok: false, error: formulaEvaluation.error }
            : null,
        }),
        sourceSheet: definition.sheet,
        sourceRow: row.rowNumber,
        rawJson: JSON.stringify({
          rowNumber: row.rowNumber,
          cells: row.cells,
        }),
      });
      counts[definition.kind] += 1;
    }
  }

  const inserted = await database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`ucm:catalogue-release:${releaseId}`],
    );
    let insertedRows = 0;
    for (
      let offset = 0;
      offset < rows.length;
      offset += CATALOGUE_INSERT_BATCH_SIZE
    ) {
      const batch = rows.slice(offset, offset + CATALOGUE_INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const tuples = batch.map((row, rowIndex) => {
        const start = rowIndex * 16;
        values.push(
          row.id,
          row.releaseId,
          row.kind,
          row.catalogueId,
          row.name,
          row.category,
          row.supplier,
          row.unit,
          row.unit2,
          row.rawFormula,
          row.fixedCost,
          row.coefficientsJson,
          row.metadataJson,
          row.sourceSheet,
          row.sourceRow,
          row.rawJson,
        );
        return `(
          $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
          $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8},
          $${start + 9}, $${start + 10}, $${start + 11},
          $${start + 12}::jsonb, $${start + 13}::jsonb,
          $${start + 14}, $${start + 15}, $${start + 16}::jsonb
        )`;
      });
      const result = await transaction.query<{ id: string }>(
        `
          INSERT INTO catalogue_items(
            id, release_id, kind, catalogue_id, name, category, supplier,
            unit, unit_2, raw_formula, fixed_cost, coefficients_json,
            metadata_json, source_sheet, source_row, raw_json
          )
          VALUES ${tuples.join(",")}
          ON CONFLICT (release_id, kind, catalogue_id) DO NOTHING
          RETURNING id
        `,
        values,
      );
      insertedRows += result.rowCount ?? 0;
    }
    return insertedRows;
  });

  return {
    releaseId,
    inserted,
    existing: rows.length - inserted,
    invalidFormulaRows,
    byKind: counts,
  };
}

export async function searchCatalogue(
  database: DbExecutor,
  releaseId: string,
  kind: string,
  query: string,
  limit = 30,
): Promise<Record<string, unknown>[]> {
  const normalizedQuery = `%${escapeLike(query.trim())}%`;
  const result = await database.query<CatalogueApiRow>(
    `
      SELECT ${CATALOGUE_API_SELECT}
      FROM effective_catalogue_items effective
      LEFT JOIN users change_actor
        ON change_actor.id = effective.change_created_by
      LEFT JOIN users item_actor
        ON item_actor.id = effective.item_created_by
      WHERE effective.release_id = $1 AND effective.kind = $2
        AND (
          effective.name ILIKE $3 ESCAPE '\\'
          OR effective.catalogue_id ILIKE $3 ESCAPE '\\'
        )
      ORDER BY lower(effective.name), effective.catalogue_id
      LIMIT $4
    `,
    [releaseId, kind, normalizedQuery, limit],
  );
  return result.rows.map((row) => catalogueItemForApi(releaseId, row));
}

export async function getCatalogueItem(
  database: DbExecutor,
  releaseId: string,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  const row = await database.maybeOne<CatalogueApiRow>(
    `
      SELECT ${CATALOGUE_API_SELECT}
      FROM effective_catalogue_items effective
      LEFT JOIN users change_actor
        ON change_actor.id = effective.change_created_by
      LEFT JOIN users item_actor
        ON item_actor.id = effective.item_created_by
      WHERE effective.release_id = $1 AND effective.id = $2
    `,
    [releaseId, itemId],
  );
  return row ? catalogueItemForApi(releaseId, row) : null;
}

export async function createTeamCatalogueItem(
  database: DatabaseHandle,
  actor: ActorContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  assertCatalogueWritePermission(actor);
  const input = cataloguePublicationSchema.parse(rawInput);
  const id = randomUUID();
  const catalogueId = `TEAM-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`ucm:catalogue-release:${input.releaseId}`],
    );
    const release = await transaction.maybeOne<{ id: string }>(
      "SELECT id FROM catalogue_releases WHERE id = $1",
      [input.releaseId],
    );
    if (!release) {
      throw new Error("catalogue-release-not-found");
    }
    const publication = publicationFields(input, {
      teamReason: input.reason,
      teamEvidence: input.evidence,
    });
    await transaction.query(
      `
        INSERT INTO catalogue_items(
          id, release_id, kind, catalogue_id, name, category, supplier,
          unit, unit_2, raw_formula, fixed_cost, coefficients_json,
          metadata_json, source_sheet, source_row, raw_json,
          origin, created_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::numeric, $12::jsonb,
          $13::jsonb, 'Team catalogue', 1, $14::jsonb,
          'team', $15
        )
      `,
      [
        id,
        input.releaseId,
        input.kind,
        catalogueId,
        input.name,
        input.category,
        input.supplier,
        input.unit,
        input.unit2,
        publication.formula,
        publication.fixedCost,
        publication.coefficientsJson,
        publication.metadataJson,
        JSON.stringify({
          origin: "team",
          enteredBy: actor.actorUserId,
          publication: input,
        }),
        actor.actorUserId,
      ],
    );
    const created = await requireCatalogueItem(
      transaction,
      input.releaseId,
      id,
    );
    await appendAuditEntry(transaction, actor, {
      action: "catalogue-item.team-created",
      entityType: "catalogue-item",
      entityId: id,
      after: created,
      metadata: { releaseId: input.releaseId, catalogueId },
    });
    return created;
  });
}

export async function reviseCatalogueItem(
  database: DatabaseHandle,
  actor: ActorContext,
  itemId: string,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  assertCatalogueWritePermission(actor);
  const input = cataloguePublicationSchema.parse(rawInput);
  const expectedRevision = z
    .object({ expectedRevision: z.number().int().nonnegative() })
    .parse(rawInput).expectedRevision;

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`ucm:catalogue-item:${itemId}`],
    );
    const current = await transaction.maybeOne<{
      id: string;
      release_id: string;
      kind: string;
      effective_revision: number;
      metadata_json: string;
    }>(
      `
        SELECT id, release_id, kind, effective_revision,
               metadata_json::text AS metadata_json
        FROM effective_catalogue_items
        WHERE id = $1
      `,
      [itemId],
    );
    if (!current || current.release_id !== input.releaseId) {
      throw new Error("catalogue-item-not-found");
    }
    if (current.kind !== input.kind) {
      throw new Error("catalogue-kind-mismatch");
    }
    if (current.effective_revision !== expectedRevision) {
      throw new VersionConflictError(
        `Catalogue item changed from revision ${expectedRevision} to ${current.effective_revision}`,
      );
    }

    const before = await requireCatalogueItem(
      transaction,
      input.releaseId,
      itemId,
    );
    const publication = publicationFields(
      input,
      JSON.parse(current.metadata_json) as Record<string, unknown>,
    );
    const revisionId = randomUUID();
    const nextRevision = current.effective_revision + 1;
    await transaction.query(
      `
        INSERT INTO catalogue_item_revisions(
          id, catalogue_item_id, revision, name, category, supplier,
          unit, unit_2, raw_formula, fixed_cost, coefficients_json,
          metadata_json, reason, evidence, created_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10::numeric, $11::jsonb,
          $12::jsonb, $13, $14, $15
        )
      `,
      [
        revisionId,
        itemId,
        nextRevision,
        input.name,
        input.category,
        input.supplier,
        input.unit,
        input.unit2,
        publication.formula,
        publication.fixedCost,
        publication.coefficientsJson,
        publication.metadataJson,
        input.reason,
        input.evidence,
        actor.actorUserId,
      ],
    );
    const revised = await requireCatalogueItem(
      transaction,
      input.releaseId,
      itemId,
    );
    await appendAuditEntry(transaction, actor, {
      action: "catalogue-item.revised",
      entityType: "catalogue-item",
      entityId: itemId,
      before,
      after: revised,
      metadata: {
        releaseId: input.releaseId,
        revision: nextRevision,
        origin: revised.origin,
      },
    });
    return revised;
  });
}

export async function resolveCatalogueUnitCost(
  database: DbExecutor,
  releaseId: string,
  input: CatalogueCostInput,
): Promise<string> {
  const stockSizeId = input.sizeInputs.stockSizeCatalogueItemId;
  if (stockSizeId) {
    const stock = await database.maybeOne<{ id: string }>(
      "SELECT id FROM catalogue_items WHERE id = $1 AND release_id = $2 AND kind = 'stock-size'",
      [stockSizeId, releaseId],
    );
    if (input.kind !== "material" || !stock) throw new Error("catalogue-kind-mismatch");
  }
  if (!input.catalogueItemId) {
    if (input.unitCost === undefined || input.unitCost.trim() === "") {
      throw new Error("unit-cost-required");
    }
    return input.unitCost;
  }
  const item = await database.maybeOne<CatalogueCostRow>(
    `
      SELECT
        id, kind, catalogue_id, raw_formula, source_raw_formula,
        fixed_cost::text AS fixed_cost,
        coefficients_json::text AS coefficients_json,
        metadata_json::text AS metadata_json,
        effective_revision
      FROM effective_catalogue_items
      WHERE id = $1 AND release_id = $2
    `,
    [input.catalogueItemId, releaseId],
  );
  if (!item) {
    throw new Error("catalogue-item-not-found");
  }
  if (item.kind !== input.kind) {
    throw new Error("catalogue-kind-mismatch");
  }
  if (item.fixed_cost !== null && item.fixed_cost !== "") {
    return item.fixed_cost;
  }
  const correction = item.effective_revision === 0
    ? findCatalogueFormulaCorrection({
        releaseId,
        kind: item.kind,
        catalogueId: item.catalogue_id,
        sourceFormula: item.source_raw_formula,
      })
    : null;
  const effectiveFormula = correction?.effectiveFormula ?? item.raw_formula;
  if (!effectiveFormula) {
    throw new Error("catalogue-cost-unavailable");
  }
  const metadata = JSON.parse(item.metadata_json) as {
    formulaValidation?: { ok?: boolean } | null;
  };
  if (!correction && metadata.formulaValidation?.ok === false) {
    throw new Error("catalogue-formula-invalid");
  }
  const coefficients = JSON.parse(item.coefficients_json) as Record<
    string,
    number | string | null
  >;
  const formulaInputs: Record<string, string | number> = { ...input.sizeInputs };
  for (const [key, value] of Object.entries(coefficients)) {
    if (value !== null && value !== "") {
      formulaInputs[key.toLowerCase()] = value;
    }
  }
  const evaluation = evaluateCatalogFormula(effectiveFormula, formulaInputs);
  if (!evaluation.ok) {
    if (evaluation.error.startsWith("Missing value for ")) {
      throw new Error(
        `catalogue-input-${evaluation.error.slice("Missing value for ".length)}-required`,
      );
    }
    throw new Error("catalogue-formula-evaluation-failed");
  }
  return evaluation.value;
}

export async function resolveCatalogueMultiplier(
  database: DbExecutor,
  releaseId: string,
  input: CatalogueCostInput,
): Promise<ResolvedCatalogueMultiplier> {
  if (input.kind === "tooling") {
    if (input.multiplierCatalogueItemId) {
      throw new Error("catalogue-multiplier-not-allowed-for-tooling");
    }
    return { value: "1", name: null, catalogueItemId: null };
  }
  if (!input.multiplierCatalogueItemId) {
    throw new Error("catalogue-multiplier-required");
  }
  const item = await database.maybeOne<{
    id: string;
    name: string;
    fixed_cost: string | null;
  }>(
    `
      SELECT id, name, fixed_cost::text AS fixed_cost
      FROM effective_catalogue_items
      WHERE id = $1 AND release_id = $2 AND kind = 'multiplier'
    `,
    [input.multiplierCatalogueItemId, releaseId],
  );
  if (!item) {
    throw new Error("catalogue-multiplier-not-found");
  }
  if (item.fixed_cost === null || item.fixed_cost.trim() === "") {
    throw new Error("catalogue-multiplier-unavailable");
  }
  return {
    value: item.fixed_cost,
    name: item.name,
    catalogueItemId: item.id,
  };
}

function catalogueItemForApi(
  releaseId: string,
  row: CatalogueApiRow,
): Record<string, unknown> {
  const {
    coefficientsJson,
    metadataJson,
    changeReason,
    changeEvidence,
    changeCreatedAt,
    changeCreatedById,
    changeCreatedByName,
    itemCreatedAt,
    itemCreatedById,
    itemCreatedByName,
    ...item
  } = row;
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  const correction = row.revision === 0
    ? findCatalogueFormulaCorrection({
        releaseId,
        kind: row.kind,
        catalogueId: row.catalogueId,
        sourceFormula: row.sourceFormula,
      })
    : null;
  const effectiveFormula = correction?.effectiveFormula ?? row.rawFormula;
  const effectiveFormulaEvaluation = effectiveFormula
    ? evaluateCatalogFormula(effectiveFormula, formulaProbeInputs)
    : null;
  const provenance = row.origin === "team"
    ? "team"
    : row.revision > 0 || correction
      ? "edited"
      : "official";
  const latestChange = changeReason && changeCreatedAt && changeCreatedById
    ? {
        reason: changeReason,
        evidence: changeEvidence,
        createdAt: changeCreatedAt,
        createdBy: {
          id: changeCreatedById,
          displayName: changeCreatedByName ?? "Unknown user",
        },
      }
    : row.origin === "team" && itemCreatedById
      ? {
          reason:
            typeof metadata.teamReason === "string"
              ? metadata.teamReason
              : "Team catalogue row created",
          evidence:
            typeof metadata.teamEvidence === "string"
              ? metadata.teamEvidence
              : null,
          createdAt: itemCreatedAt,
          createdBy: {
            id: itemCreatedById,
            displayName: itemCreatedByName ?? "Unknown user",
          },
        }
      : null;
  return {
    ...item,
    provenance,
    latestChange,
    sourceFormula: row.sourceFormula,
    effectiveFormula,
    formulaCorrection: correctionForApi(correction),
    effectiveFormulaValidation: effectiveFormulaEvaluation
      ? effectiveFormulaEvaluation.ok
        ? {
            ok: true,
            normalized: effectiveFormulaEvaluation.normalized,
          }
        : { ok: false, error: effectiveFormulaEvaluation.error }
      : null,
    coefficients: JSON.parse(coefficientsJson),
    metadata,
  };
}

function correctionForApi(
  correction: CatalogueFormulaCorrection | null,
): Record<string, unknown> | null {
  if (!correction) {
    return null;
  }
  return {
    id: correction.id,
    reason: correction.reason,
    evidence: correction.evidence,
    sourceFormula: correction.expectedSourceFormula,
    effectiveFormula: correction.effectiveFormula,
    inputs: correction.inputs,
  };
}

function publicationFields(
  input: z.output<typeof cataloguePublicationSchema>,
  baseMetadata: Record<string, unknown> = {},
): {
  fixedCost: string | null;
  formula: string | null;
  coefficientsJson: string;
  metadataJson: string;
} {
  const formulaEvaluation = input.formula
    ? evaluateCatalogFormula(input.formula, formulaProbeInputs)
    : null;
  return {
    fixedCost: input.fixedCost,
    formula: input.formula,
    coefficientsJson: JSON.stringify(input.coefficients),
    metadataJson: JSON.stringify({
      ...baseMetadata,
      size1: input.size1Label,
      size2: input.size2Label,
      size3: input.size3Label,
      size4: input.size4Label,
      formulaValidation: formulaEvaluation
        ? formulaEvaluation.ok
          ? { ok: true, normalized: formulaEvaluation.normalized }
          : { ok: false, error: formulaEvaluation.error }
        : null,
    }),
  };
}

async function requireCatalogueItem(
  transaction: TransactionHandle,
  releaseId: string,
  itemId: string,
): Promise<Record<string, unknown>> {
  const item = await getCatalogueItem(transaction, releaseId, itemId);
  if (!item) {
    throw new Error("catalogue-item-not-found");
  }
  return item;
}

function assertCatalogueWritePermission(actor: ActorContext): void {
  if (actor.systemRole === "viewer") {
    throw new Error("permission-denied");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function findHeaderRow(
  sheet: ParsedCatalogueSheet,
  nameHeader: string,
): ParsedCatalogueRow {
  const header = sheet.rows.find((row) => {
    const normalized = row.cells.map(({ value }) => normalizeHeader(value));
    return normalized.includes("id") && normalized.includes(nameHeader);
  });
  if (!header) {
    throw new Error(
      `Could not find ID/${nameHeader} header row in ${sheet.name}`,
    );
  }
  return header;
}

function headerMap(row: ParsedCatalogueRow): Map<string, number> {
  const result = new Map<string, number>();
  for (const cell of row.cells) {
    const normalized = normalizeHeader(cell.value);
    if (normalized && !result.has(normalized)) {
      result.set(normalized, cell.columnNumber);
    }
  }
  return result;
}

function rowToRecord(
  row: ParsedCatalogueRow,
  header: ParsedCatalogueRow,
): Record<string, unknown> {
  const namesByColumn = new Map<number, string>();
  for (const cell of header.cells) {
    const normalized = normalizeHeader(cell.value);
    if (normalized) {
      namesByColumn.set(cell.columnNumber, normalized);
    }
  }
  const result: Record<string, unknown> = {};
  for (const cell of row.cells) {
    const name = namesByColumn.get(cell.columnNumber);
    if (name) {
      result[name] = cell.value;
    }
  }
  return result;
}

function requiredColumn(
  headers: Map<string, number>,
  name: string,
  sheet: string,
): number {
  const column = headers.get(name);
  if (!column) {
    throw new Error(`Catalogue ${sheet} sheet is missing ${name} column`);
  }
  return column;
}

function optionalColumn(
  headers: Map<string, number>,
  name: string,
): number | null {
  if (!name) {
    return null;
  }
  return headers.get(name) ?? null;
}

function valueAt(
  row: ParsedCatalogueRow,
  columnNumber: number,
): ParsedCatalogueCell["value"] {
  return (
    row.cells.find((cell) => cell.columnNumber === columnNumber)?.value ?? null
  );
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-[\]]+/g, "");
}

function isNumericText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  );
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return String(value);
}

function firstTextValue(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textValue(value);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
