import type { QueryResultRow } from "pg";

import type { DbExecutor } from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";

export interface AuditEntryForApi {
  sequence: string;
  previousHash: string | null;
  entryHash: string;
  actor: {
    id: string;
    displayName: string;
    email: string;
  } | null;
  projectId: string | null;
  requestId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  occurredAt: string;
}

interface AuditEntryQueryRow extends QueryResultRow {
  sequence: string;
  previous_hash: string | null;
  entry_hash: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  project_id: string | null;
  request_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: unknown;
  after_json: unknown;
  metadata_json: unknown;
  occurred_at: string;
}

export async function listProjectAuditEntries(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
  options: { beforeSequence?: string; limit?: number } = {},
): Promise<{
  entries: AuditEntryForApi[];
  nextCursor: string | null;
}> {
  await assertProjectPermission(database, actor, projectId, "read");
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const beforeSequence =
    options.beforeSequence === undefined
      ? null
      : parseSequence(options.beforeSequence);
  const result = await database.query<AuditEntryQueryRow>(
    `
      SELECT
        ledger.sequence::text, ledger.previous_hash, ledger.entry_hash,
        ledger.actor_user_id, actor.display_name AS actor_display_name,
        actor.email AS actor_email, ledger.project_id, ledger.request_id,
        ledger.action, ledger.entity_type, ledger.entity_id,
        ledger.before_json, ledger.after_json, ledger.metadata_json,
        ledger.occurred_at
      FROM audit_ledger ledger
      LEFT JOIN users actor ON actor.id = ledger.actor_user_id
      WHERE ledger.project_id = $1
        AND ($2::bigint IS NULL OR ledger.sequence < $2)
      ORDER BY ledger.sequence DESC
      LIMIT $3
    `,
    [projectId, beforeSequence, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit).map(auditEntryForApi);
  return {
    entries: page,
    nextCursor:
      hasMore && page.length > 0 ? page.at(-1)!.sequence : null,
  };
}

function auditEntryForApi(row: AuditEntryQueryRow): AuditEntryForApi {
  return {
    sequence: row.sequence,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
    actor:
      row.actor_user_id && row.actor_display_name && row.actor_email
        ? {
            id: row.actor_user_id,
            displayName: row.actor_display_name,
            email: row.actor_email,
          }
        : null,
    projectId: row.project_id,
    requestId: row.request_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before_json,
    after: row.after_json,
    metadata: row.metadata_json,
    occurredAt: row.occurred_at,
  };
}

function parseSequence(value: string): string {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) {
      throw new Error("invalid-audit-cursor");
    }
    return parsed.toString();
  } catch {
    throw new Error("invalid-audit-cursor");
  }
}
