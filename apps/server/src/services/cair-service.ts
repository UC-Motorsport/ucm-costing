import { randomUUID } from "node:crypto";

import {
  assertCairTransition,
  type CairState,
} from "@ucm/domain";
import Decimal from "decimal.js";
import type { QueryResultRow } from "pg";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import {
  getAppPaths,
  resolveStoredDataPath,
  type AppPaths,
} from "../config";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import { openVerifiedFile } from "../integrity/file-integrity";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";

export interface CairRequestRow extends QueryResultRow {
  id: string;
  project_id: string;
  cost_line_id: string | null;
  status: CairState;
  requested_catalogue_description: string;
  rationale: string;
  proposed_cost: string | null;
  provenance_json: Record<string, unknown>;
  external_reference: string | null;
  decision_note: string | null;
  resolved_catalogue_release_id: string | null;
  resolved_catalogue_item_id: string | null;
  created_by: string;
  updated_by: string;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  version: number;
}

export interface CairEvidenceAttachment extends QueryResultRow {
  evidence_id: string;
  display_name: string;
  kind: string;
  mime_type: string;
  content_sha256: string;
  byte_size: string | null;
  evidence_version: number;
  attached_by: string;
  attached_by_display_name: string;
  attached_at: string;
  frozen_content_sha256: string | null;
  frozen_byte_size: string | null;
  frozen_evidence_version: number | null;
  frozen_metadata_json: Record<string, unknown> | null;
  frozen_at: string | null;
  download_url: string;
}

export interface CairRequestDetail extends CairRequestRow {
  attachments: CairEvidenceAttachment[];
}

const cairDraftSchema = z.object({
  costLineId: z.string().trim().min(1).nullable().optional(),
  requestedCatalogueDescription: z.string().trim().min(1).max(1_000),
  rationale: z.string().trim().min(1).max(10_000),
  proposedCost: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((value) =>
      value === null || value === undefined || String(value).trim() === ""
        ? null
        : nonNegativeDecimal(String(value), "proposed cost"),
    ),
  provenance: z.record(z.string(), z.unknown()).default({}),
});

const cairTransitionSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  next: z.enum([
    "submitted",
    "catalogue-resolved",
    "rejected",
    "cancelled",
  ]),
  externalReference: z.string().trim().min(1).max(2_000).nullable().optional(),
  decisionNote: z.string().trim().max(10_000).nullable().optional(),
  resolvedCatalogueReleaseId: z.string().trim().min(1).nullable().optional(),
  resolvedCatalogueItemId: z.string().trim().min(1).nullable().optional(),
});

export async function createCairDraft(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  rawInput: unknown,
): Promise<CairRequestRow> {
  const input = cairDraftSchema.parse(rawInput);
  return await database.transaction(async (transaction) => {
    await assertProjectPermission(
      transaction,
      actor,
      projectId,
      "write",
    );
    if (input.costLineId) {
      await assertCostLineBelongsToProject(
        transaction,
        input.costLineId,
        projectId,
      );
    }
    const id = randomUUID();
    const inserted = await transaction.one<CairRequestRow>(
      `
        INSERT INTO cair_requests(
          id, project_id, cost_line_id, status,
          requested_catalogue_description, rationale, proposed_cost,
          provenance_json, created_by, updated_by
        )
        VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7::jsonb, $8, $8)
        RETURNING *
      `,
      [
        id,
        projectId,
        input.costLineId ?? null,
        input.requestedCatalogueDescription,
        input.rationale,
        input.proposedCost,
        JSON.stringify(input.provenance),
        actor.actorUserId,
      ],
    );
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "cair.created",
      entityType: "cair-request",
      entityId: id,
      after: inserted,
    });
    return inserted;
  });
}

export async function updateCairDraft(
  database: DatabaseHandle,
  actor: ActorContext,
  cairId: string,
  rawInput: unknown,
  expectedVersion: number,
): Promise<CairRequestRow> {
  const input = cairDraftSchema.parse(rawInput);
  return await database.transaction(async (transaction) => {
    const current = await lockCair(transaction, cairId);
    await assertProjectPermission(
      transaction,
      actor,
      current.project_id,
      "write",
    );
    if (current.status !== "draft") {
      throw new Error("cair-not-editable");
    }
    if (current.version !== expectedVersion) {
      throw new Error("cair-version-conflict");
    }
    if (input.costLineId) {
      await assertCostLineBelongsToProject(
        transaction,
        input.costLineId,
        current.project_id,
      );
    }
    const updated = await transaction.maybeOne<CairRequestRow>(
      `
        UPDATE cair_requests
        SET cost_line_id = $1,
            requested_catalogue_description = $2,
            rationale = $3,
            proposed_cost = $4,
            provenance_json = $5::jsonb,
            updated_by = $6,
            updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $7 AND version = $8 AND status = 'draft'
        RETURNING *
      `,
      [
        input.costLineId ?? null,
        input.requestedCatalogueDescription,
        input.rationale,
        input.proposedCost,
        JSON.stringify(input.provenance),
        actor.actorUserId,
        cairId,
        expectedVersion,
      ],
    );
    if (!updated) {
      throw new Error("cair-version-conflict");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "cair.updated",
      entityType: "cair-request",
      entityId: cairId,
      before: current,
      after: updated,
    });
    return updated;
  });
}

export async function transitionCair(
  database: DatabaseHandle,
  actor: ActorContext,
  cairId: string,
  rawInput: unknown,
  paths: AppPaths = getAppPaths(),
): Promise<CairRequestDetail> {
  const input = cairTransitionSchema.parse(rawInput);
  return await database.transaction(async (transaction) => {
    const current = await lockCair(transaction, cairId);
    await assertProjectPermission(
      transaction,
      actor,
      current.project_id,
      "write",
    );
    if (current.version !== input.expectedVersion) {
      throw new Error("cair-version-conflict");
    }
    assertCairTransition({
      current: current.status,
      next: input.next,
      externalReference: input.externalReference,
      resolvingCatalogueReleaseId: input.resolvedCatalogueReleaseId,
      resolvingCatalogueItemId: input.resolvedCatalogueItemId,
    });
    if (
      input.next === "rejected" &&
      (!input.externalReference?.trim() || !input.decisionNote?.trim())
    ) {
      throw new Error("cair-rejection-evidence-required");
    }
    if (input.next === "catalogue-resolved") {
      await assertOfficialCatalogueResolution(
        transaction,
        input.resolvedCatalogueReleaseId!,
        input.resolvedCatalogueItemId!,
      );
    }
    let frozenAttachments: CairEvidenceAttachment[] = [];
    if (input.next === "submitted") {
      const evidenceSources = await transaction.query<{
        evidence_id: string;
        content_sha256: string;
        byte_size: string | null;
        storage_path: string;
      }>(
        `
          SELECT
            ce.evidence_id,
            e.content_sha256,
            e.byte_size::text,
            e.storage_path
          FROM cair_evidence ce
          JOIN evidence e ON e.id = ce.evidence_id
          WHERE ce.cair_id = $1
          ORDER BY ce.evidence_id
          FOR SHARE OF e
        `,
        [cairId],
      );
      for (const evidence of evidenceSources.rows) {
        if (evidence.byte_size === null) {
          throw new Error("cair-evidence-byte-size-unavailable");
        }
        const verified = await openVerifiedFile(
          resolveStoredDataPath(evidence.storage_path, paths),
          evidence.content_sha256,
        );
        try {
          if (verified.stats.size !== Number(evidence.byte_size)) {
            throw new Error("cair-evidence-byte-size-mismatch");
          }
        } finally {
          await verified.handle.close();
        }
      }
      await transaction.query(
        `
          UPDATE cair_evidence ce
          SET frozen_content_sha256 = e.content_sha256,
              frozen_byte_size = e.byte_size,
              frozen_evidence_version = e.version,
              frozen_metadata_json = jsonb_build_object(
                'evidenceId', e.id,
                'displayName', e.display_name,
                'kind', e.kind,
                'mimeType', e.mime_type,
                'visibility', e.visibility,
                'reportCaption', e.report_caption
              ),
              frozen_at = clock_timestamp()
          FROM evidence e
          WHERE ce.cair_id = $1
            AND e.id = ce.evidence_id
            AND ce.frozen_at IS NULL
        `,
        [cairId],
      );
      frozenAttachments = await listCairEvidence(
        transaction,
        [cairId],
      );
    }

    const terminal =
      input.next === "catalogue-resolved" || input.next === "rejected";
    const submitted = input.next === "submitted";
    const updated = await transaction.maybeOne<CairRequestRow>(
      `
        UPDATE cair_requests
        SET status = $1,
            external_reference = CASE
              WHEN $2::text IS NULL THEN external_reference
              ELSE $2
            END,
            decision_note = $3,
            resolved_catalogue_release_id = $4,
            resolved_catalogue_item_id = $5,
            updated_by = $6,
            decided_by = CASE WHEN $7 THEN $6 ELSE NULL END,
            submitted_at = CASE
              WHEN $8 THEN clock_timestamp()
              ELSE submitted_at
            END,
            decided_at = CASE
              WHEN $7 THEN clock_timestamp()
              ELSE NULL
            END,
            updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $9 AND version = $10
        RETURNING *
      `,
      [
        input.next,
        input.externalReference ?? null,
        input.decisionNote ?? null,
        input.resolvedCatalogueReleaseId ?? null,
        input.resolvedCatalogueItemId ?? null,
        actor.actorUserId,
        terminal,
        submitted,
        cairId,
        input.expectedVersion,
      ],
    );
    if (!updated) {
      throw new Error("cair-version-conflict");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: `cair.${input.next}`,
      entityType: "cair-request",
      entityId: cairId,
      before: current,
      after: updated,
      metadata: {
        authority:
          input.next === "catalogue-resolved"
            ? "official-catalogue-release"
            : "external-request-trail",
        frozenEvidence:
          input.next === "submitted"
            ? frozenAttachments.map(frozenAttachmentForAudit)
            : undefined,
      },
    });
    return await cairDetail(transaction, updated);
  });
}

export async function attachCairEvidence(
  database: DatabaseHandle,
  actor: ActorContext,
  cairId: string,
  evidenceId: string,
  expectedVersion: number,
): Promise<CairRequestDetail> {
  return await database.transaction(async (transaction) => {
    const current = await lockCair(transaction, cairId);
    await assertProjectPermission(
      transaction,
      actor,
      current.project_id,
      "write",
    );
    if (current.version !== expectedVersion) {
      throw new Error("cair-version-conflict");
    }
    if (current.status !== "draft") {
      throw new Error("cair-evidence-not-editable");
    }
    const evidence = await transaction.maybeOne<{
      id: string;
      content_sha256: string;
      byte_size: string | null;
      version: number;
    }>(
      `
        SELECT id, content_sha256, byte_size::text, version
        FROM evidence
        WHERE id = $1 AND project_id = $2
      `,
      [evidenceId, current.project_id],
    );
    if (!evidence) {
      throw new Error("cair-evidence-not-found");
    }
    const attached = await transaction.query(
      `
        INSERT INTO cair_evidence(
          cair_id, evidence_id, attached_by, attached_at
        )
        VALUES ($1, $2, $3, clock_timestamp())
        ON CONFLICT DO NOTHING
        RETURNING evidence_id
      `,
      [cairId, evidenceId, actor.actorUserId],
    );
    if (attached.rowCount !== 1) {
      throw new Error("cair-evidence-already-attached");
    }
    const updated = await transaction.maybeOne<CairRequestRow>(
      `
        UPDATE cair_requests
        SET updated_by = $1, updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $2 AND version = $3
        RETURNING *
      `,
      [actor.actorUserId, cairId, expectedVersion],
    );
    if (!updated) {
      throw new Error("cair-version-conflict");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "cair.evidence-attached",
      entityType: "cair-request",
      entityId: cairId,
      before: current,
      after: updated,
      metadata: {
        evidenceId,
        contentSha256: evidence.content_sha256,
        byteSize: evidence.byte_size,
        evidenceVersion: evidence.version,
      },
    });
    return await cairDetail(transaction, updated);
  });
}

export async function detachCairEvidence(
  database: DatabaseHandle,
  actor: ActorContext,
  cairId: string,
  evidenceId: string,
  expectedVersion: number,
): Promise<CairRequestDetail> {
  return await database.transaction(async (transaction) => {
    const current = await lockCair(transaction, cairId);
    await assertProjectPermission(
      transaction,
      actor,
      current.project_id,
      "write",
    );
    if (current.version !== expectedVersion) {
      throw new Error("cair-version-conflict");
    }
    if (current.status !== "draft") {
      throw new Error("cair-evidence-not-editable");
    }
    const detached = await transaction.query(
      `
        DELETE FROM cair_evidence
        WHERE cair_id = $1 AND evidence_id = $2
        RETURNING evidence_id
      `,
      [cairId, evidenceId],
    );
    if (detached.rowCount !== 1) {
      throw new Error("cair-evidence-not-found");
    }
    const updated = await transaction.maybeOne<CairRequestRow>(
      `
        UPDATE cair_requests
        SET updated_by = $1, updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $2 AND version = $3 AND status = 'draft'
        RETURNING *
      `,
      [actor.actorUserId, cairId, expectedVersion],
    );
    if (!updated) {
      throw new Error("cair-version-conflict");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "cair.evidence-detached",
      entityType: "cair-request",
      entityId: cairId,
      before: current,
      after: updated,
      metadata: { evidenceId },
    });
    return await cairDetail(transaction, updated);
  });
}

export async function getCair(
  database: DatabaseHandle,
  actor: ActorContext,
  cairId: string,
): Promise<CairRequestDetail | null> {
  const cair = await database.maybeOne<CairRequestRow>(
    "SELECT * FROM cair_requests WHERE id = $1",
    [cairId],
  );
  if (cair) {
    await assertProjectPermission(
      database,
      actor,
      cair.project_id,
      "read",
    );
  }
  return cair ? await cairDetail(database, cair) : null;
}

export async function listCairs(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  limit = 100,
  offset = 0,
): Promise<CairRequestDetail[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid-cair-pagination");
  }
  await assertProjectPermission(
    database,
    actor,
    projectId,
    "read",
  );
  const result = await database.query<CairRequestRow>(
    `
      SELECT *
      FROM cair_requests
      WHERE project_id = $1
      ORDER BY updated_at DESC, id
      LIMIT $2 OFFSET $3
    `,
    [projectId, limit, offset],
  );
  return await cairDetails(database, result.rows);
}

export function cairClearsReadiness(
  cair: CairRequestRow,
): boolean {
  return (
    cair.status === "catalogue-resolved" &&
    cair.resolved_catalogue_release_id !== null &&
    cair.resolved_catalogue_item_id !== null
  );
}

async function lockCair(
  transaction: TransactionHandle,
  cairId: string,
): Promise<CairRequestRow> {
  const row = await transaction.maybeOne<CairRequestRow>(
    "SELECT * FROM cair_requests WHERE id = $1 FOR UPDATE",
    [cairId],
  );
  if (!row) {
    throw new Error("cair-not-found");
  }
  return row;
}

async function cairDetail(
  database: DbExecutor,
  cair: CairRequestRow,
): Promise<CairRequestDetail> {
  const attachments = await listCairEvidence(database, [cair.id]);
  return { ...cair, attachments };
}

async function cairDetails(
  database: DbExecutor,
  cairs: readonly CairRequestRow[],
): Promise<CairRequestDetail[]> {
  if (cairs.length === 0) {
    return [];
  }
  const attachments = await listCairEvidence(
    database,
    cairs.map(({ id }) => id),
  );
  const byCair = new Map<string, CairEvidenceAttachment[]>();
  for (const attachment of attachments) {
    const cairId = String(attachment.cair_id);
    const group = byCair.get(cairId) ?? [];
    group.push(attachment);
    byCair.set(cairId, group);
  }
  return cairs.map((cair) => ({
    ...cair,
    attachments: byCair.get(cair.id) ?? [],
  }));
}

async function listCairEvidence(
  database: DbExecutor,
  cairIds: readonly string[],
): Promise<Array<CairEvidenceAttachment & { cair_id: string }>> {
  if (cairIds.length === 0) {
    return [];
  }
  const result = await database.query<
    CairEvidenceAttachment & { cair_id: string }
  >(
    `
      SELECT
        ce.cair_id,
        ce.evidence_id,
        e.display_name,
        e.kind,
        e.mime_type,
        e.content_sha256,
        e.byte_size::text,
        e.version AS evidence_version,
        ce.attached_by,
        attached_by.display_name AS attached_by_display_name,
        ce.attached_at,
        ce.frozen_content_sha256,
        ce.frozen_byte_size::text,
        ce.frozen_evidence_version,
        ce.frozen_metadata_json,
        ce.frozen_at
      FROM cair_evidence ce
      JOIN evidence e ON e.id = ce.evidence_id
      JOIN users attached_by ON attached_by.id = ce.attached_by
      WHERE ce.cair_id = ANY($1::text[])
      ORDER BY ce.attached_at, ce.evidence_id
    `,
    [cairIds],
  );
  return result.rows.map((row) => ({
    ...row,
    download_url: `/api/evidence/${row.evidence_id}/download`,
  }));
}

function frozenAttachmentForAudit(
  attachment: CairEvidenceAttachment,
): Record<string, unknown> {
  return {
    evidenceId: attachment.evidence_id,
    contentSha256: attachment.frozen_content_sha256,
    byteSize: attachment.frozen_byte_size,
    evidenceVersion: attachment.frozen_evidence_version,
    metadata: attachment.frozen_metadata_json,
    frozenAt: attachment.frozen_at,
  };
}

async function assertCostLineBelongsToProject(
  transaction: TransactionHandle,
  costLineId: string,
  projectId: string,
): Promise<void> {
  const line = await transaction.maybeOne<{ id: string }>(
    `
      SELECT cl.id
      FROM cost_lines cl
      JOIN cost_nodes cn ON cn.id = cl.node_id
      WHERE cl.id = $1 AND cn.project_id = $2
    `,
    [costLineId, projectId],
  );
  if (!line) {
    throw new Error("cair-cost-line-not-found");
  }
}

async function assertOfficialCatalogueResolution(
  transaction: TransactionHandle,
  releaseId: string,
  itemId: string,
): Promise<void> {
  const item = await transaction.maybeOne<{ id: string }>(
    `
      SELECT ci.id
      FROM catalogue_items ci
      JOIN catalogue_releases cr ON cr.id = ci.release_id
      JOIN source_documents sd ON sd.id = cr.source_document_id
      WHERE ci.id = $1 AND ci.release_id = $2
        AND sd.kind = 'governing-catalogue'
    `,
    [itemId, releaseId],
  );
  if (!item) {
    throw new Error("cair-official-catalogue-item-not-found");
  }
}

function nonNegativeDecimal(value: string, field: string): string {
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.isNegative()) {
      throw new Error();
    }
    return decimal.toSignificantDigits(24).toString();
  } catch {
    throw new Error(
      field === "proposed cost"
        ? "invalid-cair-proposed-cost"
        : "invalid-cair-decimal",
    );
  }
}
