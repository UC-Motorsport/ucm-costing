import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type { DatabaseHandle } from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  assertExpectedVersion,
  lockProjectForMutation,
  projectIdForNode,
  touchProject,
} from "./project-mutation-support";
import type { NodeRow } from "./project-types";

const reorderChildrenSchema = z.object({
  expectedParentVersion: z.number().int().nonnegative(),
  childIds: z
    .array(z.string().min(1))
    .min(1)
    .max(5000)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Include each child once",
    ),
});

export async function reorderNodeChildren(
  database: DatabaseHandle,
  actor: ActorContext,
  parentId: string,
  rawInput: unknown,
): Promise<{ parentVersion: number; childIds: string[] }> {
  const input = reorderChildrenSchema.parse(rawInput);
  return database.transaction(async (transaction) => {
    const projectId = await projectIdForNode(transaction, parentId);
    await lockProjectForMutation(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const parent = await transaction.one<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [parentId],
    );
    if (!["system", "assembly", "subassembly"].includes(parent.kind)) {
      throw new Error("node-reorder-kind-not-allowed");
    }
    assertExpectedVersion(
      parent.version,
      input.expectedParentVersion,
      "Parent",
    );
    const children = await transaction.query<{ id: string }>(
      `SELECT id FROM cost_nodes WHERE parent_id = $1 AND project_id = $2
       ORDER BY sort_order, lower(name), id FOR UPDATE`,
      [parentId, projectId],
    );
    const requestedIds = new Set(input.childIds);
    if (
      children.rows.length !== input.childIds.length ||
      children.rows.some((child) => !requestedIds.has(child.id))
    ) {
      throw new Error("invalid-node-child-order");
    }
    const previousIds = children.rows.map((child) => child.id);
    if (previousIds.every((id, index) => id === input.childIds[index])) {
      return { parentVersion: parent.version, childIds: previousIds };
    }
    await transaction.query(
      `UPDATE cost_nodes node
       SET sort_order = (ordering.position - 1)::int,
           version = node.version + 1, updated_at = now()
       FROM unnest($1::text[]) WITH ORDINALITY AS ordering(id, position)
       WHERE node.id = ordering.id AND node.parent_id = $2
         AND node.sort_order IS DISTINCT FROM (ordering.position - 1)::int`,
      [input.childIds, parentId],
    );
    const updated = await transaction.one<{ version: number }>(
      `UPDATE cost_nodes SET version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version`,
      [parentId],
    );
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-node.children-reordered",
      entityType: "cost-node",
      entityId: parentId,
      before: { childIds: previousIds, version: parent.version },
      after: { childIds: input.childIds, version: updated.version },
    });
    return { parentVersion: updated.version, childIds: input.childIds };
  });
}
