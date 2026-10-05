import {
  verifyAuditLedgerRows,
  type AuditLedgerRow,
} from "../audit/audit-ledger";
import { closeDatabase, getDatabase } from "../db/database";

const database = getDatabase();

try {
  const result = await database.query<AuditLedgerRow>(
    `
      SELECT
        ledger.sequence::text AS sequence, ledger.previous_hash,
        ledger.entry_hash, ledger.actor_user_id, ledger.project_id,
        ledger.request_id, ledger.action, ledger.entity_type, ledger.entity_id,
        ledger.before_json, ledger.after_json, ledger.metadata_json,
        ledger.occurred_at
      FROM audit_ledger ledger
      ORDER BY ledger.sequence
    `,
  );
  const verification = verifyAuditLedgerRows(result.rows);
  if (!verification.ok) {
    process.stderr.write(
      `Audit ledger verification failed after ${verification.checked} entries: ${verification.error}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Audit ledger verified: ${verification.checked} entries, chain intact\n`,
    );
  }
} finally {
  await closeDatabase();
}
