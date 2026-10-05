import {
  calculateNodeRollup,
  costKinds,
  type CostLineResult,
} from "@ucm/domain";

import type {
  DatabaseHandle,
  DbExecutor,
} from "../db/database";
import {
  getProjectRow,
  type ProjectRow,
} from "./project-lifecycle-service";
import type {
  CostLineRow,
  NodeRow,
  ProjectDetail,
  ProjectNode,
} from "./project-types";

export async function getProjectDetail(
  database: DatabaseHandle,
  projectId: string,
): Promise<ProjectDetail | null> {
  return database.transaction(
    (transaction) => getProjectDetailFromExecutor(transaction, projectId),
    { isolationLevel: "repeatable read", readOnly: true },
  );
}

export async function getProjectDetailFromExecutor(
  database: DbExecutor,
  projectId: string,
): Promise<ProjectDetail | null> {
  let project: ProjectRow;
  try {
    project = await getProjectRow(database, projectId);
  } catch (error) {
    if (error instanceof Error && error.message === "project-not-found") {
      return null;
    }
    throw error;
  }

  // DbExecutor can be a single transactional PoolClient, so queries must not
  // be issued concurrently on it.
  const nodeResult = await database.query<NodeRow>(
    `
      SELECT *
      FROM cost_nodes
      WHERE project_id = $1
      ORDER BY sort_order, lower(name), id
    `,
    [projectId],
  );
  const lineResult = await database.query<CostLineRow>(
    `
      SELECT
        cl.id, cl.node_id, cl.kind, cl.catalogue_item_id, cl.description,
        ci.unit AS catalogue_unit, ci.unit_2 AS catalogue_unit_2,
        stock.name AS stock_size_name,
        CASE
          WHEN ci.origin = 'team' THEN 'team'
          WHEN ci.effective_revision > 0 THEN 'edited'
          ELSE 'official'
        END AS catalogue_provenance,
        ci.effective_revision AS catalogue_revision,
        (ci.fixed_cost IS NOT NULL) AS catalogue_uses_unit_amount,
        cl.use_description, cl.unit_cost::text AS unit_cost,
        cl.quantity::text AS quantity, cl.multiplier::text AS multiplier,
        cl.multiplier_name, cl.multiplier_catalogue_item_id,
        cl.fraction_included::text AS fraction_included,
        cl.production_volume_factor::text AS production_volume_factor,
        cl.size_inputs_json::text AS size_inputs_json,
        cl.calculation_json::text AS calculation_json,
        cl.subtotal::text AS subtotal, cl.sort_order, cl.version,
        cl.created_at, cl.updated_at
      FROM cost_lines cl
      JOIN cost_nodes cn ON cn.id = cl.node_id
      LEFT JOIN effective_catalogue_items ci ON ci.id = cl.catalogue_item_id
      LEFT JOIN effective_catalogue_items stock ON stock.id = cl.size_inputs_json ->> 'stockSizeCatalogueItemId'
      WHERE cn.project_id = $1
      ORDER BY cl.kind, cl.sort_order, lower(cl.description), cl.id
    `,
    [projectId],
  );
  const nodes = nodeResult.rows;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const linesByNode = new Map<string, CostLineRow[]>();
  for (const line of lineResult.rows) {
    if (!nodeIds.has(line.node_id)) {
      continue;
    }
    const existing = linesByNode.get(line.node_id) ?? [];
    existing.push(line);
    linesByNode.set(line.node_id, existing);
  }

  const childrenByParent = new Map<string | null, NodeRow[]>();
  for (const node of nodes) {
    const existing = childrenByParent.get(node.parent_id) ?? [];
    existing.push(node);
    childrenByParent.set(node.parent_id, existing);
  }

  const materialize = (node: NodeRow): ProjectNode => {
    const children = (childrenByParent.get(node.id) ?? []).map(materialize);
    const costLines = linesByNode.get(node.id) ?? [];
    const breakdown = calculateNodeRollup(
      costLines.map(toCostLineResult),
      children.map((child) => ({
        quantity: child.quantity,
        breakdown: child.breakdown,
      })),
    );
    return { ...node, costLines, breakdown, children };
  };

  const roots = childrenByParent.get(null) ?? [];
  if (roots.length !== 1) {
    throw new Error(
      `Project ${projectId} must contain exactly one vehicle root; found ${roots.length}`,
    );
  }
  const rootRow = roots[0]!;
  if (rootRow.kind !== "vehicle") {
    throw new Error(`Project ${projectId} root must be a vehicle`);
  }
  const root = materialize(rootRow);
  const flatNodes: ProjectNode[] = [];
  const walk = (node: ProjectNode): void => {
    flatNodes.push(node);
    node.children.forEach(walk);
  };
  walk(root);

  const { focus_systems_json: focusSystemsJson, ...projectFields } = project;
  return {
    project: {
      ...projectFields,
      focusSystems: JSON.parse(focusSystemsJson) as string[],
    },
    tree: root,
    flatNodes,
    breakdown: root.breakdown,
  };
}

function toCostLineResult(line: CostLineRow): CostLineResult {
  const parsed = JSON.parse(line.calculation_json) as CostLineResult;
  if (
    parsed.kind !== line.kind ||
    parsed.subtotal !== line.subtotal ||
    !costKinds.includes(parsed.kind)
  ) {
    throw new Error(`Stored calculation does not match cost line ${line.id}`);
  }
  return parsed;
}
