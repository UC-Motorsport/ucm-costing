import { randomUUID } from "node:crypto";

import {
  canCreateChild,
  nodeKindSchema,
} from "@ucm/domain";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  DbExecutor,
} from "../db/database";
import { systemDefinitions } from "../domain/systems";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import { positiveDecimalStringSchema } from "./cost-input-schemas";
import { VersionConflictError } from "./project-lifecycle-service";
import {
  assertExpectedVersion,
  lockProjectForMutation,
  projectIdForNode,
  touchProject,
} from "./project-mutation-support";
import type { NodeRow } from "./project-types";

const nullableTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });

const createNodeSchema = z.object({
  expectedParentVersion: z.number().int().nonnegative(),
  kind: nodeKindSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5_000).default(""),
  procurementType: z.enum(["made", "bought", "unknown"]).default("unknown"),
  quantity: positiveDecimalStringSchema.default("1"),
  revision: nullableTrimmedStringSchema.optional().default(null),
  fullNumber: nullableTrimmedStringSchema.optional().default(null),
  referenceId: nullableTrimmedStringSchema.optional().default(null),
  internalNote: z.string().max(10_000).default(""),
  systemCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => /^[A-Z][A-Z0-9]{1,2}$/.test(value),
      "System code must be two or three letters or numbers and start with a letter",
    )
    .optional(),
});

const updateNodeSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5_000).optional(),
    procurementType: z.enum(["made", "bought", "unknown"]).optional(),
    quantity: positiveDecimalStringSchema.optional(),
    revision: nullableTrimmedStringSchema.optional(),
    fullNumber: nullableTrimmedStringSchema.optional(),
    referenceId: nullableTrimmedStringSchema.optional(),
    internalNote: z.string().max(10_000).optional(),
    drawingRequired: z.boolean().optional(),
    workStatus: z.enum(["none", "needs-attention", "done"]).optional(),
    flagComment: z.string().trim().max(2_000).optional(),
    imageRequired: z.boolean().optional(),
    imageRequirementReason: z.string().trim().max(500).optional(),
  })
  .refine(
    (input) => input.imageRequired !== false || Boolean(input.imageRequirementReason),
    "A reason is required when an isometric image is not required",
  )
  .refine(
    ({ expectedVersion: _expectedVersion, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    "At least one node field must change",
  );

const moveNodeSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  targetParentId: z.string().uuid(),
  expectedTargetParentVersion: z.number().int().nonnegative(),
  kind: z.enum(["assembly", "subassembly", "part"]),
});

export async function createNode(
  database: DatabaseHandle,
  actor: ActorContext,
  parentId: string,
  rawInput: unknown,
): Promise<NodeRow> {
  const input = createNodeSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const projectId = await projectIdForNode(transaction, parentId);
    await lockProjectForMutation(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const parent = await transaction.maybeOne<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [parentId],
    );
    if (!parent) {
      throw new Error("node-not-found");
    }
    assertExpectedVersion(
      parent.version,
      input.expectedParentVersion,
      "Parent",
    );
    if (!canCreateChild(parent.kind, input.kind)) {
      throw new Error("invalid-node-hierarchy");
    }

    let systemCode: string | null;
    if (input.kind === "system") {
      if (!input.systemCode) {
        throw new Error("system-code-required");
      }
      const reservedSystem = systemDefinitions.find(
        ({ code }) => code === input.systemCode,
      );
      if (reservedSystem && reservedSystem.name !== input.name) {
        throw new Error("system-name-not-allowed");
      }
      const existingSystem = await transaction.maybeOne<{ present: number }>(
        `
          SELECT 1 AS present
          FROM cost_nodes
          WHERE project_id = $1 AND kind = 'system'
            AND upper(system_code) = upper($2)
          LIMIT 1
        `,
        [projectId, input.systemCode],
      );
      if (existingSystem) {
        throw new Error("system-code-conflict");
      }
      systemCode = input.systemCode;
    } else {
      if (input.systemCode !== undefined) {
        throw new Error("system-code-not-allowed");
      }
      systemCode = parent.system_code;
      if (!systemCode) {
        throw new Error("parent-system-code-missing");
      }
    }
    await assertFullNumberAvailable(
      transaction,
      projectId,
      input.fullNumber,
      null,
    );

    const id = randomUUID();
    const sortOrder = await nextNodeSortOrder(
      transaction,
      projectId,
      parent.id,
    );
    const parentUpdate = await transaction.query(
      `
        UPDATE cost_nodes
        SET version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING id
      `,
      [parent.id, input.expectedParentVersion],
    );
    if (parentUpdate.rowCount !== 1) {
      throw new VersionConflictError("Parent changed while adding a child");
    }

    let created: NodeRow;
    try {
      created = await transaction.one<NodeRow>(
        `
          INSERT INTO cost_nodes(
            id, project_id, parent_id, kind, system_code, raw_hla,
            raw_subassembly, raw_part_number, reference_id, full_number,
            name, description, revision, procurement_type, quantity,
            internal_note, source_import_batch_id, source_import_row,
            sort_order, version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, NULL, NULL, NULL, $6, $7,
            $8, $9, $10, $11, $12::numeric, $13, NULL, NULL,
            $14, 0, now(), now()
          )
          RETURNING *
        `,
        [
          id,
          projectId,
          parent.id,
          input.kind,
          systemCode,
          input.referenceId,
          input.fullNumber,
          input.name,
          input.description,
          input.revision,
          input.procurementType,
          input.quantity,
          input.internalNote,
          sortOrder,
        ],
      );
    } catch (error) {
      throw mapFullNumberConflict(error);
    }
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-node.created",
      entityType: "cost-node",
      entityId: id,
      after: auditNodeState(created),
      metadata: { parentId: parent.id },
    });
    return created;
  });
}

export async function updateNode(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  rawInput: unknown,
): Promise<NodeRow> {
  const input = updateNodeSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const projectId = await projectIdForNode(transaction, nodeId);
    await lockProjectForMutation(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const existing = await transaction.maybeOne<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [nodeId],
    );
    if (!existing) {
      throw new Error("node-not-found");
    }
    assertExpectedVersion(existing.version, input.expectedVersion, "Node");
    if (
      (existing.kind === "vehicle" || existing.kind === "system") &&
      (input.quantity !== undefined || input.procurementType !== undefined)
    ) {
      throw new Error("rollup-field-not-allowed");
    }

    if (
      existing.kind !== "part" &&
      (input.workStatus !== undefined || input.flagComment !== undefined)
    ) {
      throw new Error("part-flag-not-allowed");
    }

    const next = {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      procurementType: input.procurementType ?? existing.procurement_type,
      quantity: input.quantity ?? existing.quantity,
      revision:
        input.revision === undefined ? existing.revision : input.revision,
      fullNumber:
        input.fullNumber === undefined ? existing.full_number : input.fullNumber,
      referenceId:
        input.referenceId === undefined
          ? existing.reference_id
          : input.referenceId,
      internalNote: input.internalNote ?? existing.internal_note,
      drawingRequired: input.drawingRequired ?? existing.drawing_required ?? true,
      workStatus: input.workStatus ?? existing.work_status ?? "none",
      flagComment: input.flagComment ?? existing.flag_comment ?? "",
      imageRequired: input.imageRequired ?? existing.image_required ?? true,
      imageRequirementReason: input.imageRequirementReason ?? existing.image_requirement_reason ?? "",
    };
    await assertFullNumberAvailable(
      transaction,
      projectId,
      next.fullNumber,
      existing.id,
    );

    let updated: NodeRow;
    try {
      updated = await transaction.one<NodeRow>(
        `
          UPDATE cost_nodes
          SET name = $1, description = $2, procurement_type = $3,
              quantity = $4::numeric, revision = $5, full_number = $6,
              reference_id = $7, internal_note = $8, drawing_required = $11,
              work_status = $12, flag_comment = $13,
              image_required = $14, image_requirement_reason = $15,
              version = version + 1, updated_at = now()
          WHERE id = $9 AND version = $10
          RETURNING *
        `,
        [
          next.name,
          next.description,
          next.procurementType,
          next.quantity,
          next.revision,
          next.fullNumber,
          next.referenceId,
          next.internalNote,
          nodeId,
          input.expectedVersion,
          next.drawingRequired,
          next.workStatus,
          next.flagComment,
          next.imageRequired,
          next.imageRequirementReason,
        ],
      );
    } catch (error) {
      throw mapFullNumberConflict(error);
    }
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-node.updated",
      entityType: "cost-node",
      entityId: nodeId,
      before: auditNodeState(existing),
      after: auditNodeState(updated),
    });
    return updated;
  });
}

export async function moveNode(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  rawInput: unknown,
): Promise<NodeRow> {
  const input = moveNodeSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const projectId = await projectIdForNode(transaction, nodeId);
    await lockProjectForMutation(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");

    const existing = await transaction.maybeOne<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [nodeId],
    );
    if (!existing) throw new Error("node-not-found");
    assertExpectedVersion(existing.version, input.expectedVersion, "Node");
    if (
      existing.kind !== "assembly" &&
      existing.kind !== "subassembly" &&
      existing.kind !== "part"
    ) {
      throw new Error("node-move-kind-not-allowed");
    }
    if ((existing.kind === "part") !== (input.kind === "part")) {
      throw new Error("node-move-kind-not-allowed");
    }

    const targetParent = await transaction.maybeOne<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [input.targetParentId],
    );
    if (!targetParent) throw new Error("node-not-found");
    if (targetParent.project_id !== projectId) {
      throw new Error("node-move-cross-project-not-allowed");
    }
    assertExpectedVersion(
      targetParent.version,
      input.expectedTargetParentVersion,
      "Destination",
    );
    if (existing.system_code !== targetParent.system_code) {
      throw new Error("node-move-cross-system-not-allowed");
    }
    if (!canCreateChild(targetParent.kind, input.kind)) {
      throw new Error("invalid-node-hierarchy");
    }
    if (existing.parent_id === targetParent.id && existing.kind === input.kind) {
      throw new Error("node-move-no-change");
    }

    const targetInSubtree = await transaction.maybeOne<{ present: number }>(
      `
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM cost_nodes WHERE id = $1
          UNION ALL
          SELECT child.id
          FROM cost_nodes child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT 1 AS present
        FROM subtree
        WHERE id = $2
        LIMIT 1
      `,
      [nodeId, targetParent.id],
    );
    if (targetInSubtree) throw new Error("node-move-cycle");

    const sortOrder = await nextNodeSortOrder(
      transaction,
      projectId,
      targetParent.id,
    );
    const updated = await transaction.one<NodeRow>(
      `
        UPDATE cost_nodes
        SET parent_id = $1, kind = $2, sort_order = $3,
            version = version + 1, updated_at = now()
        WHERE id = $4 AND version = $5
        RETURNING *
      `,
      [
        targetParent.id,
        input.kind,
        sortOrder,
        existing.id,
        input.expectedVersion,
      ],
    );

    const parentIds = [existing.parent_id, targetParent.id].filter(
      (id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index,
    );
    if (parentIds.length > 0) {
      await transaction.query(
        `
          UPDATE cost_nodes
          SET version = version + 1, updated_at = now()
          WHERE id = ANY($1::text[])
        `,
        [parentIds],
      );
    }

    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-node.moved",
      entityType: "cost-node",
      entityId: nodeId,
      before: auditNodeState(existing),
      after: auditNodeState(updated),
      metadata: {
        oldParentId: existing.parent_id,
        newParentId: targetParent.id,
        oldKind: existing.kind,
        newKind: input.kind,
        controlledIdentifierPreserved: true,
      },
    });
    return updated;
  });
}

export async function deleteNode(
  database: DatabaseHandle,
  actor: ActorContext,
  nodeId: string,
  expectedVersion: number,
  cascade = false,
): Promise<string[]> {
  return database.transaction(async (transaction) => {
    const projectId = await projectIdForNode(transaction, nodeId);
    await lockProjectForMutation(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    const existing = await transaction.maybeOne<NodeRow>(
      "SELECT * FROM cost_nodes WHERE id = $1 FOR UPDATE",
      [nodeId],
    );
    if (!existing) {
      throw new Error("node-not-found");
    }
    assertExpectedVersion(existing.version, expectedVersion, "Node");
    if (existing.kind === "vehicle") {
      throw new Error("vehicle-root-protected");
    }

    const childCount = await transaction.one<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM cost_nodes
        WHERE parent_id = $1
      `,
      [nodeId],
    );
    if (childCount.count > 0 && !cascade) {
      throw new Error("node-has-children");
    }
    if (!cascade) {
      const dependents = await transaction.one<{
        has_cost_lines: boolean;
        has_evidence: boolean;
      }>(
        `
          SELECT
            EXISTS(SELECT 1 FROM cost_lines WHERE node_id = $1)
              AS has_cost_lines,
            EXISTS(SELECT 1 FROM evidence WHERE node_id = $1)
              AS has_evidence
        `,
        [nodeId],
      );
      if (dependents.has_cost_lines || dependents.has_evidence) {
        throw new Error("node-has-dependent-data");
      }
    }

    const cairEvidenceReference = await transaction.maybeOne<{
      evidence_id: string;
    }>(
      `
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM cost_nodes WHERE id = $1
          UNION ALL
          SELECT child.id
          FROM cost_nodes child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT ce.evidence_id
        FROM evidence e
        JOIN subtree ON subtree.id = e.node_id
        JOIN cair_evidence ce ON ce.evidence_id = e.id
        LIMIT 1
      `,
      [nodeId],
    );
    if (cairEvidenceReference) {
      throw new Error("evidence-cair-reference-protected");
    }

    const subtree = await transaction.query<{
      id: string;
      storage_path: string | null;
    }>(
      `
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM cost_nodes WHERE id = $1
          UNION ALL
          SELECT child.id
          FROM cost_nodes child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT subtree.id, evidence.storage_path
        FROM subtree
        LEFT JOIN evidence ON evidence.node_id = subtree.id
        ORDER BY subtree.id, evidence.storage_path
      `,
      [nodeId],
    );
    await transaction.query(
      `
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM cost_nodes WHERE id = $1
          UNION ALL
          SELECT child.id
          FROM cost_nodes child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        INSERT INTO evidence_file_cleanup(
          storage_path, project_id, reason, queued_at, attempts
        )
        SELECT DISTINCT e.storage_path, e.project_id, 'deletion', now(), 0
        FROM evidence e
        JOIN subtree ON subtree.id = e.node_id
        ON CONFLICT (storage_path) DO NOTHING
      `,
      [nodeId],
    );
    await transaction.query(
      `
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM cost_nodes WHERE id = $1
          UNION ALL
          SELECT child.id
          FROM cost_nodes child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        UPDATE import_rows
        SET node_id = NULL
        WHERE node_id IN (SELECT id FROM subtree)
      `,
      [nodeId],
    );
    const deleted = await transaction.query(
      `
        DELETE FROM cost_nodes
        WHERE id = $1 AND version = $2
        RETURNING id
      `,
      [nodeId, expectedVersion],
    );
    if (deleted.rowCount !== 1) {
      throw new VersionConflictError("Node changed while deleting");
    }
    if (existing.parent_id) {
      await transaction.query(
        `
          UPDATE cost_nodes
          SET version = version + 1, updated_at = now()
          WHERE id = $1
        `,
        [existing.parent_id],
      );
    }
    await touchProject(transaction, projectId, actor.actorUserId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-node.deleted",
      entityType: "cost-node",
      entityId: nodeId,
      before: auditNodeState(existing),
      after: null,
      metadata: {
        cascade,
        deletedNodeIds: [...new Set(subtree.rows.map(({ id }) => id))],
        queuedEvidenceFiles: subtree.rows.filter(
          ({ storage_path: storagePath }) => storagePath !== null,
        ).length,
      },
    });
    return [
      ...new Set(
        subtree.rows.flatMap(({ storage_path: storagePath }) =>
          storagePath ? [storagePath] : [],
        ),
      ),
    ];
  });
}

async function assertFullNumberAvailable(
  database: DbExecutor,
  projectId: string,
  fullNumber: string | null,
  excludedNodeId: string | null,
): Promise<void> {
  if (!fullNumber) {
    return;
  }
  const conflict = await database.maybeOne<{ present: number }>(
    `
      SELECT 1 AS present
      FROM cost_nodes
      WHERE project_id = $1 AND lower(full_number) = lower($2)
        AND ($3::text IS NULL OR id <> $3)
      LIMIT 1
    `,
    [projectId, fullNumber, excludedNodeId],
  );
  if (conflict) {
    throw new Error("node-full-number-conflict");
  }
}

async function nextNodeSortOrder(
  database: DbExecutor,
  projectId: string,
  parentId: string,
): Promise<number> {
  const row = await database.one<{ next: number }>(
    `
      SELECT (COALESCE(MAX(sort_order), -1) + 1)::int AS next
      FROM cost_nodes
      WHERE project_id = $1 AND parent_id = $2
    `,
    [projectId, parentId],
  );
  return row.next;
}

function auditNodeState(node: NodeRow): Record<string, unknown> {
  return {
    id: node.id,
    projectId: node.project_id,
    parentId: node.parent_id,
    kind: node.kind,
    systemCode: node.system_code,
    referenceId: node.reference_id,
    fullNumber: node.full_number,
    name: node.name,
    description: node.description,
    revision: node.revision,
    procurementType: node.procurement_type,
    quantity: node.quantity,
    internalNote: node.internal_note,
    drawingRequired: node.drawing_required ?? true,
    workStatus: node.work_status ?? "none",
    flagComment: node.flag_comment ?? "",
    imageRequired: node.image_required ?? true,
    imageRequirementReason: node.image_requirement_reason ?? "",
    sortOrder: node.sort_order,
    version: node.version,
  };
}

function mapFullNumberConflict(error: unknown): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "23505"
  ) {
    return new Error("node-full-number-conflict");
  }
  return error instanceof Error ? error : new Error("node-write-failed");
}
