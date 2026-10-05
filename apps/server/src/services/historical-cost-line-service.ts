import { randomUUID } from "node:crypto";

import {
  calculateCostLine,
  canNodeOwnCostLines,
  type CostKind,
  type NodeKind,
} from "@ucm/domain";
import type { QueryResultRow } from "pg";

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
  lockProjectForMutation,
  touchProject,
} from "./project-mutation-support";
import type { CostLineRow } from "./project-types";

const SOURCE_SEASON = 2025;
const MAX_BATCH_ROWS = 1000;
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

interface SearchContextRow extends QueryResultRow {
  project_id: string;
  project_season: number;
  node_id: string;
  node_name: string;
  node_kind: NodeKind;
  node_system_code: string | null;
  node_full_number: string | null;
}

interface HistoricalProjectRow extends QueryResultRow {
  id: string;
  name: string;
  season: number;
}

interface HistoricalCostLineRow extends QueryResultRow {
  id: string;
  node_id: string;
  source_node_id: string;
  kind: CostKind;
  catalogue_item_id: string | null;
  catalogue_unit: string | null;
  catalogue_unit_2: string | null;
  description: string;
  use_description: string;
  unit_cost: string;
  quantity: string;
  multiplier: string;
  multiplier_name: string | null;
  multiplier_catalogue_item_id: string | null;
  fraction_included: string;
  production_volume_factor: string | null;
  size_inputs_json: string;
  calculation_json: string;
  subtotal: string;
  sort_order: number;
  version: number;
  source_node_name: string;
  source_node_number: string | null;
  source_node_kind: NodeKind;
  source_project_id: string;
  source_project_name: string;
  source_season: number;
  source_is_historical: boolean;
}

export interface HistoricalCostLineSearchItem {
  id: string;
  sourceNodeId: string;
  sourceNodeName: string;
  sourceNodeNumber: string | null;
  sourceNodeKind: NodeKind;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceSeason: number;
  kind: CostKind;
  catalogueItemId: string | null;
  unit: string | null;
  unit2: string | null;
  description: string;
  useDescription: string;
  unitCost: string;
  sizeInputs: Record<string, string>;
  quantity: string;
  multiplier: string;
  multiplierName: string | null;
  fractionIncluded: string;
  productionVolumeFactor: string | null;
  subtotal: string;
}

export interface HistoricalCostLineSearchResult {
  sourceProject: HistoricalProjectRow | null;
  matchReason: "controlled-number" | "name-type-system" | null;
  suggested: HistoricalCostLineSearchItem[];
  items: HistoricalCostLineSearchItem[];
}

export interface HistoricalCostLineImportResult {
  line: CostLineRow;
  source: {
    lineId: string;
    nodeId: string;
    nodeName: string;
    nodeNumber: string | null;
    projectId: string;
    projectName: string;
    season: number;
  };
  warnings: string[];
}

export interface HistoricalCostSource extends QueryResultRow {
  id: string;
  name: string;
  fullNumber: string | null;
  kind: NodeKind;
  rowCount: number;
}

async function historicalProjectForTarget(
  database: DbExecutor,
  actor: ActorContext,
  targetNodeId: string,
): Promise<HistoricalProjectRow | null> {
  const target = await readSearchContext(database, targetNodeId);
  await assertProjectPermission(database, actor, target.project_id, "read");
  const project = await database.maybeOne<HistoricalProjectRow>(
    `SELECT id, name, season FROM projects
     WHERE season = $1 AND is_historical = true AND archived_at IS NULL
     ORDER BY updated_at DESC, id LIMIT 1`,
    [SOURCE_SEASON],
  );
  if (project)
    await assertProjectPermission(database, actor, project.id, "read");
  return project;
}

export async function searchHistoricalCostSources(
  database: DatabaseHandle,
  actor: ActorContext,
  targetNodeId: string,
  query: string,
) {
  const sourceProject = await historicalProjectForTarget(
    database,
    actor,
    targetNodeId,
  );
  if (!sourceProject) return { sourceProject: null, items: [], hasMore: false };
  const result = await database.query<HistoricalCostSource>(
    `WITH RECURSIVE ancestry AS (
       SELECT id AS source_id, id AS descendant_id, parent_id
       FROM cost_nodes WHERE project_id = $1
       UNION ALL
       SELECT parent.id, ancestry.descendant_id, parent.parent_id
       FROM ancestry JOIN cost_nodes parent ON parent.id = ancestry.parent_id
       WHERE parent.project_id = $1
     )
     SELECT cn.id, cn.name, cn.full_number AS "fullNumber", cn.kind,
            count(cl.id)::int AS "rowCount"
     FROM cost_nodes cn
     JOIN ancestry ON ancestry.source_id = cn.id
     JOIN cost_lines cl ON cl.node_id = ancestry.descendant_id
     WHERE cn.project_id = $1 AND cn.kind IN ('part', 'assembly', 'subassembly')
       AND NOT EXISTS (
         SELECT 1 FROM unnest(regexp_split_to_array(lower(trim($2)), '[[:space:]]+')) term
         WHERE concat_ws(' ', cn.name, cn.full_number, cn.reference_id) NOT ILIKE '%' || term || '%'
       )
     GROUP BY cn.id ORDER BY lower(cn.name), cn.full_number, cn.id LIMIT 51`,
    [sourceProject.id, query],
  );
  return {
    sourceProject,
    items: result.rows.slice(0, 50),
    hasMore: result.rows.length > 50,
  };
}

async function historicalSourceNodeIds(
  database: DbExecutor,
  actor: ActorContext,
  targetNodeId: string,
  sourceNodeId: string,
): Promise<string[]> {
  const project = await historicalProjectForTarget(
    database,
    actor,
    targetNodeId,
  );
  const result = await database.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM cost_nodes WHERE id = $1 AND project_id = $2
         AND kind IN ('part', 'assembly', 'subassembly')
       UNION ALL
       SELECT child.id FROM cost_nodes child JOIN subtree ON child.parent_id = subtree.id
       WHERE child.project_id = $2
     ) SELECT id FROM subtree`,
    [sourceNodeId, project?.id ?? null],
  );
  if (result.rows.length === 0)
    throw new Error("historical-cost-line-source-not-allowed");
  return result.rows.map((row) => row.id);
}

export async function listHistoricalSourceCosts(
  database: DatabaseHandle,
  actor: ActorContext,
  targetNodeId: string,
  sourceNodeId: string,
) {
  const ids = await historicalSourceNodeIds(
    database,
    actor,
    targetNodeId,
    sourceNodeId,
  );
  const context = await readSearchContext(database, sourceNodeId);
  const rows = await readHistoricalRows(database, context.project_id, {
    nodeId: null,
    nodeIds: ids,
    query: null,
    limit: null,
  });
  return { items: rows.map(toSearchItem) };
}

export async function importHistoricalCostLines(
  database: DatabaseHandle,
  actor: ActorContext,
  targetNodeId: string,
  sourceNodeId: string,
  sourceLineIds: string[],
) {
  if (
    sourceLineIds.length === 0 ||
    sourceLineIds.length > MAX_BATCH_ROWS ||
    new Set(sourceLineIds).size !== sourceLineIds.length
  ) {
    throw new Error("historical-cost-selection-invalid");
  }
  return database.transaction(async (transaction) => {
    const target = await readImportTarget(transaction, targetNodeId);
    await lockProjectForMutation(transaction, target.project_id);
    await assertProjectPermission(
      transaction,
      actor,
      target.project_id,
      "write",
    );
    const ids = await historicalSourceNodeIds(
      transaction,
      actor,
      targetNodeId,
      sourceNodeId,
    );
    const selected = await transaction.query<{ id: string }>(
      `SELECT cl.id FROM cost_lines cl JOIN cost_nodes cn ON cn.id = cl.node_id
       WHERE cl.id = ANY($1::text[]) AND cl.node_id = ANY($2::text[])
       ORDER BY cn.name, cn.full_number NULLS LAST, cl.kind, cl.sort_order, cl.id
       FOR SHARE OF cl`,
      [sourceLineIds, ids],
    );
    if (selected.rows.length !== sourceLineIds.length) {
      throw new Error("historical-cost-selection-invalid");
    }
    const results: HistoricalCostLineImportResult[] = [];
    for (const row of selected.rows) {
      results.push(
        await importHistoricalCostLineInTransaction(
          transaction,
          actor,
          targetNodeId,
          row.id,
        ),
      );
    }
    return {
      results,
      warnings: [...new Set(results.flatMap((result) => result.warnings))],
    };
  });
}

export async function searchHistoricalCostLines(
  database: DatabaseHandle,
  actor: ActorContext,
  targetNodeId: string,
  rawQuery: string,
  limit: number,
): Promise<HistoricalCostLineSearchResult> {
  const target = await readSearchContext(database, targetNodeId);
  await assertProjectPermission(database, actor, target.project_id, "read");

  const sourceProject = await database.maybeOne<HistoricalProjectRow>(
    `
      SELECT id, name, season
      FROM projects
      WHERE season = $1 AND is_historical = true AND archived_at IS NULL
      ORDER BY updated_at DESC, id
      LIMIT 1
    `,
    [SOURCE_SEASON],
  );
  if (!sourceProject) {
    return {
      sourceProject: null,
      matchReason: null,
      suggested: [],
      items: [],
    };
  }
  await assertProjectPermission(database, actor, sourceProject.id, "read");

  const expectedSourceNumber = remapSeasonNumber(
    target.node_full_number,
    sourceProject.season,
  );
  const exactNode = await database.maybeOne<{
    id: string;
    match_reason: "controlled-number" | "name-type-system";
  }>(
    `
      SELECT id,
             CASE
               WHEN $2::text IS NOT NULL AND lower(full_number) = lower($2)
                 THEN 'controlled-number'
               ELSE 'name-type-system'
             END AS match_reason
      FROM cost_nodes
      WHERE project_id = $1
        AND (
          ($2::text IS NOT NULL AND lower(full_number) = lower($2))
          OR (
            lower(name) = lower($3)
            AND kind = $4
            AND system_code IS NOT DISTINCT FROM $5::text
          )
        )
      ORDER BY
        CASE
          WHEN $2::text IS NOT NULL AND lower(full_number) = lower($2) THEN 0
          ELSE 1
        END,
        id
      LIMIT 1
    `,
    [
      sourceProject.id,
      expectedSourceNumber,
      target.node_name,
      target.node_kind,
      target.node_system_code,
    ],
  );

  const suggested = exactNode
    ? await readHistoricalRows(database, sourceProject.id, {
        nodeId: exactNode.id,
        query: null,
        limit,
      })
    : [];
  const query = rawQuery.trim();
  const items = query
    ? await readHistoricalRows(database, sourceProject.id, {
        nodeId: null,
        query,
        limit,
      })
    : [];

  return {
    sourceProject,
    matchReason: exactNode?.match_reason ?? null,
    suggested: suggested.map(toSearchItem),
    items: items.map(toSearchItem),
  };
}

export async function importHistoricalCostLine(
  database: DatabaseHandle,
  actor: ActorContext,
  targetNodeId: string,
  sourceLineId: string,
): Promise<HistoricalCostLineImportResult> {
  return database.transaction((transaction) =>
    importHistoricalCostLineInTransaction(
      transaction,
      actor,
      targetNodeId,
      sourceLineId,
    ),
  );
}

async function importHistoricalCostLineInTransaction(
  transaction: TransactionHandle,
  actor: ActorContext,
  targetNodeId: string,
  sourceLineId: string,
): Promise<HistoricalCostLineImportResult> {
  const target = await readImportTarget(transaction, targetNodeId);
  await lockProjectForMutation(transaction, target.project_id);
  await assertProjectPermission(transaction, actor, target.project_id, "write");
  const lockedTarget = await transaction.maybeOne<{ kind: NodeKind }>(
    "SELECT kind FROM cost_nodes WHERE id = $1 FOR UPDATE",
    [targetNodeId],
  );
  if (!lockedTarget) throw new Error("node-not-found");
  if (!canNodeOwnCostLines(lockedTarget.kind)) {
    throw new Error("cost-line-owner-not-allowed");
  }

  const source = await readHistoricalLine(transaction, sourceLineId, true);
  if (!source.source_is_historical || source.source_season !== SOURCE_SEASON) {
    throw new Error("historical-cost-line-source-not-allowed");
  }
  await assertProjectPermission(
    transaction,
    actor,
    source.source_project_id,
    "read",
  );

  const availableIds = await catalogueIdsInRelease(
    transaction,
    target.catalogue_release_id,
    [source.catalogue_item_id, source.multiplier_catalogue_item_id].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const catalogueItemId =
    source.catalogue_item_id && availableIds.has(source.catalogue_item_id)
      ? source.catalogue_item_id
      : null;
  const multiplierCatalogueItemId =
    source.multiplier_catalogue_item_id &&
    availableIds.has(source.multiplier_catalogue_item_id)
      ? source.multiplier_catalogue_item_id
      : null;
  const warnings = importWarnings(
    source,
    catalogueItemId,
    multiplierCatalogueItemId,
  );
  const calculation = calculateCostLine({
    kind: source.kind,
    unitCost: source.unit_cost,
    quantity: source.quantity,
    multiplier: source.multiplier,
    fractionIncluded: source.fraction_included,
    productionVolumeFactor: source.production_volume_factor ?? undefined,
  });
  const sortOrder = await nextSortOrder(transaction, targetNodeId, source.kind);
  const id = randomUUID();
  const line = await transaction.one<CostLineRow>(
    `
      INSERT INTO cost_lines(
        id, node_id, kind, catalogue_item_id, description, use_description,
        unit_cost, quantity, multiplier, multiplier_name,
        multiplier_catalogue_item_id, fraction_included,
        production_volume_factor, size_inputs_json, calculation_json,
        subtotal, sort_order, version, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::numeric, $8::numeric, $9::numeric, $10,
        $11, $12::numeric, $13::numeric, $14::jsonb, $15::jsonb,
        $16::numeric, $17, 0, now(), now()
      )
      RETURNING ${COST_LINE_RETURNING}
    `,
    [
      id,
      targetNodeId,
      source.kind,
      catalogueItemId,
      source.description,
      source.use_description,
      calculation.unitCost,
      calculation.quantity,
      calculation.multiplier,
      source.multiplier_name,
      multiplierCatalogueItemId,
      calculation.fractionIncluded,
      calculation.productionVolumeFactor,
      source.size_inputs_json,
      JSON.stringify(calculation),
      calculation.subtotal,
      sortOrder,
    ],
  );
  await touchProject(transaction, target.project_id, actor.actorUserId);
  await appendAuditEntry(transaction, actor, {
    projectId: target.project_id,
    action: "cost-line.imported",
    entityType: "cost-line",
    entityId: id,
    after: auditState(line),
    metadata: {
      nodeId: targetNodeId,
      sourceLineId: source.id,
      sourceNodeId: source.source_node_id,
      sourceProjectId: source.source_project_id,
      sourceSeason: source.source_season,
      warnings,
    },
  });

  return {
    line,
    source: {
      lineId: source.id,
      nodeId: source.source_node_id,
      nodeName: source.source_node_name,
      nodeNumber: source.source_node_number,
      projectId: source.source_project_id,
      projectName: source.source_project_name,
      season: source.source_season,
    },
    warnings,
  };
}

async function readSearchContext(
  database: DbExecutor,
  targetNodeId: string,
): Promise<SearchContextRow> {
  const row = await database.maybeOne<SearchContextRow>(
    `
      SELECT p.id AS project_id, p.season AS project_season,
             cn.id AS node_id, cn.name AS node_name, cn.kind AS node_kind,
             cn.system_code AS node_system_code,
             cn.full_number AS node_full_number
      FROM cost_nodes cn
      JOIN projects p ON p.id = cn.project_id
      WHERE cn.id = $1
    `,
    [targetNodeId],
  );
  if (!row) throw new Error("node-not-found");
  return row;
}

async function readImportTarget(
  transaction: TransactionHandle,
  targetNodeId: string,
): Promise<{
  project_id: string;
  catalogue_release_id: string;
  node_kind: NodeKind;
}> {
  const row = await transaction.maybeOne<{
    project_id: string;
    catalogue_release_id: string;
    node_kind: NodeKind;
  }>(
    `
      SELECT p.id AS project_id, p.catalogue_release_id,
             cn.kind AS node_kind
      FROM cost_nodes cn
      JOIN projects p ON p.id = cn.project_id
      WHERE cn.id = $1
    `,
    [targetNodeId],
  );
  if (!row) throw new Error("node-not-found");
  return row;
}

async function readHistoricalRows(
  database: DbExecutor,
  sourceProjectId: string,
  options: {
    nodeId: string | null;
    nodeIds?: string[];
    query: string | null;
    limit: number | null;
  },
): Promise<HistoricalCostLineRow[]> {
  const result = await database.query<HistoricalCostLineRow>(
    `
      SELECT cl.id, cl.node_id, cl.kind, cl.catalogue_item_id,
             ci.unit AS catalogue_unit, ci.unit_2 AS catalogue_unit_2,
             cl.description, cl.use_description,
             cl.unit_cost::text AS unit_cost,
             cl.quantity::text AS quantity,
             cl.multiplier::text AS multiplier, cl.multiplier_name,
             cl.multiplier_catalogue_item_id,
             cl.fraction_included::text AS fraction_included,
             cl.production_volume_factor::text AS production_volume_factor,
             cl.size_inputs_json::text AS size_inputs_json,
             cl.calculation_json::text AS calculation_json,
             cl.subtotal::text AS subtotal, cl.sort_order, cl.version,
             cn.id AS source_node_id, cn.name AS source_node_name,
             cn.full_number AS source_node_number,
             cn.kind AS source_node_kind,
             p.id AS source_project_id, p.name AS source_project_name,
             p.season AS source_season,
             p.is_historical AS source_is_historical
      FROM cost_lines cl
      JOIN cost_nodes cn ON cn.id = cl.node_id
      JOIN projects p ON p.id = cn.project_id
      LEFT JOIN catalogue_items ci ON ci.id = cl.catalogue_item_id
      WHERE p.id = $1
        AND ($2::text IS NULL OR cn.id = $2)
        AND ($5::text[] IS NULL OR cn.id = ANY($5::text[]))
        AND (
          $3::text IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM unnest(
              regexp_split_to_array(lower(trim($3)), '[[:space:]]+')
            ) AS search_term
            WHERE concat_ws(
              ' ', cn.name, cn.full_number, cn.reference_id,
              cl.description, cl.use_description
            ) NOT ILIKE '%' || search_term || '%'
          )
        )
      ORDER BY cn.name, cn.full_number NULLS LAST, cl.kind, cl.sort_order, cl.id
      LIMIT $4
    `,
    [
      sourceProjectId,
      options.nodeId,
      options.query,
      options.limit,
      options.nodeIds ?? null,
    ],
  );
  return result.rows;
}

async function readHistoricalLine(
  database: DbExecutor,
  sourceLineId: string,
  forShare: boolean,
): Promise<HistoricalCostLineRow> {
  const row = await database.maybeOne<HistoricalCostLineRow>(
    `
      SELECT cl.id, cl.node_id, cl.kind, cl.catalogue_item_id,
             ci.unit AS catalogue_unit, ci.unit_2 AS catalogue_unit_2,
             cl.description, cl.use_description,
             cl.unit_cost::text AS unit_cost,
             cl.quantity::text AS quantity,
             cl.multiplier::text AS multiplier, cl.multiplier_name,
             cl.multiplier_catalogue_item_id,
             cl.fraction_included::text AS fraction_included,
             cl.production_volume_factor::text AS production_volume_factor,
             cl.size_inputs_json::text AS size_inputs_json,
             cl.calculation_json::text AS calculation_json,
             cl.subtotal::text AS subtotal, cl.sort_order, cl.version,
             cn.id AS source_node_id, cn.name AS source_node_name,
             cn.full_number AS source_node_number,
             cn.kind AS source_node_kind,
             p.id AS source_project_id, p.name AS source_project_name,
             p.season AS source_season,
             p.is_historical AS source_is_historical
      FROM cost_lines cl
      JOIN cost_nodes cn ON cn.id = cl.node_id
      JOIN projects p ON p.id = cn.project_id
      LEFT JOIN catalogue_items ci ON ci.id = cl.catalogue_item_id
      WHERE cl.id = $1
      ${forShare ? "FOR SHARE OF cl" : ""}
    `,
    [sourceLineId],
  );
  if (!row) throw new Error("cost-line-not-found");
  return row;
}

async function catalogueIdsInRelease(
  database: DbExecutor,
  releaseId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await database.query<{ id: string }>(
    `
      SELECT id
      FROM catalogue_items
      WHERE release_id = $1 AND id = ANY($2::text[])
    `,
    [releaseId, ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function nextSortOrder(
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

function remapSeasonNumber(
  fullNumber: string | null,
  sourceSeason: number,
): string | null {
  if (!fullNumber) return null;
  const segments = fullNumber.split("-");
  if (segments.length < 2) return null;
  segments[1] = String(sourceSeason).slice(-2);
  return segments.join("-");
}

function toSearchItem(
  row: HistoricalCostLineRow,
): HistoricalCostLineSearchItem {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    sourceNodeName: row.source_node_name,
    sourceNodeNumber: row.source_node_number,
    sourceNodeKind: row.source_node_kind,
    sourceProjectId: row.source_project_id,
    sourceProjectName: row.source_project_name,
    sourceSeason: row.source_season,
    kind: row.kind,
    catalogueItemId: row.catalogue_item_id,
    unit: row.catalogue_unit,
    unit2: row.catalogue_unit_2,
    description: row.description,
    useDescription: row.use_description,
    unitCost: row.unit_cost,
    sizeInputs: JSON.parse(row.size_inputs_json) as Record<string, string>,
    quantity: row.quantity,
    multiplier: row.multiplier,
    multiplierName: row.multiplier_name,
    fractionIncluded: row.fraction_included,
    productionVolumeFactor: row.production_volume_factor,
    subtotal: row.subtotal,
  };
}

function importWarnings(
  source: HistoricalCostLineRow,
  catalogueItemId: string | null,
  multiplierCatalogueItemId: string | null,
): string[] {
  const warnings: string[] = [];
  if (!source.catalogue_item_id && source.kind !== "tooling") {
    warnings.push("The 2025 row was not linked to a catalogue item.");
  } else if (source.catalogue_item_id && !catalogueItemId) {
    warnings.push(
      "The 2025 catalogue item is not present in the current catalogue release, so the imported row is unlinked.",
    );
  }
  if (source.multiplier_catalogue_item_id && !multiplierCatalogueItemId) {
    warnings.push(
      "The 2025 multiplier is not present in the current catalogue release, so its value was retained without a catalogue link.",
    );
  }
  return warnings;
}

function auditState(line: CostLineRow): Record<string, unknown> {
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
