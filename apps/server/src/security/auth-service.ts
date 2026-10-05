import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import {
  appendAuditEntry,
  type AuditContext,
  type AuditQueryable,
} from "../audit/audit-ledger";
import {
  digestSharedAccessKey as digestAccessKey,
  verifySharedAccessKey as verifyAccessKey,
} from "./shared-access-key";
import { createOpaqueToken, digestOpaqueToken } from "./tokens";

export type SystemRole = "admin" | "editor" | "viewer";
export type UserStatus = "invited" | "active" | "disabled";

export interface AuthUser extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  role: SystemRole;
  status: UserStatus;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export interface AuthenticatedSession {
  sessionId: string;
  expiresAt: Date | string;
  user: AuthUser;
}

export type AuthTransaction = AuditQueryable;

export interface AuthDatabase extends AuthTransaction {
  transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T>;
}

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const SHARED_ACCESS_KEY_METADATA_KEY =
  "security.shared-access-key-fingerprint.v1";
const VIEWER_ACCESS_KEY_METADATA_KEY =
  "security.viewer-access-key-fingerprint.v1";
const ADMIN_ACCESS_KEY_METADATA_KEY =
  "security.admin-access-key-fingerprint.v1";

export interface RoleAccessKeys {
  sharedAccessKey: string;
  viewerAccessKey: string;
  adminAccessKey: string;
}

export interface AccessKeyReconciliation {
  initialized: boolean;
  rotated: boolean;
  revokedSessions: number;
}

export interface AccessKeysReconciliation {
  shared: AccessKeyReconciliation;
  viewer: AccessKeyReconciliation;
  admin: AccessKeyReconciliation;
  revokedSessions: number;
}

export async function reconcileAccessKeys(
  database: AuthDatabase,
  accessKeys: RoleAccessKeys,
): Promise<AccessKeysReconciliation> {
  const requestId = `access-key-reconciliation:${randomUUID()}`;

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext('ucm:shared-access-key'))",
    );
    const shared = await reconcileAccessKey(transaction, requestId, {
      metadataKey: SHARED_ACCESS_KEY_METADATA_KEY,
      configuredKey: accessKeys.sharedAccessKey,
      credentialClass: "shared",
      rolePredicate: "u.role = 'editor'",
    });
    const viewer = await reconcileAccessKey(transaction, requestId, {
      metadataKey: VIEWER_ACCESS_KEY_METADATA_KEY,
      configuredKey: accessKeys.viewerAccessKey,
      credentialClass: "viewer",
      rolePredicate: "u.role = 'viewer'",
    });
    const admin = await reconcileAccessKey(transaction, requestId, {
      metadataKey: ADMIN_ACCESS_KEY_METADATA_KEY,
      configuredKey: accessKeys.adminAccessKey,
      credentialClass: "admin",
      rolePredicate: "u.role = 'admin'",
    });
    return {
      shared,
      viewer,
      admin,
      revokedSessions:
        shared.revokedSessions +
        viewer.revokedSessions +
        admin.revokedSessions,
    };
  });
}

async function reconcileAccessKey(
  transaction: AuthTransaction,
  requestId: string,
  options: {
    metadataKey: string;
    configuredKey: string;
    credentialClass: "shared" | "viewer" | "admin";
    rolePredicate:
      | "u.role = 'editor'"
      | "u.role = 'viewer'"
      | "u.role = 'admin'";
  },
): Promise<AccessKeyReconciliation> {
  const fingerprint = digestAccessKey(options.configuredKey);
  const existing = await transaction.maybeOne<{ value: string }>(
    `
      SELECT value
      FROM app_metadata
      WHERE key = $1
      FOR UPDATE
    `,
    [options.metadataKey],
  );
  if (existing?.value === fingerprint) {
    return {
      initialized: false,
      rotated: false,
      revokedSessions: 0,
    };
  }

  const revoked = await transaction.query<{ id: string }>(
    `
      UPDATE sessions AS s
      SET revoked_at = COALESCE(s.revoked_at, clock_timestamp())
      FROM users AS u
      WHERE s.user_id = u.id
        AND s.revoked_at IS NULL
        AND ${options.rolePredicate}
      RETURNING s.id
    `,
  );
  await transaction.query(
    `
      INSERT INTO app_metadata(key, value, updated_at)
      VALUES ($1, $2, clock_timestamp())
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
    `,
    [options.metadataKey, fingerprint],
  );
  const initialized = existing === null;
  await appendAuditEntry(
    transaction,
    { actorUserId: null, requestId },
    {
      action: initialized
        ? "authentication.access-key-initialized"
        : "authentication.access-key-rotated",
      entityType: "authentication",
      entityId: `${options.credentialClass}-access-key`,
      metadata: {
        credentialClass: options.credentialClass,
        revokedSessions: revoked.rows.length,
      },
    },
  );
  return {
    initialized,
    rotated: !initialized,
    revokedSessions: revoked.rows.length,
  };
}

export async function bootstrapAdministrator(
  database: AuthDatabase,
  input: { email: string; displayName: string },
): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  const context: AuditContext = {
    actorUserId: null,
    requestId: `bootstrap:${randomUUID()}`,
  };

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext('ucm:bootstrap-administrator'))",
    );
    const existing = await transaction.query<AuthUser>(
      "SELECT * FROM users ORDER BY created_at LIMIT 1",
    );
    if (existing.rows.length > 0) {
      throw new Error("bootstrap-admin-already-exists");
    }

    const inserted = await transaction.query<AuthUser>(
      `
        INSERT INTO users(
          id, email, display_name, role, status,
          created_at, updated_at, version
        )
        VALUES ($1, $2, $3, 'admin', 'active', now(), now(), 0)
        RETURNING id, email, display_name, role, status,
                  created_at, updated_at, version
      `,
      [randomUUID(), email, requireDisplayName(input.displayName)],
    );
    const user = requiredFirst(inserted.rows, "bootstrap-admin-insert-failed");
    await appendAuditEntry(transaction, context, {
      action: "user.bootstrapped",
      entityType: "user",
      entityId: user.id,
      after: publicUserState(user),
      metadata: { authentication: "admin-access-key" },
    });
    return user;
  });
}

export async function createUser(
  database: AuthDatabase,
  context: AuditContext,
  input: {
    email: string;
    displayName: string;
    role: SystemRole;
  },
): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  const displayName = requireDisplayName(input.displayName);

  return database.transaction(async (transaction) => {
    const inserted = await transaction.query<AuthUser>(
      `
        INSERT INTO users(
          id, email, display_name, role, status,
          created_at, updated_at, version
        )
        VALUES ($1, $2, $3, $4, 'active', now(), now(), 0)
        RETURNING id, email, display_name, role, status,
                  created_at, updated_at, version
      `,
      [randomUUID(), email, displayName, input.role],
    );
    const created = requiredFirst(inserted.rows, "user-create-failed");
    await appendAuditEntry(transaction, context, {
      action: "user.created",
      entityType: "user",
      entityId: created.id,
      after: publicUserState(created),
      metadata: {
        authentication:
          created.role === "admin"
            ? "admin-access-key"
            : created.role === "viewer"
              ? "viewer-access-key"
              : "shared-access-key",
      },
    });
    return created;
  });
}

export async function loginWithAccessKey(
  database: AuthDatabase,
  context: Omit<AuditContext, "actorUserId">,
  input: {
    email: string;
    key: string;
    sessionLifetimeMs?: number;
  } & RoleAccessKeys,
): Promise<{ token: string; session: AuthenticatedSession }> {
  const email = normalizeEmail(input.email);
  const result = await database.query<AuthUser>(
    `
      SELECT id, email, display_name, role, status,
             created_at, updated_at, version
      FROM users
      WHERE lower(email) = $1
      LIMIT 1
    `,
    [email],
  );
  const candidate = result.rows[0];
  // All comparisons execute for every candidate so credential failures do not
  // expose which role owns an email through this code path.
  const sharedKeyMatches = verifyAccessKey(input.key, input.sharedAccessKey);
  const viewerKeyMatches = verifyAccessKey(input.key, input.viewerAccessKey);
  const adminKeyMatches = verifyAccessKey(input.key, input.adminAccessKey);
  const keyMatches =
    candidate?.role === "admin"
      ? adminKeyMatches
      : candidate?.role === "viewer"
        ? viewerKeyMatches
        : sharedKeyMatches;
  if (
    !candidate ||
    candidate.status !== "active" ||
    !keyMatches
  ) {
    throw new Error("invalid-credentials");
  }

  const lifetimeMs = input.sessionLifetimeMs ?? SESSION_LIFETIME_MS;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 5 * 60 * 1_000 ||
    lifetimeMs > 7 * 24 * 60 * 60 * 1_000
  ) {
    throw new Error("invalid-session-lifetime");
  }
  const token = createOpaqueToken();
  const tokenDigest = digestOpaqueToken(token);
  const configuredAccessKey = accessKeyForRole(candidate.role, input);
  const accessKeyFingerprint = digestAccessKey(configuredAccessKey);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();

  const session = await database.transaction(async (transaction) => {
    const stillActive = await transaction.maybeOne<{ id: string }>(
      `
        SELECT id
        FROM users
        WHERE id = $1 AND status = 'active' AND version = $2
        FOR SHARE
      `,
      [candidate.id, candidate.version],
    );
    if (!stillActive) {
      throw new Error("invalid-credentials");
    }
    const inserted = await transaction.query<{
      id: string;
      expires_at: Date | string;
    }>(
      `
        INSERT INTO sessions(
          id, user_id, token_digest, expires_at, created_at, last_seen_at,
          user_agent, ip_address_hash, access_key_fingerprint
        )
        VALUES ($1, $2, $3, $4::timestamptz, now(), now(), $5, $6, $7)
        RETURNING id, expires_at
      `,
      [
        sessionId,
        candidate.id,
        tokenDigest,
        expiresAt,
        context.userAgent ?? null,
        context.ipAddressHash ?? null,
        accessKeyFingerprint,
      ],
    );
    const created = requiredFirst(inserted.rows, "session-create-failed");
    await appendAuditEntry(
      transaction,
      { ...context, actorUserId: candidate.id },
      {
        action: "session.created",
        entityType: "session",
        entityId: created.id,
        after: { expiresAt: toIso(created.expires_at) },
        metadata: {
          authentication:
            candidate.role === "admin"
              ? "admin-access-key"
              : candidate.role === "viewer"
                ? "viewer-access-key"
                : "shared-access-key",
        },
      },
    );
    return {
      sessionId: created.id,
      expiresAt: created.expires_at,
      user: candidate,
    };
  });

  return { token, session };
}

export async function authenticateSession(
  database: AuthDatabase,
  token: string,
  accessKeys: RoleAccessKeys,
): Promise<AuthenticatedSession | null> {
  const tokenDigest = digestOpaqueToken(token);
  const adminKeyFingerprint = digestAccessKey(accessKeys.adminAccessKey);
  const viewerKeyFingerprint = digestAccessKey(accessKeys.viewerAccessKey);
  const sharedKeyFingerprint = digestAccessKey(accessKeys.sharedAccessKey);
  const result = await database.query<
    AuthUser & { session_id: string; expires_at: Date | string }
  >(
    `
      SELECT
        s.id AS session_id, s.expires_at,
        u.id, u.email, u.display_name, u.role, u.status,
        u.created_at, u.updated_at, u.version
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_digest = $1
        AND s.access_key_fingerprint = CASE
          WHEN u.role = 'admin' THEN $2
          WHEN u.role = 'viewer' THEN $3
          ELSE $4
        END
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'
      LIMIT 1
    `,
    [
      tokenDigest,
      adminKeyFingerprint,
      viewerKeyFingerprint,
      sharedKeyFingerprint,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  void database
    .query(
      `
        UPDATE sessions
        SET last_seen_at = now()
        WHERE id = $1
          AND last_seen_at < now() - interval '5 minutes'
      `,
      [row.session_id],
    )
    .catch(() => {
      // Session authentication remains valid if this best-effort timestamp fails.
    });
  const { session_id: sessionId, expires_at: expiresAt, ...user } = row;
  return { sessionId, expiresAt, user };
}

export async function revokeSession(
  database: AuthDatabase,
  context: AuditContext,
  sessionId: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const revoked = await transaction.query<{ id: string }>(
      `
        UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1
        RETURNING id
      `,
      [sessionId],
    );
    if (revoked.rows.length === 0) {
      return;
    }
    await appendAuditEntry(transaction, context, {
      action: "session.revoked",
      entityType: "session",
      entityId: sessionId,
      after: { revoked: true },
    });
  });
}

export async function listUsers(database: AuthDatabase): Promise<AuthUser[]> {
  const result = await database.query<AuthUser>(
    `
      SELECT id, email, display_name, role, status,
             created_at, updated_at, version
      FROM users
      ORDER BY lower(display_name), lower(email)
    `,
  );
  return result.rows;
}

export async function updateUserAccess(
  database: AuthDatabase,
  context: AuditContext,
  userId: string,
  input: {
    expectedVersion: number;
    displayName?: string;
    role?: SystemRole;
    status?: Extract<UserStatus, "active" | "disabled">;
  },
): Promise<AuthUser> {
  return database.transaction(async (transaction) => {
    // Serialize the two availability invariants with user and membership
    // administration. This prevents concurrent demotions/disables from
    // independently observing a different administrator or project owner.
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext('ucm:active-admin-invariant'))",
    );
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext('ucm:active-owner-invariant'))",
    );
    const currentResult = await transaction.query<AuthUser>(
      `
        SELECT id, email, display_name, role, status,
               created_at, updated_at, version
        FROM users
        WHERE id = $1
        FOR UPDATE
      `,
      [userId],
    );
    const current = requiredFirst(currentResult.rows, "user-not-found");
    if (current.version !== input.expectedVersion) {
      throw new Error("version-conflict");
    }
    const nextDisplayName =
      input.displayName === undefined
        ? current.display_name
        : requireDisplayName(input.displayName);
    const nextRole = input.role ?? current.role;
    const nextStatus = input.status ?? current.status;
    if (nextStatus === "invited") {
      throw new Error("invalid-user-status-transition");
    }
    if (
      current.role === "admin" &&
      current.status === "active" &&
      (nextRole !== "admin" || nextStatus !== "active")
    ) {
      const otherAdministrator = await transaction.maybeOne<{
        id: string;
      }>(
        `
          SELECT id
          FROM users
          WHERE role = 'admin' AND status = 'active' AND id <> $1
          ORDER BY id
          LIMIT 1
          FOR UPDATE
        `,
        [userId],
      );
      if (!otherAdministrator) {
        throw new Error("last-active-admin-required");
      }
    }
    const updatedResult = await transaction.query<AuthUser>(
      `
        UPDATE users
        SET display_name = $1, role = $2, status = $3,
            version = version + 1, updated_at = now()
        WHERE id = $4 AND version = $5
        RETURNING id, email, display_name, role, status,
                  created_at, updated_at, version
      `,
      [
        nextDisplayName,
        nextRole,
        nextStatus,
        userId,
        input.expectedVersion,
      ],
    );
    const updated = requiredFirst(updatedResult.rows, "version-conflict");
    const accessKeyClassChanged = current.role !== nextRole;
    if (nextStatus === "disabled" || accessKeyClassChanged) {
      await transaction.query(
        `
          UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE user_id = $1 AND revoked_at IS NULL
        `,
        [userId],
      );
    }
    await appendAuditEntry(transaction, context, {
      action: "user.access-updated",
      entityType: "user",
      entityId: userId,
      before: publicUserState(current),
      after: publicUserState(updated),
    });
    return updated;
  });
}

export async function revokeAllUserSessions(
  database: AuthDatabase,
  context: AuditContext,
  userId: string,
): Promise<number> {
  return database.transaction(async (transaction) => {
    const user = await transaction.maybeOne<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!user) {
      throw new Error("user-not-found");
    }
    const revoked = await transaction.query<{ id: string }>(
      `
        UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id
      `,
      [userId],
    );
    await appendAuditEntry(transaction, context, {
      action: "user.sessions-revoked",
      entityType: "user",
      entityId: userId,
      after: { revokedSessions: revoked.rowCount ?? 0 },
    });
    return revoked.rowCount ?? 0;
  });
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("invalid-email");
  }
  return normalized;
}

function accessKeyForRole(
  role: SystemRole,
  accessKeys: RoleAccessKeys,
): string {
  if (role === "admin") return accessKeys.adminAccessKey;
  if (role === "viewer") return accessKeys.viewerAccessKey;
  return accessKeys.sharedAccessKey;
}

function requireDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length < 2 || normalized.length > 100) {
    throw new Error("invalid-display-name");
  }
  return normalized;
}

function requiredFirst<Row>(rows: Row[], code: string): Row {
  const row = rows[0];
  if (!row) {
    throw new Error(code);
  }
  return row;
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

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
