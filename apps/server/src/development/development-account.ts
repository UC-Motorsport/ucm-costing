import { randomUUID } from "node:crypto";

import { appendAuditEntry } from "../audit/audit-ledger";
import type { DatabaseHandle } from "../db/database";
import type { AuthUser } from "../security/auth-service";

export const DEVELOPMENT_LOGIN = Object.freeze({
  email: "test@localhost.invalid",
  displayName: "Test Administrator",
});

export interface DevelopmentAccountResult {
  created: boolean;
  reconciled: boolean;
  user: AuthUser;
}

export function assertDevelopmentAccountEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.NODE_ENV === "production" ||
    environment.UCM_ENABLE_DEVELOPMENT_ACCOUNT !== "true"
  ) {
    throw new Error("development-account-seed-disabled");
  }
}

export async function ensureDevelopmentAdministrator(
  database: DatabaseHandle,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DevelopmentAccountResult> {
  assertDevelopmentAccountEnabled(environment);
  const requestId = `development-account-seed:${randomUUID()}`;

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext('ucm:development-account-seed'))",
    );
    const existing = await transaction.maybeOne<AuthUser>(
      `
        SELECT id, email, display_name, role, status,
               created_at, updated_at, version
        FROM users
        WHERE lower(email) = lower($1)
        FOR UPDATE
      `,
      [DEVELOPMENT_LOGIN.email],
    );

    if (!existing) {
      const inserted = await transaction.one<AuthUser>(
        `
          INSERT INTO users(
            id, email, display_name, role, status,
            created_at, updated_at, version
          )
          VALUES ($1, $2, $3, 'admin', 'active', now(), now(), 0)
          RETURNING id, email, display_name, role, status,
                    created_at, updated_at, version
        `,
        [
          randomUUID(),
          DEVELOPMENT_LOGIN.email,
          DEVELOPMENT_LOGIN.displayName,
        ],
      );
      const user = inserted;
      await appendAuditEntry(
        transaction,
        { actorUserId: null, requestId },
        {
          action: "user.development-seeded",
          entityType: "user",
          entityId: user.id,
          after: publicUserState(user),
          metadata: { developmentOnly: true },
        },
      );
      return { created: true, reconciled: false, user };
    }

    const alreadyCurrent =
      existing.display_name === DEVELOPMENT_LOGIN.displayName &&
      existing.role === "admin" &&
      existing.status === "active";
    if (alreadyCurrent) {
      return {
        created: false,
        reconciled: false,
        user: existing,
      };
    }

    const before = existing;
    const updated = await transaction.one<AuthUser>(
      `
        UPDATE users
        SET display_name = $2,
            role = 'admin',
            status = 'active',
            updated_at = now(),
            version = version + 1
        WHERE id = $1
        RETURNING id, email, display_name, role, status,
                  created_at, updated_at, version
      `,
      [existing.id, DEVELOPMENT_LOGIN.displayName],
    );
    await transaction.query(
      `
        UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE user_id = $1 AND revoked_at IS NULL
      `,
      [existing.id],
    );
    const user = updated;
    await appendAuditEntry(
      transaction,
      { actorUserId: null, requestId },
      {
        action: "user.development-reconciled",
        entityType: "user",
        entityId: user.id,
        before: publicUserState(before),
        after: publicUserState(user),
        metadata: { developmentOnly: true },
      },
    );
    return { created: false, reconciled: true, user };
  });
}

function publicUserState(user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    version: user.version,
  };
}
