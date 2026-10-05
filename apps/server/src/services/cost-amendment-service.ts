import { randomUUID } from "node:crypto";

import {
  validateAmendmentWorkflow,
  type AmendmentClassification,
  type AmendmentWorkflowItem,
  type CostKind,
  type RuleWorkflowIssue,
} from "@ucm/domain";
import Decimal from "decimal.js";
import type { QueryResultRow } from "pg";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  TransactionHandle,
} from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import { sha256CanonicalJson } from "../security/canonical-json";
import { resolveCatalogueUnitCost } from "./catalogue-service";

export type CostAmendmentStatus =
  | "draft"
  | "locked"
  | "exported"
  | "manually-submitted"
  | "accepted"
  | "rejected";

export interface CostAmendmentRow extends QueryResultRow {
  id: string;
  project_id: string;
  event_reference: string;
  status: CostAmendmentStatus;
  base_report_snapshot_id: string;
  snapshot_json: Record<string, unknown> | null;
  total_additions: string;
  total_removals: string;
  net_change: string;
  external_reference: string | null;
  created_by: string;
  updated_by: string;
  locked_by: string | null;
  submitted_by: string | null;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  exported_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  version: number;
}

export interface CostAmendmentItemRow extends QueryResultRow {
  id: string;
  amendment_id: string;
  action: "add" | "remove";
  node_id: string | null;
  description: string;
  cost_box: CostKind;
  classification: AmendmentClassification;
  change_group_id: string | null;
  quantity: string;
  original_quantity: string;
  revised_quantity: string;
  unit_cost: string;
  subtotal: string;
  source_json: AmendmentItemSource;
  sort_order: number;
}

export interface AmendmentItemSource {
  partIdentity: string;
  partNumber: string;
  catalogueReleaseId: string;
  catalogueItemId: string;
  catalogueId: string;
  [key: string]: unknown;
}

export interface CostAmendmentDetail {
  amendment: CostAmendmentRow;
  items: CostAmendmentItemRow[];
  blockers: RuleWorkflowIssue[];
  baseReport: CostAmendmentBaseReport;
}

export interface CostAmendmentBaseReport {
  catalogueReleaseId: string;
  catalogueRevision: string;
  parts: CostAmendmentBasePart[];
}

export interface CostAmendmentBasePart {
  id: string;
  fullNumber: string | null;
  referenceId: string | null;
  name: string;
  quantity: string;
  breakdown: {
    material: string;
    process: string;
    fastener: string;
    tooling: string;
    total: string;
  };
}

export class CostAmendmentWorkflowBlockedError extends Error {
  readonly code = "cost-amendment-workflow-blocked";

  constructor(readonly issues: RuleWorkflowIssue[]) {
    super(
      `Cost amendment is preview-only: ${issues.map(({ code }) => code).join(", ")}`,
    );
  }
}

const createAmendmentSchema = z.object({
  eventReference: z.string().trim().min(1).max(500),
  baseReportSnapshotId: z.string().trim().min(1),
});

const amendmentItemSchema = z.object({
  action: z.enum(["add", "remove"]),
  partIdentity: z.string().trim().min(1).max(500).optional(),
  catalogueItemId: z.string().trim().min(1).optional(),
  sizeInputs: z.record(z.string(), z.string().trim().max(100)).default({}),
  // Legacy fields remain accepted for a rolling client upgrade, but the
  // service derives and persists their authoritative values.
  nodeId: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1).max(2_000),
  costBox: z.enum(["material", "process", "fastener", "tooling"]).optional(),
  classification: z.enum([
    "new",
    "deleted",
    "modified",
    "quantity-change",
    "unresolved",
  ]),
  changeGroupId: z.string().trim().min(1).max(200).nullable().optional(),
  quantity: z.union([z.string(), z.number()]).transform((value) =>
    positiveDecimal(String(value), "quantity"),
  ),
  originalQuantity: z.union([z.string(), z.number()]).transform((value) =>
    nonNegativeDecimal(String(value), "original quantity"),
  ),
  revisedQuantity: z.union([z.string(), z.number()]).transform((value) =>
    nonNegativeDecimal(String(value), "revised quantity"),
  ),
  unitCost: z
    .union([z.string(), z.number()])
    .transform((value) =>
      nonNegativeDecimal(String(value), "unit cost"),
    )
    .optional(),
  source: z
    .object({
      partIdentity: z.string().trim().min(1).max(500),
      partNumber: z.string().trim().min(1).max(500).optional(),
      catalogueReleaseId: z.string().trim().min(1).optional(),
      catalogueItemId: z.string().trim().min(1),
      catalogueId: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .optional(),
  sortOrder: z.number().int().nonnegative().optional(),
}).superRefine((input, context) => {
  if (!input.partIdentity && !input.source?.partIdentity) {
    context.addIssue({
      code: "custom",
      path: ["partIdentity"],
      message: "Select a part from the immutable base report",
    });
  }
  if (!input.catalogueItemId && !input.source?.catalogueItemId) {
    context.addIssue({
      code: "custom",
      path: ["catalogueItemId"],
      message: "Select an item from the base report catalogue release",
    });
  }
});

export async function createCostAmendmentDraft(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  rawInput: unknown,
): Promise<CostAmendmentRow> {
  const input = createAmendmentSchema.parse(rawInput);
  return await database.transaction(async (transaction) => {
    await assertProjectPermission(
      transaction,
      actor,
      projectId,
      "write",
    );
    const report = await transaction.maybeOne<{
      id: string;
      status: string;
    }>(
      `
        SELECT id, status
        FROM report_snapshots
        WHERE id = $1 AND project_id = $2
        FOR SHARE
      `,
      [input.baseReportSnapshotId, projectId],
    );
    if (!report || report.status !== "complete") {
      throw new Error("cost-amendment-base-report-not-complete");
    }
    const id = randomUUID();
    const created = await transaction.one<CostAmendmentRow>(
      `
        INSERT INTO cost_amendments(
          id, project_id, event_reference, status,
          base_report_snapshot_id, created_by, updated_by
        )
        VALUES ($1, $2, $3, 'draft', $4, $5, $5)
        RETURNING *
      `,
      [
        id,
        projectId,
        input.eventReference,
        input.baseReportSnapshotId,
        actor.actorUserId,
      ],
    );
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cost-amendment.created",
      entityType: "cost-amendment",
      entityId: id,
      after: created,
    });
    return created;
  });
}

export async function addCostAmendmentItem(
  database: DatabaseHandle,
  actor: ActorContext,
  amendmentId: string,
  expectedAmendmentVersion: number,
  rawInput: unknown,
): Promise<CostAmendmentDetail> {
  const input = amendmentItemSchema.parse(rawInput);
  validateItemContract(input);
  return await database.transaction(async (transaction) => {
    const amendment = await lockEditableAmendment(
      transaction,
      amendmentId,
      expectedAmendmentVersion,
    );
    await assertProjectPermission(
      transaction,
      actor,
      amendment.project_id,
      "write",
    );
    const resolved = await resolveAmendmentItem(
      transaction,
      amendment,
      input,
    );
    const id = randomUUID();
    const subtotal = new Decimal(resolved.unitCost)
      .times(input.quantity)
      .toSignificantDigits(24)
      .toString();
    const sortOrder =
      input.sortOrder ??
      (
        await transaction.one<{ next: number }>(
          `
            SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
            FROM cost_amendment_items
            WHERE amendment_id = $1
          `,
          [amendmentId],
        )
      ).next;
    const item = await transaction.one<CostAmendmentItemRow>(
      `
        INSERT INTO cost_amendment_items(
          id, amendment_id, action, node_id, description, cost_box,
          classification, change_group_id, quantity, original_quantity,
          revised_quantity, unit_cost, subtotal, source_json, sort_order
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14::jsonb, $15
        )
        RETURNING *
      `,
      [
        id,
        amendmentId,
        input.action,
        resolved.nodeId,
        input.description,
        resolved.costBox,
        input.classification,
        input.changeGroupId ?? null,
        input.quantity,
        input.originalQuantity,
        input.revisedQuantity,
        resolved.unitCost,
        subtotal,
        JSON.stringify(resolved.source),
        sortOrder,
      ],
    );
    const updated = await recalculateAmendment(
      transaction,
      amendment,
      actor.actorUserId,
    );
    await appendAuditEntry(transaction, actor, {
      projectId: amendment.project_id,
      action: "cost-amendment.item-added",
      entityType: "cost-amendment-item",
      entityId: id,
      after: item,
      metadata: {
        amendmentId,
        authoritativeCatalogueItemId: resolved.source.catalogueItemId,
        authoritativeUnitCost: resolved.unitCost,
      },
    });
    return await detailInTransaction(transaction, updated);
  });
}

export async function updateCostAmendmentItem(
  database: DatabaseHandle,
  actor: ActorContext,
  amendmentId: string,
  itemId: string,
  expectedAmendmentVersion: number,
  rawInput: unknown,
): Promise<CostAmendmentDetail> {
  const input = amendmentItemSchema.parse(rawInput);
  validateItemContract(input);
  return await database.transaction(async (transaction) => {
    const amendment = await lockEditableAmendment(
      transaction,
      amendmentId,
      expectedAmendmentVersion,
    );
    await assertProjectPermission(
      transaction,
      actor,
      amendment.project_id,
      "write",
    );
    const before = await transaction.maybeOne<CostAmendmentItemRow>(
      `
        SELECT *
        FROM cost_amendment_items
        WHERE id = $1 AND amendment_id = $2
        FOR UPDATE
      `,
      [itemId, amendmentId],
    );
    if (!before) {
      throw new Error("cost-amendment-item-not-found");
    }
    const resolved = await resolveAmendmentItem(
      transaction,
      amendment,
      input,
    );
    const subtotal = new Decimal(resolved.unitCost)
      .times(input.quantity)
      .toSignificantDigits(24)
      .toString();
    const after = await transaction.one<CostAmendmentItemRow>(
      `
        UPDATE cost_amendment_items
        SET action = $1, node_id = $2, description = $3, cost_box = $4,
            classification = $5, change_group_id = $6, quantity = $7,
            original_quantity = $8, revised_quantity = $9, unit_cost = $10,
            subtotal = $11, source_json = $12::jsonb,
            sort_order = COALESCE($13, sort_order)
        WHERE id = $14 AND amendment_id = $15
        RETURNING *
      `,
      [
        input.action,
        resolved.nodeId,
        input.description,
        resolved.costBox,
        input.classification,
        input.changeGroupId ?? null,
        input.quantity,
        input.originalQuantity,
        input.revisedQuantity,
        resolved.unitCost,
        subtotal,
        JSON.stringify(resolved.source),
        input.sortOrder ?? null,
        itemId,
        amendmentId,
      ],
    );
    const updated = await recalculateAmendment(
      transaction,
      amendment,
      actor.actorUserId,
    );
    await appendAuditEntry(transaction, actor, {
      projectId: amendment.project_id,
      action: "cost-amendment.item-updated",
      entityType: "cost-amendment-item",
      entityId: itemId,
      before,
      after,
      metadata: {
        amendmentId,
        authoritativeCatalogueItemId: resolved.source.catalogueItemId,
        authoritativeUnitCost: resolved.unitCost,
      },
    });
    return await detailInTransaction(transaction, updated);
  });
}

export async function deleteCostAmendmentItem(
  database: DatabaseHandle,
  actor: ActorContext,
  amendmentId: string,
  itemId: string,
  expectedAmendmentVersion: number,
): Promise<CostAmendmentDetail> {
  return await database.transaction(async (transaction) => {
    const amendment = await lockEditableAmendment(
      transaction,
      amendmentId,
      expectedAmendmentVersion,
    );
    await assertProjectPermission(
      transaction,
      actor,
      amendment.project_id,
      "write",
    );
    const deleted = await transaction.maybeOne<CostAmendmentItemRow>(
      `
        DELETE FROM cost_amendment_items
        WHERE id = $1 AND amendment_id = $2
        RETURNING *
      `,
      [itemId, amendmentId],
    );
    if (!deleted) {
      throw new Error("cost-amendment-item-not-found");
    }
    const updated = await recalculateAmendment(
      transaction,
      amendment,
      actor.actorUserId,
    );
    await appendAuditEntry(transaction, actor, {
      projectId: amendment.project_id,
      action: "cost-amendment.item-deleted",
      entityType: "cost-amendment-item",
      entityId: itemId,
      before: deleted,
      metadata: { amendmentId },
    });
    return await detailInTransaction(transaction, updated);
  });
}

export async function getCostAmendmentDetail(
  database: DatabaseHandle,
  actor: ActorContext,
  amendmentId: string,
): Promise<CostAmendmentDetail | null> {
  const amendment = await database.maybeOne<CostAmendmentRow>(
    "SELECT * FROM cost_amendments WHERE id = $1",
    [amendmentId],
  );
  if (!amendment) {
    return null;
  }
  await assertProjectPermission(
    database,
    actor,
    amendment.project_id,
    "read",
  );
  return await detailWithExecutor(database, amendment);
}

export async function listCostAmendments(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  limit = 100,
  offset = 0,
): Promise<CostAmendmentRow[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid-cost-amendment-pagination");
  }
  await assertProjectPermission(
    database,
    actor,
    projectId,
    "read",
  );
  const result = await database.query<CostAmendmentRow>(
    `
      SELECT *
      FROM cost_amendments
      WHERE project_id = $1
      ORDER BY updated_at DESC, id
      LIMIT $2 OFFSET $3
    `,
    [projectId, limit, offset],
  );
  return result.rows;
}

/**
 * The current verified source set permits a watermarked preview only. This
 * fail-closed guard is the single server-side gate used before lock/final
 * export; it will remain blocking until an official template renderer and
 * classification references are checked in.
 */
export function assertCostAmendmentMayLock(
  detail: CostAmendmentDetail,
): void {
  const blockers = [
    ...detail.blockers,
    {
      code: "amendment-official-renderer-unavailable",
      severity: "blocker" as const,
      message:
        "The official 2026 CAR template is absent, so only the watermarked preview can be exported.",
      itemIds: [],
    },
  ];
  throw new CostAmendmentWorkflowBlockedError(blockers);
}

/**
 * Freezes the exact machine-readable calculation used for a preview. Item
 * mutations clear this field, while every successful freeze is also preserved
 * in the append-only ledger and in the terminal artifact metadata.
 */
export async function freezeCostAmendmentPreviewSnapshot(
  database: DatabaseHandle,
  actor: ActorContext,
  amendmentId: string,
  expectedVersion: number,
  snapshot: {
    amendmentId: string;
    previewOnly: true;
  },
): Promise<{
  amendment: CostAmendmentRow;
  snapshotSha256: string;
}> {
  if (
    snapshot.amendmentId !== amendmentId
  ) {
    throw new Error("cost-amendment-preview-snapshot-invalid");
  }
  const snapshotSha256 = sha256CanonicalJson(snapshot);
  return await database.transaction(async (transaction) => {
    const before = await lockEditableAmendment(
      transaction,
      amendmentId,
      expectedVersion,
    );
    await assertProjectPermission(
      transaction,
      actor,
      before.project_id,
      "write",
    );
    const amendment = await transaction.maybeOne<CostAmendmentRow>(
      `
        UPDATE cost_amendments
        SET snapshot_json = $1::jsonb,
            updated_by = $2,
            updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $3 AND version = $4 AND status = 'draft'
        RETURNING *
      `,
      [
        JSON.stringify(snapshot),
        actor.actorUserId,
        amendmentId,
        expectedVersion,
      ],
    );
    if (!amendment) {
      throw new Error("cost-amendment-version-conflict");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: before.project_id,
      action: "cost-amendment.preview-snapshot-frozen",
      entityType: "cost-amendment",
      entityId: amendmentId,
      before,
      after: amendment,
      metadata: { snapshotSha256 },
    });
    return { amendment, snapshotSha256 };
  });
}

function validateItemContract(
  input: z.infer<typeof amendmentItemSchema>,
): void {
  if (
    (input.classification === "modified" ||
      input.classification === "quantity-change") &&
    !input.changeGroupId
  ) {
    throw new Error("cost-amendment-change-group-required");
  }
  if (
    input.classification === "new" &&
    (input.action !== "add" ||
      !new Decimal(input.originalQuantity).isZero())
  ) {
    throw new Error("invalid-cost-amendment-new-row");
  }
  if (
    input.classification === "deleted" &&
    (input.action !== "remove" ||
      !new Decimal(input.revisedQuantity).isZero())
  ) {
    throw new Error("invalid-cost-amendment-deleted-row");
  }
}

interface ResolvedAmendmentItem {
  nodeId: string | null;
  costBox: CostKind;
  unitCost: string;
  source: AmendmentItemSource;
}

interface BaseSnapshotNode {
  id: string;
  kind: string;
  full_number: string | null;
  reference_id: string | null;
  name: string;
  quantity: string;
  breakdown: CostAmendmentBasePart["breakdown"];
  children: BaseSnapshotNode[];
}

interface BaseSnapshot {
  sources: {
    catalogue: {
      releaseId: string;
      revision: string;
    };
  };
  tree: BaseSnapshotNode;
}

async function resolveAmendmentItem(
  transaction: TransactionHandle,
  amendment: CostAmendmentRow,
  input: z.infer<typeof amendmentItemSchema>,
): Promise<ResolvedAmendmentItem> {
  const snapshot = await loadBaseSnapshot(transaction, amendment);
  const requestedPartIdentity =
    input.partIdentity ?? input.source?.partIdentity;
  const requestedCatalogueItemId =
    input.catalogueItemId ?? input.source?.catalogueItemId;
  if (!requestedPartIdentity || !requestedCatalogueItemId) {
    throw new Error("invalid-cost-amendment-source");
  }
  const part = flattenSnapshotNodes(snapshot.tree).find(
    (candidate) =>
      candidate.id === requestedPartIdentity ||
      candidate.full_number === requestedPartIdentity ||
      candidate.reference_id === requestedPartIdentity,
  );
  if (!part) {
    throw new Error("cost-amendment-part-not-in-base-report");
  }
  if (input.nodeId && input.nodeId !== part.id) {
    throw new Error("cost-amendment-part-identity-mismatch");
  }

  const item = await transaction.maybeOne<{
    id: string;
    release_id: string;
    kind: string;
    catalogue_id: string;
    name: string;
  }>(
    `
      SELECT ci.id, ci.release_id, ci.kind, ci.catalogue_id, ci.name
      FROM catalogue_items ci
      WHERE ci.id = $1 AND ci.release_id = $2
    `,
    [
      requestedCatalogueItemId,
      snapshot.sources.catalogue.releaseId,
    ],
  );
  if (!item) {
    throw new Error("cost-amendment-catalogue-item-not-found");
  }
  if (
    !["material", "process", "fastener", "tooling"].includes(item.kind)
  ) {
    throw new Error("catalogue-kind-mismatch");
  }
  if (input.costBox && input.costBox !== item.kind) {
    throw new Error("catalogue-kind-mismatch");
  }
  const costBox = item.kind as CostKind;
  const unitCost = await resolveCatalogueUnitCost(
    transaction,
    snapshot.sources.catalogue.releaseId,
    {
      kind: costBox,
      catalogueItemId: item.id,
      sizeInputs: input.sizeInputs,
    },
  );

  const liveNode = await transaction.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM cost_nodes
      WHERE id = $1 AND project_id = $2
    `,
    [part.id, amendment.project_id],
  );
  return {
    nodeId: liveNode?.id ?? null,
    costBox,
    unitCost,
    source: {
      partIdentity: part.id,
      partNumber: part.full_number ?? part.reference_id ?? part.id,
      catalogueReleaseId: item.release_id,
      catalogueItemId: item.id,
      catalogueId: item.catalogue_id,
      catalogueItemName: item.name,
      sizeInputs: input.sizeInputs,
      derivedFrom: "immutable-base-report-and-official-catalogue",
    },
  };
}

async function loadBaseSnapshot(
  database: Pick<TransactionHandle, "query">,
  amendment: CostAmendmentRow,
): Promise<BaseSnapshot> {
  const result = await database.query<{ snapshot_json: unknown }>(
    `
      SELECT snapshot_json
      FROM report_snapshots
      WHERE id = $1 AND project_id = $2 AND status = 'complete'
    `,
    [amendment.base_report_snapshot_id, amendment.project_id],
  );
  const raw = result.rows[0]?.snapshot_json;
  if (!raw || typeof raw !== "object") {
    throw new Error("cost-amendment-base-snapshot-invalid");
  }
  const snapshot = raw as Partial<BaseSnapshot>;
  if (
    !snapshot.sources?.catalogue?.releaseId ||
    !snapshot.sources.catalogue.revision ||
    !snapshot.tree?.id ||
    !Array.isArray(snapshot.tree.children)
  ) {
    throw new Error("cost-amendment-base-snapshot-invalid");
  }
  return snapshot as BaseSnapshot;
}

function flattenSnapshotNodes(root: BaseSnapshotNode): BaseSnapshotNode[] {
  const nodes: BaseSnapshotNode[] = [];
  const visit = (node: BaseSnapshotNode): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
}

function baseReportForApi(snapshot: BaseSnapshot): CostAmendmentBaseReport {
  return {
    catalogueReleaseId: snapshot.sources.catalogue.releaseId,
    catalogueRevision: snapshot.sources.catalogue.revision,
    parts: flattenSnapshotNodes(snapshot.tree)
      .filter(({ kind }) => kind === "part")
      .map((part) => ({
        id: part.id,
        fullNumber: part.full_number,
        referenceId: part.reference_id,
        name: part.name,
        quantity: part.quantity,
        breakdown: part.breakdown,
      })),
  };
}

async function lockEditableAmendment(
  transaction: TransactionHandle,
  amendmentId: string,
  expectedVersion: number,
): Promise<CostAmendmentRow> {
  const amendment = await transaction.maybeOne<CostAmendmentRow>(
    "SELECT * FROM cost_amendments WHERE id = $1 FOR UPDATE",
    [amendmentId],
  );
  if (!amendment) {
    throw new Error("cost-amendment-not-found");
  }
  if (amendment.status !== "draft") {
    throw new Error("cost-amendment-not-editable");
  }
  if (amendment.version !== expectedVersion) {
    throw new Error("cost-amendment-version-conflict");
  }
  return amendment;
}

async function recalculateAmendment(
  transaction: TransactionHandle,
  amendment: CostAmendmentRow,
  actorUserId: string,
): Promise<CostAmendmentRow> {
  const updated = await transaction.maybeOne<CostAmendmentRow>(
    `
      UPDATE cost_amendments ca
      SET total_additions = totals.additions,
          total_removals = totals.removals,
          net_change = totals.additions - totals.removals,
          snapshot_json = NULL,
          updated_by = $1,
          updated_at = clock_timestamp(),
          version = version + 1
      FROM (
        SELECT
          COALESCE(SUM(subtotal) FILTER (WHERE action = 'add'), 0) AS additions,
          COALESCE(SUM(subtotal) FILTER (WHERE action = 'remove'), 0) AS removals
        FROM cost_amendment_items
        WHERE amendment_id = $2
      ) totals
      WHERE ca.id = $2 AND ca.version = $3
      RETURNING ca.*
    `,
    [actorUserId, amendment.id, amendment.version],
  );
  if (!updated) {
    throw new Error("cost-amendment-version-conflict");
  }
  return updated;
}

async function detailInTransaction(
  transaction: TransactionHandle,
  amendment: CostAmendmentRow,
): Promise<CostAmendmentDetail> {
  return await detailWithExecutor(transaction, amendment);
}

async function detailWithExecutor(
  database: Pick<DatabaseHandle, "query"> | TransactionHandle,
  amendment: CostAmendmentRow,
): Promise<CostAmendmentDetail> {
  const result = await database.query<CostAmendmentItemRow>(
    `
      SELECT *
      FROM cost_amendment_items
      WHERE amendment_id = $1
      ORDER BY sort_order, id
    `,
    [amendment.id],
  );
  const items = result.rows;
  const baseSnapshot = await loadBaseSnapshot(database, amendment);
  const workflowItems: AmendmentWorkflowItem[] = items.map((item) => ({
    id: item.id,
    action: item.action,
    costBox: item.cost_box,
    classification: item.classification,
    changeGroupId: item.change_group_id,
    partIdentity: item.source_json.partIdentity,
    originalQuantity: item.original_quantity,
    revisedQuantity: item.revised_quantity,
  }));
  return {
    amendment,
    items,
    blockers: validateAmendmentWorkflow(workflowItems),
    baseReport: baseReportForApi(baseSnapshot),
  };
}

function positiveDecimal(value: string, field: string): string {
  const result = new Decimal(value);
  if (!result.isFinite() || !result.greaterThan(0)) {
    throw new Error(`invalid-cost-amendment-${field.replaceAll(" ", "-")}`);
  }
  return result.toSignificantDigits(24).toString();
}

function nonNegativeDecimal(value: string, field: string): string {
  const result = new Decimal(value);
  if (!result.isFinite() || result.isNegative()) {
    throw new Error(`invalid-cost-amendment-${field.replaceAll(" ", "-")}`);
  }
  return result.toSignificantDigits(24).toString();
}
