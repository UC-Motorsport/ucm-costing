import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { Queryable } from "../db/database";
import { canonicalJson } from "../security/canonical-json";

export interface AuditContext {
  actorUserId: string | null;
  requestId: string;
  ipAddressHash?: string | null;
  userAgent?: string | null;
}

export interface AuditMutation {
  projectId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditLedgerRow extends QueryResultRow {
  sequence: string | number;
  previous_hash: string | null;
  entry_hash: string;
  actor_user_id: string | null;
  project_id: string | null;
  request_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: unknown;
  after_json: unknown;
  metadata_json: unknown;
  occurred_at: Date | string;
}

export type AuditQueryable = Queryable;

export async function appendAuditEntry(
  transaction: AuditQueryable,
  context: AuditContext,
  mutation: AuditMutation,
): Promise<AuditLedgerRow> {
  assertAuditContext(context);
  assertMutation(mutation);

  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtext('ucm:audit-ledger'))",
  );
  const previousResult = await transaction.query<{ entry_hash: string }>(
    `
      SELECT entry_hash
      FROM audit_ledger
      ORDER BY sequence DESC
      LIMIT 1
    `,
  );
  const reservation = await transaction.query<{
    sequence: string;
    occurred_at: Date | string;
  }>(
    `
      SELECT
        nextval('audit_ledger_sequence_seq')::text AS sequence,
        clock_timestamp() AS occurred_at
    `,
  );
  const reserved = reservation.rows[0];
  if (!reserved) {
    throw new Error("audit-ledger-sequence-reservation-failed");
  }

  const previousHash = previousResult.rows[0]?.entry_hash ?? null;
  const metadata = {
    ...(mutation.metadata ?? {}),
    ipAddressHash: context.ipAddressHash ?? null,
    userAgent: context.userAgent ?? null,
  };
  const rowWithoutHash = {
    sequence: reserved.sequence,
    previousHash,
    actorUserId: context.actorUserId,
    projectId: mutation.projectId ?? null,
    requestId: context.requestId,
    action: mutation.action,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    before: mutation.before ?? null,
    after: mutation.after ?? null,
    metadata,
    occurredAt: toIsoTimestamp(reserved.occurred_at),
  };
  const entryHash = computeAuditEntryHash(rowWithoutHash);

  const inserted = await transaction.query<AuditLedgerRow>(
    `
      INSERT INTO audit_ledger(
        sequence, previous_hash, entry_hash, actor_user_id, project_id,
        request_id, action, entity_type, entity_id, before_json, after_json,
        metadata_json, occurred_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10::jsonb, $11::jsonb,
        $12::jsonb, $13::timestamptz
      )
      RETURNING *
    `,
    [
      reserved.sequence,
      previousHash,
      entryHash,
      context.actorUserId,
      mutation.projectId ?? null,
      context.requestId,
      mutation.action,
      mutation.entityType,
      mutation.entityId,
      canonicalJson(mutation.before ?? null),
      canonicalJson(mutation.after ?? null),
      canonicalJson(metadata),
      rowWithoutHash.occurredAt,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("audit-ledger-insert-failed");
  }
  return row;
}

export function computeAuditEntryHash(input: {
  sequence: string | number;
  previousHash: string | null;
  actorUserId: string | null;
  projectId: string | null;
  requestId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  occurredAt: Date | string;
}): string {
  const canonical = canonicalJson({
    sequence: String(input.sequence),
    previousHash: input.previousHash,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    requestId: input.requestId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    metadata: input.metadata,
    occurredAt: toIsoTimestamp(input.occurredAt),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function verifyAuditLedgerRows(rows: readonly AuditLedgerRow[]): {
  ok: boolean;
  checked: number;
  error: string | null;
} {
  let previousHash: string | null = null;
  let previousSequence = 0n;

  for (const row of rows) {
    const sequence = BigInt(row.sequence);
    if (sequence <= previousSequence) {
      return {
        ok: false,
        checked: Number(previousSequence),
        error: `audit-ledger-sequence-out-of-order:${sequence}`,
      };
    }
    if (row.previous_hash !== previousHash) {
      return {
        ok: false,
        checked: Number(previousSequence),
        error: `audit-ledger-previous-hash-mismatch:${sequence}`,
      };
    }
    const expectedHash = computeAuditEntryHash({
      sequence: row.sequence,
      previousHash: row.previous_hash,
      actorUserId: row.actor_user_id,
      projectId: row.project_id,
      requestId: row.request_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before_json,
      after: row.after_json,
      metadata: row.metadata_json,
      occurredAt: row.occurred_at,
    });
    if (row.entry_hash !== expectedHash) {
      return {
        ok: false,
        checked: Number(previousSequence),
        error: `audit-ledger-entry-hash-mismatch:${sequence}`,
      };
    }
    previousHash = row.entry_hash;
    previousSequence = sequence;
  }

  return { ok: true, checked: rows.length, error: null };
}

function assertAuditContext(context: AuditContext): void {
  if (!context.requestId.trim()) {
    throw new Error("audit-request-id-required");
  }
}

function assertMutation(mutation: AuditMutation): void {
  if (
    !mutation.action.trim() ||
    !mutation.entityType.trim() ||
    !mutation.entityId.trim()
  ) {
    throw new Error("audit-mutation-identity-required");
  }
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("audit-invalid-timestamp");
  }
  return date.toISOString();
}
