import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { appendAuditEntry } from "../../src/audit/audit-ledger";
import { LOCAL_ADDENDUM_V12_SHA256 } from "../../src/config";
import {
  LATEST_DATABASE_MIGRATION,
} from "../../src/db/database";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres";

const databases: PostgresTestDatabase[] = [];
const temporaryRoots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!hasPostgresTestDatabase())(
  "database operator CLIs",
  () => {
    it("prints only the database identity and migration version", async () => {
      const testDatabase = await createTestDatabase();
      const result = await runTsx(
        "apps/server/src/cli/migrate.ts",
        [],
        testDatabase.connectionString,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        database: testDatabase.databaseName,
        migrationVersion: LATEST_DATABASE_MIGRATION,
        applicationRole: null,
      });
      expect(result.stdout).not.toContain("postgresql://");
      expect(result.stdout).not.toContain(new URL(
        testDatabase.connectionString,
      ).password);
    });

    it("provisions a missing runtime role without exposing its password", async () => {
      const testDatabase = await createTestDatabase();
      const roleName =
        `ucm_cli_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const password = `CANARY-cli-${randomUUID()}`;
      const quotedRole = `"${roleName}"`;

      try {
        const result = await runTsx(
          "apps/server/src/cli/migrate.ts",
          [],
          testDatabase.connectionString,
          {
            UCM_DATABASE_APP_ROLE: roleName,
            UCM_DATABASE_APP_PASSWORD: password,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          database: testDatabase.databaseName,
          migrationVersion: LATEST_DATABASE_MIGRATION,
          applicationRole: roleName,
        });
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(password);

        const role = await testDatabase.database.one<{
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolbypassrls: boolean;
        }>(
          `
            SELECT
              rolcanlogin,
              rolsuper,
              rolcreatedb,
              rolcreaterole,
              rolbypassrls
            FROM pg_roles
            WHERE rolname = $1
          `,
          [roleName],
        );
        expect(role).toEqual({
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
        });
      } finally {
        const exists = await testDatabase.database.maybeOne<{
          exists: boolean;
        }>(
          "SELECT true AS exists FROM pg_roles WHERE rolname = $1",
          [roleName],
        );
        if (exists) {
          await testDatabase.database.query(`DROP OWNED BY ${quotedRole}`);
          await testDatabase.database.query(`DROP ROLE ${quotedRole}`);
        }
      }
    });

    it("verifies audit ledgers numerically after sequence nine", async () => {
      const testDatabase = await createTestDatabase();
      for (let index = 1; index <= 12; index += 1) {
        await testDatabase.database.transaction(async (transaction) => {
          await appendAuditEntry(
            transaction,
            {
              actorUserId: null,
              requestId: `audit-cli-regression-${index}`,
            },
            {
              action: "test.created",
              entityType: "test",
              entityId: String(index),
            },
          );
        });
      }

      const result = await runTsx(
        "apps/server/src/cli/verify-audit-ledger.ts",
        [],
        testDatabase.connectionString,
      );

      expect(result).toMatchObject({
        code: 0,
        stdout: "Audit ledger verified: 12 entries, chain intact\n",
        stderr: "",
      });
    });

    it("imports and reconciles a checked SQLite source into an empty target", async () => {
      const testDatabase = await createTestDatabase();
      const root = await mkdtemp(path.join(os.tmpdir(), "ucm-sqlite-import-"));
      temporaryRoots.push(root);
      const sqlitePath = path.join(root, "legacy.sqlite");
      const sqlite = new BetterSqlite3(sqlitePath);
      sqlite.exec(`
        CREATE TABLE source_documents (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          version TEXT NOT NULL,
          original_url TEXT NOT NULL,
          local_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          applicability TEXT NOT NULL,
          retrieved_at TEXT NOT NULL
        );
      `);
      sqlite.prepare(`
        INSERT INTO source_documents(
          id, kind, title, version, original_url, local_path, sha256,
          applicability, retrieved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-rule-source",
        "governing-rule",
        "Formula SAE-A 2026 Local Addendum",
        "v1.2",
        "https://example.test/rules.pdf",
        "docs/Local Addendum 2026 Version 1.2 (1).pdf",
        LOCAL_ADDENDUM_V12_SHA256,
        "Legacy import fixture",
        "2026-07-29T00:00:00.000Z",
      );
      sqlite.close();

      const result = await runTsx(
        "apps/server/src/cli/import-sqlite.ts",
        ["--sqlite", sqlitePath],
        testDatabase.connectionString,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr);
      }
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "imported-and-verified",
        demoIncluded: false,
        counts: {
          users: 1,
          source_documents: 1,
          projects: 0,
        },
      });
      const counts = await testDatabase.database.one<{
        sources: number;
        users: number;
        markers: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::integer FROM source_documents) AS sources,
          (SELECT COUNT(*)::integer FROM users) AS users,
          (SELECT COUNT(*)::integer FROM app_metadata) AS markers
      `);
      expect(counts).toEqual({ sources: 1, users: 1, markers: 1 });

      const repeated = await runTsx(
        "apps/server/src/cli/import-sqlite.ts",
        ["--sqlite", sqlitePath],
        testDatabase.connectionString,
      );
      expect(repeated.code).toBe(1);
      expect(repeated.stderr).toContain("PostgreSQL target is not empty");
    });
  },
);

async function createTestDatabase(): Promise<PostgresTestDatabase> {
  const testDatabase = await createPostgresTestDatabase();
  databases.push(testDatabase);
  return testDatabase;
}

async function runTsx(
  script: string,
  arguments_: string[],
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, ...arguments_],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl,
          UCM_DATABASE_SSL: "disable",
          UCM_DATABASE_APP_ROLE: "",
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
