import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";

import { getDatabaseConfig } from "../../src/config";
import {
  applyMigrations,
  openDatabase,
  type DatabaseHandle,
} from "../../src/db/database";
import { migrations } from "../../src/db/migrations";

const TEST_DATABASE_PREFIX = "ucm_test_";

export interface PostgresTestDatabase {
  database: DatabaseHandle;
  databaseName: string;
  connectionString: string;
  close(): Promise<void>;
}

export function hasPostgresTestDatabase(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL?.trim());
}

export async function createPostgresTestDatabase(
  options: { migrationThrough?: number } = {},
): Promise<PostgresTestDatabase> {
  const sourceUrl = requireTestDatabaseUrl();
  const databaseName =
    `${TEST_DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`.slice(0, 63);
  const administrator = new Pool({
    connectionString: sourceUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    application_name: "ucm-tests-admin",
  });
  await administrator.query(
    `CREATE DATABASE ${quoteIdentifier(databaseName)}
       TEMPLATE template0
       ENCODING 'UTF8'`,
  );

  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const database = openDatabase(
    getDatabaseConfig({
      ...process.env,
      DATABASE_URL: targetUrl.toString(),
      UCM_DATABASE_SSL:
        process.env.UCM_TEST_DATABASE_SSL ??
        targetUrl.searchParams.get("sslmode") ??
        "disable",
      UCM_DB_POOL_MAX: "4",
    }),
  );

  try {
    if (options.migrationThrough === undefined) {
      await applyMigrations(database);
    } else {
      await applyMigrationsThrough(database, options.migrationThrough);
    }
  } catch (error) {
    await database.close();
    await dropDatabase(administrator, databaseName);
    await administrator.end();
    throw error;
  }

  let closed = false;
  return {
    database,
    databaseName,
    connectionString: targetUrl.toString(),
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await database.close();
      await dropDatabase(administrator, databaseName);
      await administrator.end();
    },
  };
}

async function applyMigrationsThrough(
  database: DatabaseHandle,
  migrationThrough: number,
): Promise<void> {
  if (!Number.isSafeInteger(migrationThrough) || migrationThrough < 0) {
    throw new Error("invalid-test-migration-version");
  }
  await database.query(`
    CREATE TABLE schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0)
    )
  `);
  for (const migration of migrations.filter(
    ({ version }) => version <= migrationThrough,
  )) {
    await database.transaction(async (transaction) => {
      await transaction.query(migration.sql);
      await transaction.query(
        `
          INSERT INTO schema_migrations(
            version, name, checksum, execution_ms
          )
          VALUES ($1, $2, $3, 0)
        `,
        [
          migration.version,
          migration.name,
          createHash("sha256").update(migration.sql, "utf8").digest("hex"),
        ],
      );
    });
  }
}

async function dropDatabase(
  administrator: Pool,
  databaseName: string,
): Promise<void> {
  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error("refusing-to-drop-non-test-database");
  }
  await administrator.query(
    `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()
    `,
    [databaseName],
  );
  await administrator.query(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
  );
}

function requireTestDatabaseUrl(): URL {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for PostgreSQL integration tests",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("TEST_DATABASE_URL must use postgres:// or postgresql://");
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
