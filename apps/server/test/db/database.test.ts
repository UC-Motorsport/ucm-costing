import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDatabaseConfig,
  LOCAL_ADDENDUM_V12_SHA256,
  LOCAL_ADDENDUM_V12_VERSION,
} from "../../src/config";
import {
  applyMigrations,
  configureApplicationDatabaseRole,
  databaseMigrationVersion,
  LATEST_DATABASE_MIGRATION,
  openDatabase,
} from "../../src/db/database";
import {
  authenticateSession,
  bootstrapAdministrator,
  createUser,
  loginWithAccessKey,
  reconcileAccessKeys,
} from "../../src/security/auth-service";
import {
  DEMO_PROJECT_ID,
  seedDemoProject,
} from "../../src/services/demo-seed-service";
import {
  OFFICIAL_RULE_DOCUMENT_ID,
  OFFICIAL_RULE_DOCUMENT_V12_ID,
  seedCoreData,
} from "../../src/services/reference-data-service";
import {
  ensureTeamWorkspace,
  TEAM_WORKSPACE_ID,
} from "../../src/services/workspace-service";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres";

const databases: PostgresTestDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe.skipIf(!hasPostgresTestDatabase())(
  "PostgreSQL application model",
  () => {
    it("applies migrations idempotently and installs references without project data", async () => {
      const testDatabase = await createTestDatabase();
      expect(
        await databaseMigrationVersion(testDatabase.database),
      ).toBe(LATEST_DATABASE_MIGRATION);

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);
      const first = await seedCoreData(testDatabase.database);
      const second = await seedCoreData(testDatabase.database);
      expect(first).toMatchObject({ inserted: 2073, existing: 0 });
      expect(second).toMatchObject({ inserted: 0, existing: 2073 });

      const counts = await testDatabase.database.one<{
        projects: number;
        nodes: number;
        lines: number;
        sources: number;
        catalogue_items: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::integer FROM projects) AS projects,
          (SELECT COUNT(*)::integer FROM cost_nodes) AS nodes,
          (SELECT COUNT(*)::integer FROM cost_lines) AS lines,
          (SELECT COUNT(*)::integer FROM source_documents) AS sources,
          (SELECT COUNT(*)::integer FROM catalogue_items) AS catalogue_items
      `);
      expect(counts).toEqual({
        projects: 0,
        nodes: 0,
        lines: 0,
        sources: 3,
        catalogue_items: 2073,
      });
      const obsoleteCredentialColumns = await testDatabase.database.one<{
        count: number;
      }>(
        `
          SELECT COUNT(*)::integer AS count
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'password_hash'
        `,
      );
      expect(obsoleteCredentialColumns.count).toBe(0);
    });

    it("cuts legacy users, invitations, and sessions over to shared-key authentication", async () => {
      const testDatabase = await createPostgresTestDatabase({
        migrationThrough: 5,
      });
      databases.push(testDatabase);
      await testDatabase.database.query(
        `
          INSERT INTO users(
            id, email, display_name, password_hash, role, status
          )
          VALUES
            (
              'legacy-active',
              'legacy-active@example.test',
              'Legacy Active',
              'legacy-password-hash',
              'admin',
              'active'
            ),
            (
              'legacy-invited',
              'legacy-invited@example.test',
              'Legacy Invited',
              NULL,
              'viewer',
              'invited'
            );

          INSERT INTO user_invites(
            id, user_id, token_digest, expires_at, created_by
          )
          VALUES (
            'legacy-invite',
            'legacy-invited',
            '${"a".repeat(64)}',
            now() + interval '1 day',
            'legacy-active'
          );

          INSERT INTO sessions(
            id, user_id, token_digest, expires_at
          )
          VALUES (
            'legacy-session',
            'legacy-active',
            '${"b".repeat(64)}',
            now() + interval '1 day'
          );
        `,
      );

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);

      const users = await testDatabase.database.query<{
        email: string;
        status: string;
      }>(
        `
          SELECT email, status
          FROM users
          ORDER BY email
        `,
      );
      expect(users.rows).toEqual([
        { email: "legacy-active@example.test", status: "active" },
        { email: "legacy-invited@example.test", status: "active" },
      ]);
      const invite = await testDatabase.database.one<{
        revoked_at: string | null;
      }>(
        "SELECT revoked_at FROM user_invites WHERE id = 'legacy-invite'",
      );
      expect(invite.revoked_at).not.toBeNull();
      const session = await testDatabase.database.one<{
        revoked_at: string | null;
      }>(
        "SELECT revoked_at FROM sessions WHERE id = 'legacy-session'",
      );
      expect(session.revoked_at).not.toBeNull();

      const credentialSchema = await testDatabase.database.one<{
        password_hash_columns: number;
        session_fingerprint_columns: number;
      }>(
        `
          SELECT
            (
              SELECT COUNT(*)::integer
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'users'
                AND column_name = 'password_hash'
            ) AS password_hash_columns,
            (
              SELECT COUNT(*)::integer
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'sessions'
                AND column_name LIKE '%fingerprint%'
            ) AS session_fingerprint_columns
        `,
      );
      expect(credentialSchema).toEqual({
        password_hash_columns: 0,
        session_fingerprint_columns: 1,
      });
    });

    it("revokes one-key sessions and renames their fingerprint column in migration 7", async () => {
      const testDatabase = await createPostgresTestDatabase({
        migrationThrough: 6,
      });
      databases.push(testDatabase);
      await testDatabase.database.query(
        `
          INSERT INTO users(id, email, display_name, role, status)
          VALUES
            (
              'migration-seven-admin',
              'migration-seven-admin@example.test',
              'Migration Seven Admin',
              'admin',
              'active'
            ),
            (
              'migration-seven-member',
              'migration-seven-member@example.test',
              'Migration Seven Member',
              'viewer',
              'active'
            );

          INSERT INTO sessions(
            id, user_id, token_digest, expires_at, shared_key_fingerprint
          )
          VALUES
            (
              'migration-seven-admin-session',
              'migration-seven-admin',
              '${"a".repeat(64)}',
              now() + interval '1 day',
              '${"c".repeat(64)}'
            ),
            (
              'migration-seven-member-session',
              'migration-seven-member',
              '${"b".repeat(64)}',
              now() + interval '1 day',
              '${"c".repeat(64)}'
            );
        `,
      );

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);

      const sessions = await testDatabase.database.query<{
        id: string;
        revoked_at: string | null;
      }>(
        `
          SELECT id, revoked_at
          FROM sessions
          ORDER BY id
        `,
      );
      expect(sessions.rows).toEqual([
        {
          id: "migration-seven-admin-session",
          revoked_at: expect.any(String),
        },
        {
          id: "migration-seven-member-session",
          revoked_at: expect.any(String),
        },
      ]);
      const columns = await testDatabase.database.one<{
        access_key_fingerprint: number;
        shared_key_fingerprint: number;
      }>(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE column_name = 'access_key_fingerprint'
            )::integer AS access_key_fingerprint,
            COUNT(*) FILTER (
              WHERE column_name = 'shared_key_fingerprint'
            )::integer AS shared_key_fingerprint
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sessions'
        `,
      );
      expect(columns).toEqual({
        access_key_fingerprint: 1,
        shared_key_fingerprint: 0,
      });
    });

    it("adds the non-final deadline report mode in migration 8", async () => {
      const testDatabase = await createPostgresTestDatabase({
        migrationThrough: 7,
      });
      databases.push(testDatabase);

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);

      const constraint = await testDatabase.database.one<{
        definition: string;
      }>(
        `
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conname = 'report_snapshots_mode_check'
        `,
      );
      expect(constraint.definition).toContain("'deadline'::text");
      expect(constraint.definition).toContain("'competition-ready'::text");
    });

    it("adds neutral full-report exports in migration 9", async () => {
      const testDatabase = await createPostgresTestDatabase({
        migrationThrough: 8,
      });
      databases.push(testDatabase);

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);

      const constraint = await testDatabase.database.one<{
        definition: string;
      }>(
        `
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conname = 'report_snapshots_mode_check'
        `,
      );
      expect(constraint.definition).toContain("'export'::text");
      expect(constraint.definition).toContain("'deadline'::text");
      expect(constraint.definition).toContain("'competition-ready'::text");
    });

    it("recovers official size units without rewriting explicit units or revisions", async () => {
      const testDatabase = await createPostgresTestDatabase({
        migrationThrough: 11,
      });
      databases.push(testDatabase);
      await seedCoreData(testDatabase.database);

      await testDatabase.database.query(
        `
          ALTER TABLE catalogue_items
            DISABLE TRIGGER catalogue_items_immutable;

          UPDATE catalogue_items
          SET unit = NULL, unit_2 = NULL
          WHERE kind = 'stock-size' AND catalogue_id = '234';

          UPDATE catalogue_items
          SET unit = 'preserve-me'
          WHERE kind = 'stock-size' AND catalogue_id = '1';

          UPDATE catalogue_items
          SET unit = NULL
          WHERE kind = 'tooling' AND catalogue_id = '19';

          ALTER TABLE catalogue_items
            ENABLE TRIGGER catalogue_items_immutable;

          INSERT INTO users(id, email, display_name, role, status)
          VALUES (
            'catalogue-unit-migration-editor',
            'catalogue-unit-migration@example.test',
            'Catalogue Unit Migration Editor',
            'editor',
            'active'
          );

          INSERT INTO catalogue_item_revisions(
            id, catalogue_item_id, revision, name, category, supplier,
            unit, unit_2, raw_formula, fixed_cost, coefficients_json,
            metadata_json, reason, evidence, created_by
          )
          SELECT
            'catalogue-unit-migration-revision', id, 1, name, category,
            supplier, NULL, unit_2, raw_formula, fixed_cost,
            coefficients_json, metadata_json,
            'Preserve an authored null unit', NULL,
            'catalogue-unit-migration-editor'
          FROM catalogue_items
          WHERE kind = 'tooling' AND catalogue_id = '19';
        `,
      );

      await expect(
        applyMigrations(testDatabase.database),
      ).resolves.toBe(LATEST_DATABASE_MIGRATION);

      const rows = await testDatabase.database.query<{
        kind: string;
        catalogue_id: string;
        source_unit: string | null;
        source_unit_2: string | null;
        effective_unit: string | null;
      }>(
        `
          SELECT
            item.kind,
            item.catalogue_id,
            item.unit AS source_unit,
            item.unit_2 AS source_unit_2,
            effective.unit AS effective_unit
          FROM catalogue_items item
          JOIN effective_catalogue_items effective ON effective.id = item.id
          WHERE (item.kind = 'stock-size' AND item.catalogue_id IN ('1', '234'))
             OR (item.kind = 'tooling' AND item.catalogue_id = '19')
          ORDER BY item.kind, item.catalogue_id
        `,
      );
      expect(rows.rows).toEqual([
        {
          kind: "stock-size",
          catalogue_id: "1",
          source_unit: "preserve-me",
          source_unit_2: null,
          effective_unit: "preserve-me",
        },
        {
          kind: "stock-size",
          catalogue_id: "234",
          source_unit: "mm",
          source_unit_2: "mm",
          effective_unit: "mm",
        },
        {
          kind: "tooling",
          catalogue_id: "19",
          source_unit: "m^2",
          source_unit_2: null,
          effective_unit: null,
        },
      ]);
      const revision = await testDatabase.database.one<{ unit: string | null }>(
        `
          SELECT unit
          FROM catalogue_item_revisions
          WHERE id = 'catalogue-unit-migration-revision'
        `,
      );
      expect(revision.unit).toBeNull();
      const trigger = await testDatabase.database.one<{ enabled: string }>(
        `
          SELECT tgenabled AS enabled
          FROM pg_trigger
          WHERE tgrelid = 'catalogue_items'::regclass
            AND tgname = 'catalogue_items_immutable'
        `,
      );
      expect(trigger.enabled).toBe("O");
      await expect(
        testDatabase.database.query(
          `
            UPDATE catalogue_items
            SET unit = 'should-not-write'
            WHERE kind = 'stock-size' AND catalogue_id = '234'
          `,
        ),
      ).rejects.toThrow("catalogue_items rows are immutable");
    });

    it("rotates member and administrator keys independently without resurrecting sessions", async () => {
      const testDatabase = await createTestDatabase();
      const firstKeys = {
        sharedAccessKey:
          "first-member-access-key-for-rotation-test-000000000000",
        viewerAccessKey:
          "first-viewer-access-key-for-rotation-test-000000000000",
        adminAccessKey:
          "first-admin-access-key-for-rotation-test-0000000000000",
      };
      const secondMemberKeys = {
        ...firstKeys,
        sharedAccessKey:
          "second-member-access-key-for-rotation-test-00000000000",
      };
      const secondAdminKeys = {
        ...firstKeys,
        adminAccessKey:
          "second-admin-access-key-for-rotation-test-000000000000",
      };
      await expect(
        reconcileAccessKeys(testDatabase.database, firstKeys),
      ).resolves.toEqual({
        shared: {
          initialized: true,
          rotated: false,
          revokedSessions: 0,
        },
        viewer: {
          initialized: true,
          rotated: false,
          revokedSessions: 0,
        },
        admin: {
          initialized: true,
          rotated: false,
          revokedSessions: 0,
        },
        revokedSessions: 0,
      });
      const administrator = await bootstrapAdministrator(
        testDatabase.database,
        {
          email: "rotation-admin@example.test",
          displayName: "Rotation Administrator",
        },
      );
      const context = {
        requestId: "role-key-rotation-test",
        userAgent: null,
        ipAddressHash: null,
      };
      const member = await createUser(
        testDatabase.database,
        { ...context, actorUserId: administrator.id },
        {
          email: "rotation-member@example.test",
          displayName: "Rotation Member",
          role: "editor",
        },
      );
      const viewer = await createUser(
        testDatabase.database,
        { ...context, actorUserId: administrator.id },
        {
          email: "rotation-viewer@example.test",
          displayName: "Rotation Viewer",
          role: "viewer",
        },
      );
      const firstAdminLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: administrator.email,
          key: firstKeys.adminAccessKey,
          ...firstKeys,
        },
      );
      const firstMemberLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: member.email,
          key: firstKeys.sharedAccessKey,
          ...firstKeys,
        },
      );
      const firstViewerLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: viewer.email,
          key: firstKeys.viewerAccessKey,
          ...firstKeys,
        },
      );
      await expect(
        loginWithAccessKey(testDatabase.database, context, {
          email: viewer.email,
          key: firstKeys.sharedAccessKey,
          ...firstKeys,
        }),
      ).rejects.toThrow("invalid-credentials");
      await expect(
        loginWithAccessKey(testDatabase.database, context, {
          email: member.email,
          key: firstKeys.viewerAccessKey,
          ...firstKeys,
        }),
      ).rejects.toThrow("invalid-credentials");
      await expect(
        reconcileAccessKeys(testDatabase.database, secondMemberKeys),
      ).resolves.toEqual({
        shared: {
          initialized: false,
          rotated: true,
          revokedSessions: 1,
        },
        viewer: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        admin: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        revokedSessions: 1,
      });
      await expect(
        authenticateSession(
          testDatabase.database,
          firstAdminLogin.token,
          secondMemberKeys,
        ),
      ).resolves.toMatchObject({ user: { id: administrator.id } });
      await expect(
        authenticateSession(
          testDatabase.database,
          firstMemberLogin.token,
          secondMemberKeys,
        ),
      ).resolves.toBeNull();
      await expect(
        authenticateSession(
          testDatabase.database,
          firstViewerLogin.token,
          secondMemberKeys,
        ),
      ).resolves.toMatchObject({ user: { id: viewer.id } });
      const secondMemberLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: member.email,
          key: secondMemberKeys.sharedAccessKey,
          ...secondMemberKeys,
        },
      );

      await expect(
        reconcileAccessKeys(testDatabase.database, firstKeys),
      ).resolves.toEqual({
        shared: {
          initialized: false,
          rotated: true,
          revokedSessions: 1,
        },
        viewer: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        admin: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        revokedSessions: 1,
      });
      await expect(
        authenticateSession(
          testDatabase.database,
          firstMemberLogin.token,
          firstKeys,
        ),
      ).resolves.toBeNull();
      await expect(
        authenticateSession(
          testDatabase.database,
          secondMemberLogin.token,
          firstKeys,
        ),
      ).resolves.toBeNull();

      const currentMemberLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: member.email,
          key: firstKeys.sharedAccessKey,
          ...firstKeys,
        },
      );
      await expect(
        reconcileAccessKeys(testDatabase.database, secondAdminKeys),
      ).resolves.toEqual({
        shared: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        viewer: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        admin: {
          initialized: false,
          rotated: true,
          revokedSessions: 1,
        },
        revokedSessions: 1,
      });
      await expect(
        authenticateSession(
          testDatabase.database,
          currentMemberLogin.token,
          secondAdminKeys,
        ),
      ).resolves.toMatchObject({ user: { id: member.id } });
      await expect(
        authenticateSession(
          testDatabase.database,
          firstAdminLogin.token,
          secondAdminKeys,
        ),
      ).resolves.toBeNull();
      const secondAdminLogin = await loginWithAccessKey(
        testDatabase.database,
        context,
        {
          email: administrator.email,
          key: secondAdminKeys.adminAccessKey,
          ...secondAdminKeys,
        },
      );

      await expect(
        reconcileAccessKeys(testDatabase.database, firstKeys),
      ).resolves.toEqual({
        shared: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        viewer: {
          initialized: false,
          rotated: false,
          revokedSessions: 0,
        },
        admin: {
          initialized: false,
          rotated: true,
          revokedSessions: 1,
        },
        revokedSessions: 1,
      });
      await expect(
        authenticateSession(
          testDatabase.database,
          currentMemberLogin.token,
          firstKeys,
        ),
      ).resolves.toMatchObject({ user: { id: member.id } });
      for (const staleAdminToken of [
        firstAdminLogin.token,
        secondAdminLogin.token,
      ]) {
        await expect(
          authenticateSession(
            testDatabase.database,
            staleAdminToken,
            firstKeys,
          ),
        ).resolves.toBeNull();
      }
    });

    it("creates the synthetic project only through the explicit test helper", async () => {
      const testDatabase = await createTestDatabase();
      await seedCoreData(testDatabase.database);
      await seedDemoProject(testDatabase.database);
      const first = await demoCounts(testDatabase);
      expect(first.projects).toBe(1);
      expect(first.nodes).toBeGreaterThan(40);
      expect(first.lines).toBeGreaterThan(300);
      expect(first.entry_number).toBe("E13");
      expect(first.rule_source_document_id).toBe(OFFICIAL_RULE_DOCUMENT_ID);

      await seedDemoProject(testDatabase.database);
      expect(await demoCounts(testDatabase)).toEqual(first);
    });

    it("does not repin an existing workspace from v1.2 to v1.4", async () => {
      const testDatabase = await createTestDatabase();
      await seedCoreData(testDatabase.database);
      await ensureTeamWorkspace(testDatabase.database);
      await testDatabase.database.query(
        `
          UPDATE projects
          SET rule_source_document_id = $1,
              rule_pack_version = $2,
              rule_pack_sha256 = $3
          WHERE id = $4
        `,
        [
          OFFICIAL_RULE_DOCUMENT_V12_ID,
          LOCAL_ADDENDUM_V12_VERSION,
          LOCAL_ADDENDUM_V12_SHA256,
          TEAM_WORKSPACE_ID,
        ],
      );

      await ensureTeamWorkspace(testDatabase.database);

      await expect(
        testDatabase.database.one<{
          rule_source_document_id: string;
          rule_pack_version: string;
          rule_pack_sha256: string;
        }>(
          `
            SELECT rule_source_document_id, rule_pack_version,
                   rule_pack_sha256
            FROM projects
            WHERE id = $1
          `,
          [TEAM_WORKSPACE_ID],
        ),
      ).resolves.toEqual({
        rule_source_document_id: OFFICIAL_RULE_DOCUMENT_V12_ID,
        rule_pack_version: LOCAL_ADDENDUM_V12_VERSION,
        rule_pack_sha256: LOCAL_ADDENDUM_V12_SHA256,
      });
    });

    it("commits and rolls back on one checked-out transaction client", async () => {
      const testDatabase = await createTestDatabase();
      await testDatabase.database.transaction(async (transaction) => {
        await transaction.query(
          `
            INSERT INTO users(
              id, email, display_name, role, status
            )
            VALUES ('committed-user', 'commit@example.test', 'Commit',
                    'viewer', 'active')
          `,
        );
      });
      await expect(
        testDatabase.database.transaction(async (transaction) => {
          await transaction.query(
            `
              INSERT INTO users(
                id, email, display_name, role, status
              )
              VALUES ('rolled-back-user', 'rollback@example.test', 'Rollback',
                      'viewer', 'active')
            `,
          );
          throw new Error("force-rollback");
        }),
      ).rejects.toThrow("force-rollback");

      const users = await testDatabase.database.query<{ id: string }>(
        "SELECT id FROM users ORDER BY id",
      );
      expect(users.rows).toEqual([{ id: "committed-user" }]);
      await expect(
        testDatabase.database.transaction(
          async (transaction) => {
            await transaction.query(
              `
                INSERT INTO users(
                  id, email, display_name, role, status
                )
                VALUES ('read-only-user', 'read-only@example.test',
                        'Read only', 'viewer', 'active')
              `,
            );
          },
          { readOnly: true },
        ),
      ).rejects.toMatchObject({ code: "25006" });
    });

    it("detects migration checksum drift", async () => {
      const testDatabase = await createTestDatabase();
      await testDatabase.database.query(
        `
          UPDATE schema_migrations
          SET checksum = $1
          WHERE version = $2
        `,
        ["0".repeat(64), LATEST_DATABASE_MIGRATION],
      );
      await expect(
        applyMigrations(testDatabase.database),
      ).rejects.toThrow(
        `database-migration-checksum-mismatch:${LATEST_DATABASE_MIGRATION}`,
      );
    });

    it("provisions and hardens a missing application role idempotently", async () => {
      const testDatabase = await createTestDatabase();
      const roleName =
        `ucm_app_test_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const parentRole =
        `ucm_parent_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const quotedRole = `"${roleName}"`;
      const quotedParent = `"${parentRole}"`;

      try {
        await configureApplicationDatabaseRole(
          testDatabase.database,
          roleName,
          `first-${randomUUID()}`,
        );
        await testDatabase.database.query(
          `CREATE ROLE ${quotedParent} NOLOGIN`,
        );
        await testDatabase.database.query(
          `GRANT ${quotedParent} TO ${quotedRole}`,
        );
        await testDatabase.database.query(
          `GRANT CREATE ON SCHEMA public TO ${quotedRole}`,
        );
        await testDatabase.database.query(
          `GRANT TRUNCATE ON TABLE public.projects TO ${quotedRole}`,
        );
        await testDatabase.database.query(
          "GRANT CREATE ON SCHEMA public TO PUBLIC",
        );
        await testDatabase.database.query(
          "GRANT TRUNCATE ON TABLE public.projects TO PUBLIC",
        );
        await configureApplicationDatabaseRole(
          testDatabase.database,
          roleName,
          `rotated-${randomUUID()}`,
        );

        const state = await testDatabase.database.one<{
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolinherit: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          can_connect: boolean;
          can_use_schema: boolean;
          can_create_in_schema: boolean;
          can_insert_projects: boolean;
          can_truncate_projects: boolean;
          can_update_ledger: boolean;
          can_delete_sources: boolean;
          parent_memberships: number;
        }>(
          `
            SELECT
              role.rolcanlogin,
              role.rolsuper,
              role.rolcreatedb,
              role.rolcreaterole,
              role.rolinherit,
              role.rolreplication,
              role.rolbypassrls,
              has_database_privilege(
                role.rolname,
                current_database(),
                'CONNECT'
              ) AS can_connect,
              has_schema_privilege(
                role.rolname,
                'public',
                'USAGE'
              ) AS can_use_schema,
              has_schema_privilege(
                role.rolname,
                'public',
                'CREATE'
              ) AS can_create_in_schema,
              has_table_privilege(
                role.rolname,
                'projects',
                'INSERT'
              ) AS can_insert_projects,
              has_table_privilege(
                role.rolname,
                'projects',
                'TRUNCATE'
              ) AS can_truncate_projects,
              has_table_privilege(
                role.rolname,
                'audit_ledger',
                'UPDATE'
              ) AS can_update_ledger,
              has_table_privilege(
                role.rolname,
                'source_documents',
                'DELETE'
              ) AS can_delete_sources,
              (
                SELECT COUNT(*)::integer
                FROM pg_auth_members membership
                WHERE membership.member = role.oid
              ) AS parent_memberships
            FROM pg_roles role
            WHERE role.rolname = $1
          `,
          [roleName],
        );
        expect(state).toEqual({
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
          can_connect: true,
          can_use_schema: true,
          can_create_in_schema: false,
          can_insert_projects: true,
          can_truncate_projects: false,
          can_update_ledger: false,
          can_delete_sources: false,
          parent_memberships: 0,
        });
      } finally {
        for (const quotedCleanupRole of [quotedRole, quotedParent]) {
          await testDatabase.database.query(
            `DROP OWNED BY ${quotedCleanupRole}`,
          );
          await testDatabase.database.query(
            `DROP ROLE IF EXISTS ${quotedCleanupRole}`,
          );
        }
      }
    });

    it("does not expose the application password when role provisioning fails", async () => {
      const testDatabase = await createTestDatabase();
      const uniqueSuffix =
        randomUUID().replaceAll("-", "").slice(0, 20);
      const migratorRole = `ucm_limited_${uniqueSuffix}`;
      const targetRole = `ucm_target_${uniqueSuffix}`;
      const migratorPassword = `limited-${randomUUID()}`;
      const applicationPassword =
        `CANARY-application-${randomUUID()}`;
      const quotedMigrator = `"${migratorRole}"`;
      const quotedTarget = `"${targetRole}"`;
      const roleStatement = await testDatabase.database.one<{
        sql: string;
      }>(
        `
          SELECT format(
            'CREATE ROLE %I WITH LOGIN PASSWORD %L NOCREATEROLE',
            $1::text,
            $2::text
          ) AS sql
        `,
        [migratorRole, migratorPassword],
      );
      await testDatabase.database.query(roleStatement.sql);
      await testDatabase.database.query(
        `GRANT CONNECT ON DATABASE "${testDatabase.databaseName}" TO ${quotedMigrator}`,
      );

      const limitedUrl = new URL(testDatabase.connectionString);
      limitedUrl.username = migratorRole;
      limitedUrl.password = migratorPassword;
      const limitedDatabase = openDatabase(
        getDatabaseConfig({
          ...process.env,
          DATABASE_URL: limitedUrl.toString(),
          UCM_DATABASE_SSL:
            process.env.UCM_TEST_DATABASE_SSL ?? "disable",
          UCM_DB_POOL_MAX: "1",
        }),
      );

      try {
        let failure: unknown;
        try {
          await configureApplicationDatabaseRole(
            limitedDatabase,
            targetRole,
            applicationPassword,
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          "application database role provisioning failed",
        );
        expect(serializeError(failure)).not.toContain(applicationPassword);
      } finally {
        await limitedDatabase.close();
        for (const quotedRole of [quotedTarget, quotedMigrator]) {
          const roleName = quotedRole.slice(1, -1);
          const exists = await testDatabase.database.maybeOne<{
            exists: boolean;
          }>(
            `
              SELECT true AS exists
              FROM pg_roles
              WHERE rolname = $1
            `,
            [roleName],
          );
          if (exists) {
            await testDatabase.database.query(
              `DROP OWNED BY ${quotedRole}`,
            );
            await testDatabase.database.query(
              `DROP ROLE ${quotedRole}`,
            );
          }
        }
      }
    });

    it("enforces append-only records and exact numeric constraints", async () => {
      const testDatabase = await createTestDatabase();
      await seedCoreData(testDatabase.database);
      await testDatabase.database.query(
        `
          INSERT INTO projects(
            id, name, season, vehicle_type, entry_number, status,
            rule_pack_version, rule_pack_sha256, rule_source_document_id,
            catalogue_release_id
          )
          SELECT
            'constraint-project', 'Constraint project', 2026, 'electric',
            'E13', 'draft', 'test', $1, $2, id
          FROM catalogue_releases
          LIMIT 1
        `,
        ["f".repeat(64), OFFICIAL_RULE_DOCUMENT_ID],
      );
      await testDatabase.database.query(
        `
          INSERT INTO cost_nodes(
            id, project_id, kind, name, procurement_type, quantity
          )
          VALUES (
            'constraint-node', 'constraint-project', 'vehicle',
            'Constraint vehicle', 'made', 1
          )
        `,
      );

      await expect(
        testDatabase.database.query(
          `
            INSERT INTO cost_lines(
              id, node_id, kind, description, unit_cost, quantity,
              multiplier, fraction_included, calculation_json, subtotal
            )
            VALUES (
              'zero-fraction', 'constraint-node', 'material', 'Invalid',
              1, 1, 1, 0, '{}'::jsonb, 0
            )
          `,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        testDatabase.database.query(
          `
            UPDATE source_documents
            SET title = 'Changed'
            WHERE id = $1
          `,
          [OFFICIAL_RULE_DOCUMENT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      await testDatabase.database.query(
        `
          INSERT INTO audit_ledger(
            previous_hash, entry_hash, request_id, action,
            entity_type, entity_id, metadata_json, occurred_at
          )
          VALUES (
            NULL, $1, 'request-1', 'test.created',
            'test', 'one', '{}'::jsonb, clock_timestamp()
          )
        `,
        ["a".repeat(64)],
      );
      await expect(
        testDatabase.database.query(
          "UPDATE audit_ledger SET action = 'changed' WHERE sequence = 1",
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        testDatabase.database.query(
          "DELETE FROM audit_ledger WHERE sequence = 1",
        ),
      ).rejects.toMatchObject({ code: "55000" });
    });
  },
);

async function createTestDatabase(): Promise<PostgresTestDatabase> {
  const testDatabase = await createPostgresTestDatabase();
  databases.push(testDatabase);
  return testDatabase;
}

async function demoCounts(
  testDatabase: PostgresTestDatabase,
): Promise<{
  projects: number;
  nodes: number;
  lines: number;
  entry_number: string;
  rule_source_document_id: string;
}> {
  return await testDatabase.database.one(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM projects) AS projects,
        (SELECT COUNT(*)::integer FROM cost_nodes) AS nodes,
        (SELECT COUNT(*)::integer FROM cost_lines) AS lines,
        entry_number,
        rule_source_document_id
      FROM projects
      WHERE id = $1
    `,
    [DEMO_PROJECT_ID],
  );
}

function serializeError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.getOwnPropertyNames(error).map((key) => [
        key,
        (error as Record<string, unknown>)[key],
      ]),
    ),
  );
}
