import { randomUUID } from "node:crypto";

import {
  calculateCostLine,
  canNodeOwnCostLines,
  type CostKind,
  type NodeKind,
} from "@ucm/domain";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  resolveCatalogueMultiplier,
  resolveCatalogueUnitCost,
} from "./catalogue-service";
import {
  fractionSchema,
  positiveDecimalStringSchema,
} from "./cost-input-schemas";
import { VersionConflictError } from "./project-lifecycle-service";
import {
  assertExpectedVersion,
  lockProjectForMutation,
  touchProject,
} from "./project-mutation-support";
import type { CostLineRow } from "./project-types";

export const TOOLING_PRODUCTION_VOLUME_FACTORS = ["120", "3000"] as const;
const toolingProductionVolumeFactors = new Set<string>(
  TOOLING_PRODUCTION_VOLUME_FACTORS,
);

const costLineInputSchema = z
  .object({
    kind: z.enum(["material", "process", "fastener", "tooling"]),
    catalogueItemId: z.string().nullable().optional(),
    description: z.string().trim().min(1).max(500),
    useDescription: z.string().max(2_000).default(""),
    unitCost: z.coerce.string().optional(),
    quantity: positiveDecimalStringSchema,
    multiplierCatalogueItemId: z.string().nullable().optional(),
    fractionIncluded: fractionSchema.optional(),
    productionVolumeFactor: positiveDecimalStringSchema.nullable().optional(),
    sizeInputs: z.record(z.string(), z.string().max(100)).default({}),
  })
  .superRefine((input, context) => {
    if (input.kind === "tooling") {
      if (input.fractionIncluded === undefined) {
        context.addIssue({
          code: "custom",
          path: ["fractionIncluded"],
          message: "Tooling fraction included must be explicit",
        });
      }
      if (!input.productionVolumeFactor) {
        context.addIssue({
          code: "custom",
          path: ["productionVolumeFactor"],
          message:
            "Tooling production-volume factor must be explicit; no 2026 default is assumed",
        });
      } else if (
        !toolingProductionVolumeFactors.has(input.productionVolumeFactor)
      ) {
        context.addIssue({
          code: "custom",
          path: ["productionVolumeFactor"],
          message:
            "Tooling production-volume factor must be 120 for composite monocoque tooling or 3000 for standard tooling",
        });
      }
    }
  })
  .transform((input) => ({
    ...input,
    fractionIncluded: input.fractionIncluded ?? "1",
    productionVolumeFactor: input.productionVolumeFactor ?? null,
  }));

const COST_LINE_RETURNING = `
  id, node_id, kind, catalogue_item_id, description, use_description,
  unit_cost::text AS unit_cost, quantity::text AS quantity,
  multiplier::text AS multiplier, multiplier_name,
  multiplier_catalogue_item_id,
  fraction_included::text AS fraction_included,
  production_volume_factor::text AS production_volume_factor,
  size_inputs_json::text AS size_inputs_json,
  calculation_json::text AS calculation_json,
  subtotal::text AS subtotal, sort_order, version, created_at, updated_at
`;

export async function createCostLine(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  rawInput: unknown,
): Promise<CostLineRow> {
  const input = costLineInputSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const nodeSummary = await nodeSummaryForCostLine(transaction, nodeId);
    await lockProjectForMutation(transaction, nodeSummary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      nodeSummary.project_id,
      "write",
    );
    const node = await transaction.maybeOne<{
      id: string;
      kind: NodeKind;
      version: number;
    }>(
      `
        SELECT id, kind, version
        FROM cost_nodes
        WHERE id = $1
        FOR UPDATE
      `,
      [nodeId],
    );
    if (!node) {
      throw new Error("node-not-found");
    }
    if (!canNodeOwnCostLines(node.kind)) {
      throw new Error("cost-line-owner-not-allowed");
    }
    const unitCost = await resolveCatalogueUnitCost(
      transaction,
      nodeSummary.catalogue_release_id,
      input,
    );
    const resolvedMultiplier = await resolveCatalogueMultiplier(
      transaction,
      nodeSummary.catalogue_release_id,
      input,
    );
    const calculation = calculateCostLine({
      kind: input.kind,
      unitCost,
      quantity: input.quantity,
      multiplier: resolvedMultiplier.value,
      fractionIncluded: input.fractionIncluded,
      productionVolumeFactor: input.productionVolumeFactor ?? undefined,
    });
    const sortOrder = await nextCostLineSortOrder(
      transaction,
      nodeId,
      input.kind,
    );
    const id = randomUUID();
    const created = await transaction.one<CostLineRow>(
      `
        INSERT INTO cost_lines(
          id, node_id, kind, catalogue_item_id, description, use_description,
          unit_cost, quantity, multiplier, multiplier_name,
          multiplier_catalogue_item_id, fraction_included,
          production_volume_factor, size_inputs_json, calculation_json,
          subtotal, sort_order, version, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric,
          $10, $11, $12::numeric, $13::numeric, $14::jsonb, $15::jsonb,
          $16::numeric, $17, 0, now(), now()
        )
        RETURNING ${COST_LINE_RETURNING}
      `,
      [
        id,
        nodeId,
        input.kind,
        input.catalogueItemId ?? null,
        input.description,
        input.useDescription,
        calculation.unitCost,
        calculation.quantity,
        calculation.multiplier,
        resolvedMultiplier.name,
        resolvedMultiplier.catalogueItemId,
        calculation.fractionIncluded,
        calculation.productionVolumeFactor,
        JSON.stringify(input.sizeInputs),
        JSON.stringify(calculation),
        calculation.subtotal,
        sortOrder,
      ],
    );
    await touchProject(transaction, nodeSummary.project_id, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId: nodeSummary.project_id,
      action: "cost-line.created",
      entityType: "cost-line",
      entityId: id,
      after: auditCostLineState(created),
      metadata: { nodeId },
    });
    return created;
  });
}

export async function updateCostLine(
  database: DatabaseHandle,
  actor: ActorContext,
  lineId: string,
  rawInput: unknown,
): Promise<CostLineRow> {
  const input = costLineInputSchema
    .and(z.object({ expectedVersion: z.number().int().nonnegative() }))
    .parse(rawInput);

  return database.transaction(async (transaction) => {
    const summary = await lineSummary(transaction, lineId);
    await lockProjectForMutation(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
    );
    const existing = await getCostLineForUpdate(transaction, lineId);
    assertExpectedVersion(existing.version, input.expectedVersion, "Cost line");
    if (!canNodeOwnCostLines(summary.node_kind)) {
      throw new Error("cost-line-owner-not-allowed");
    }
    const unitCost = await resolveCatalogueUnitCost(
      transaction,
      summary.catalogue_release_id,
      input,
    );
    const resolvedMultiplier = await resolveCatalogueMultiplier(
      transaction,
      summary.catalogue_release_id,
      input,
    );
    const calculation = calculateCostLine({
      kind: input.kind,
      unitCost,
      quantity: input.quantity,
      multiplier: resolvedMultiplier.value,
      fractionIncluded: input.fractionIncluded,
      productionVolumeFactor: input.productionVolumeFactor ?? undefined,
    });
    const sortOrder =
      input.kind === existing.kind
        ? existing.sort_order
        : await nextCostLineSortOrder(
            transaction,
            existing.node_id,
            input.kind,
          );

    const updatedResult = await transaction.query<CostLineRow>(
      `
        UPDATE cost_lines
        SET kind = $1, catalogue_item_id = $2, description = $3,
            use_description = $4, unit_cost = $5::numeric,
            quantity = $6::numeric, multiplier = $7::numeric,
            multiplier_name = $8, multiplier_catalogue_item_id = $9,
            fraction_included = $10::numeric,
            production_volume_factor = $11::numeric,
            size_inputs_json = $12::jsonb, calculation_json = $13::jsonb,
            subtotal = $14::numeric, sort_order = $15,
            version = version + 1, updated_at = now()
        WHERE id = $16 AND version = $17
        RETURNING ${COST_LINE_RETURNING}
      `,
      [
        input.kind,
        input.catalogueItemId ?? null,
        input.description,
        input.useDescription,
        calculation.unitCost,
        calculation.quantity,
        calculation.multiplier,
        resolvedMultiplier.name,
        resolvedMultiplier.catalogueItemId,
        calculation.fractionIncluded,
        calculation.productionVolumeFactor,
        JSON.stringify(input.sizeInputs),
        JSON.stringify(calculation),
        calculation.subtotal,
        sortOrder,
        lineId,
        input.expectedVersion,
      ],
    );
    if (updatedResult.rowCount !== 1) {
      throw new VersionConflictError("Cost line changed while saving");
    }
    const updated = updatedResult.rows[0]!;
    await touchProject(transaction, summary.project_id, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId: summary.project_id,
      action: "cost-line.updated",
      entityType: "cost-line",
      entityId: lineId,
      before: auditCostLineState(existing),
      after: auditCostLineState(updated),
    });
    return updated;
  });
}

export async function deleteCostLine(
  database: DatabaseHandle,
  actor: ActorContext,
  lineId: string,
  expectedVersion: number,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const summary = await lineSummary(transaction, lineId);
    await lockProjectForMutation(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
    );
    const existing = await getCostLineForUpdate(transaction, lineId);
    assertExpectedVersion(existing.version, expectedVersion, "Cost line");
    const deleted = await transaction.query(
      `
        DELETE FROM cost_lines
        WHERE id = $1 AND version = $2
        RETURNING id
      `,
      [lineId, expectedVersion],
    );
    if (deleted.rowCount !== 1) {
      throw new VersionConflictError("Cost line changed while deleting");
    }
    await touchProject(transaction, summary.project_id, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId: summary.project_id,
      action: "cost-line.deleted",
      entityType: "cost-line",
      entityId: lineId,
      before: auditCostLineState(existing),
      after: null,
    });
  });
}

const lineSelectionSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      expectedVersion: z.number().int().nonnegative(),
    }),
  )
  .min(1)
  .max(5000)
  .refine(
    (lines) => new Set(lines.map((line) => line.id)).size === lines.length,
    "Select each cost line once",
  );

export async function reorderCostLines(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  rawInput: unknown,
): Promise<void> {
  const input = z
    .object({
      kind: z.enum(["material", "process", "fastener", "tooling"]),
      lines: lineSelectionSchema,
    })
    .parse(rawInput);
  await database.transaction(async (transaction) => {
    const summary = await nodeSummaryForCostLine(transaction, nodeId);
    await lockProjectForMutation(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
    );
    const { rows } = await transaction.query<CostLineRow>(
      `SELECT ${COST_LINE_RETURNING} FROM cost_lines
       WHERE node_id = $1 AND kind = $2
       ORDER BY sort_order, lower(description), id FOR UPDATE`,
      [nodeId, input.kind],
    );
    const selected = new Map(
      input.lines.map((line) => [line.id, line.expectedVersion]),
    );
    if (
      rows.length !== selected.size ||
      rows.some((line) => !selected.has(line.id))
    ) {
      throw new Error("invalid-cost-line-order");
    }
    for (const line of rows) {
      assertExpectedVersion(line.version, selected.get(line.id)!, "Cost line");
    }
    const lineIds = input.lines.map((line) => line.id);
    if (rows.every((line, index) => line.id === lineIds[index])) return;
    await transaction.query(
      `UPDATE cost_lines line SET sort_order = (ordering.position - 1)::int,
         version = line.version + 1, updated_at = now()
       FROM unnest($1::text[]) WITH ORDINALITY AS ordering(id, position)
       WHERE line.id = ordering.id AND line.node_id = $2`,
      [lineIds, nodeId],
    );
    await touchProject(transaction, summary.project_id, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId: summary.project_id,
      action: "cost-line.reordered",
      entityType: "cost-node",
      entityId: nodeId,
      before: { kind: input.kind, lineIds: rows.map((line) => line.id) },
      after: { kind: input.kind, lineIds },
    });
  });
}

export async function deleteCostLines(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  rawInput: unknown,
): Promise<void> {
  const input = z.object({ lines: lineSelectionSchema }).parse(rawInput);
  await database.transaction(async (transaction) => {
    const summary = await nodeSummaryForCostLine(transaction, nodeId);
    await lockProjectForMutation(transaction, summary.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      summary.project_id,
      "write",
    );
    const ids = input.lines.map((line) => line.id);
    const { rows } = await transaction.query<CostLineRow>(
      `SELECT ${COST_LINE_RETURNING} FROM cost_lines
       WHERE node_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE`,
      [nodeId, ids],
    );
    if (rows.length !== ids.length)
      throw new Error("invalid-cost-line-selection");
    const versions = new Map(
      input.lines.map((line) => [line.id, line.expectedVersion]),
    );
    for (const line of rows) {
      assertExpectedVersion(line.version, versions.get(line.id)!, "Cost line");
    }
    await transaction.query(
      "DELETE FROM cost_lines WHERE node_id = $1 AND id = ANY($2::text[])",
      [nodeId, ids],
    );
    for (const line of rows) {
      await appendAuditEntry(transaction, actor, {
        projectId: summary.project_id,
        action: "cost-line.deleted",
        entityType: "cost-line",
        entityId: line.id,
        before: auditCostLineState(line),
        after: null,
        metadata: { nodeId, batchSize: rows.length },
      });
    }
    await touchProject(transaction, summary.project_id, actor.actorUserId);
  });
}

async function nodeSummaryForCostLine(
  database: DbExecutor,
  nodeId: string,
): Promise<{
  project_id: string;
  catalogue_release_id: string;
}> {
  const row = await database.maybeOne<{
    project_id: string;
    catalogue_release_id: string;
  }>(
    `
      SELECT cn.project_id, p.catalogue_release_id
      FROM cost_nodes cn
      JOIN projects p ON p.id = cn.project_id
      WHERE cn.id = $1
    `,
    [nodeId],
  );
  if (!row) {
    throw new Error("node-not-found");
  }
  return row;
}

async function lineSummary(
  database: DbExecutor,
  lineId: string,
): Promise<{
  project_id: string;
  node_kind: NodeKind;
  catalogue_release_id: string;
}> {
  const row = await database.maybeOne<{
    project_id: string;
    node_kind: NodeKind;
    catalogue_release_id: string;
  }>(
    `
      SELECT cn.project_id, cn.kind AS node_kind, p.catalogue_release_id
      FROM cost_lines cl
      JOIN cost_nodes cn ON cn.id = cl.node_id
      JOIN projects p ON p.id = cn.project_id
      WHERE cl.id = $1
    `,
    [lineId],
  );
  if (!row) {
    throw new Error("cost-line-not-found");
  }
  return row;
}

async function getCostLineForUpdate(
  transaction: TransactionHandle,
  lineId: string,
): Promise<CostLineRow> {
  const row = await transaction.maybeOne<CostLineRow>(
    `
      SELECT ${COST_LINE_RETURNING}
      FROM cost_lines
      WHERE id = $1
      FOR UPDATE
    `,
    [lineId],
  );
  if (!row) {
    throw new Error("cost-line-not-found");
  }
  return row;
}

async function nextCostLineSortOrder(
  database: DbExecutor,
  nodeId: string,
  kind: CostKind,
): Promise<number> {
  const row = await database.one<{ next: number }>(
    `
      SELECT (COALESCE(MAX(sort_order), -1) + 1)::int AS next
      FROM cost_lines
      WHERE node_id = $1 AND kind = $2
    `,
    [nodeId, kind],
  );
  return row.next;
}

function auditCostLineState(line: CostLineRow): Record<string, unknown> {
  return {
    id: line.id,
    nodeId: line.node_id,
    kind: line.kind,
    catalogueItemId: line.catalogue_item_id,
    description: line.description,
    useDescription: line.use_description,
    unitCost: line.unit_cost,
    quantity: line.quantity,
    multiplier: line.multiplier,
    multiplierName: line.multiplier_name,
    multiplierCatalogueItemId: line.multiplier_catalogue_item_id,
    fractionIncluded: line.fraction_included,
    productionVolumeFactor: line.production_volume_factor,
    sizeInputs: JSON.parse(line.size_inputs_json) as unknown,
    subtotal: line.subtotal,
    sortOrder: line.sort_order,
    version: line.version,
  };
}
