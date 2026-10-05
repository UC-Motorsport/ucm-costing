import { afterEach, describe, expect, it } from "vitest";

import {
  assertDevelopmentAccountEnabled,
  DEVELOPMENT_LOGIN,
  ensureDevelopmentAdministrator,
} from "../src/development/development-account";
import {
  loginWithAccessKey,
} from "../src/security/auth-service";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "./helpers/postgres";

const databases: PostgresTestDatabase[] = [];
const enabledEnvironment = {
  NODE_ENV: "development",
  UCM_ENABLE_DEVELOPMENT_ACCOUNT: "true",
};
const DEVELOPMENT_ACCESS_KEYS = {
  sharedAccessKey: "test",
  viewerAccessKey: "viewer-test",
  adminAccessKey: "admin-test",
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("development login isolation", () => {
  it("refuses account seeding in production or without the explicit flag", () => {
    expect(() =>
      assertDevelopmentAccountEnabled({
        NODE_ENV: "production",
        UCM_ENABLE_DEVELOPMENT_ACCOUNT: "true",
      }),
    ).toThrow("development-account-seed-disabled");
    expect(() =>
      assertDevelopmentAccountEnabled({ NODE_ENV: "development" }),
    ).toThrow("development-account-seed-disabled");
  });
});

describe.skipIf(!hasPostgresTestDatabase())(
  "development account seeding",
  () => {
    it("is idempotent and reconciles identity drift before allowing administrator-key login", async () => {
      const postgres = await createPostgresTestDatabase();
      databases.push(postgres);

      const first = await ensureDevelopmentAdministrator(
        postgres.database,
        enabledEnvironment,
      );
      const second = await ensureDevelopmentAdministrator(
        postgres.database,
        enabledEnvironment,
      );
      expect(first).toMatchObject({ created: true, reconciled: false });
      expect(second).toMatchObject({ created: false, reconciled: false });
      expect(second.user.id).toBe(first.user.id);
      expect(second.user.version).toBe(0);

      await expect(
        loginWithAccessKey(
          postgres.database,
          { requestId: "development-account-member-key-rejection" },
          {
            email: DEVELOPMENT_LOGIN.email,
            key: DEVELOPMENT_ACCESS_KEYS.sharedAccessKey,
            ...DEVELOPMENT_ACCESS_KEYS,
          },
        ),
      ).rejects.toThrow("invalid-credentials");
      await loginWithAccessKey(
        postgres.database,
        { requestId: "development-account-test-login" },
        {
          email: DEVELOPMENT_LOGIN.email,
          key: DEVELOPMENT_ACCESS_KEYS.adminAccessKey,
          ...DEVELOPMENT_ACCESS_KEYS,
        },
      );
      const activeSessions = await sessionCount(postgres);
      expect(activeSessions).toBe(1);

      await postgres.database.query(
        `
          UPDATE users
          SET display_name = 'Drifted Test User',
              role = 'viewer',
              status = 'disabled'
          WHERE id = $1
        `,
        [first.user.id],
      );

      const reconciled = await ensureDevelopmentAdministrator(
        postgres.database,
        enabledEnvironment,
      );
      expect(reconciled).toMatchObject({
        created: false,
        reconciled: true,
        user: {
          id: first.user.id,
          email: DEVELOPMENT_LOGIN.email,
          display_name: DEVELOPMENT_LOGIN.displayName,
          role: "admin",
          status: "active",
          version: 1,
        },
      });
      expect(await sessionCount(postgres)).toBe(0);

      await expect(
        loginWithAccessKey(
          postgres.database,
          {
            requestId:
              "development-account-member-key-rejection-after-reconcile",
          },
          {
            email: DEVELOPMENT_LOGIN.email,
            key: DEVELOPMENT_ACCESS_KEYS.sharedAccessKey,
            ...DEVELOPMENT_ACCESS_KEYS,
          },
        ),
      ).rejects.toThrow("invalid-credentials");
      await loginWithAccessKey(
        postgres.database,
        { requestId: "development-account-test-login-after-reconcile" },
        {
          email: DEVELOPMENT_LOGIN.email.toUpperCase(),
          key: DEVELOPMENT_ACCESS_KEYS.adminAccessKey,
          ...DEVELOPMENT_ACCESS_KEYS,
        },
      );
      expect(await sessionCount(postgres)).toBe(1);

      const stored = await postgres.database.one<{
        users: number;
        seed_entries: number;
      }>(
        `
          SELECT
            (SELECT COUNT(*)::int
             FROM users
             WHERE lower(email) = lower($1)) AS users,
            (SELECT COUNT(*)::int
             FROM audit_ledger
             WHERE action IN (
               'user.development-seeded',
               'user.development-reconciled'
             )) AS seed_entries
        `,
        [DEVELOPMENT_LOGIN.email],
      );
      expect(stored.users).toBe(1);
      expect(stored.seed_entries).toBe(2);
    });
  },
);

async function sessionCount(
  postgres: PostgresTestDatabase,
): Promise<number> {
  return (
    await postgres.database.one<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM sessions
        WHERE revoked_at IS NULL
      `,
    )
  ).count;
}
