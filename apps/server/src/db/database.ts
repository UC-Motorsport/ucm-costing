import { createHash } from "node:crypto";

import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
  types as postgresTypes,
} from "pg";

import { getDatabaseConfig, type DatabaseConfig } from "../config";
import { migrations } from "./migrations";

const TIMESTAMPTZ_OID = 1184;
const MIGRATION_LOCK_KEY = "ucm:database-migrations";
const APPLICATION_ROLE_LOCK_KEY = "ucm:application-database-role";

postgresTypes.setTypeParser(TIMESTAMPTZ_OID, (value) =>
  new Date(value).toISOString(),
);

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  one<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row>;
  maybeOne<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row | null>;
}

export type DbExecutor = Queryable;

export interface TransactionHandle extends Queryable {
  readonly client: PoolClient;
}

export interface TransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
}

export interface DatabaseHandle extends Queryable {
  readonly pool: Pool;
  transaction<T>(
    work: (transaction: TransactionHandle) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(): Promise<void>;
}

let singleton: DatabaseHandle | null = null;

export function openDatabase(
  configuration: DatabaseConfig = getDatabaseConfig(),
): DatabaseHandle {
  const pool = new Pool({
    connectionString: configuration.connectionString,
    max: configuration.maxConnections,
    connectionTimeoutMillis: configuration.connectionTimeoutMillis,
    idleTimeoutMillis: configuration.idleTimeoutMillis,
    statement_timeout: configuration.statementTimeoutMillis,
    lock_timeout: configuration.lockTimeoutMillis,
    idle_in_transaction_session_timeout:
      configuration.idleInTransactionSessionTimeoutMillis,
    application_name: "ucm-costing",
    ssl: configuration.ssl,
  });
  const root = queryable(pool);

  return {
    pool,
    ...root,
    async transaction<T>(
      work: (transaction: TransactionHandle) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const client = await pool.connect();
      let released = false;
      const isolationLevel =
        options.isolationLevel?.toUpperCase() ?? "READ COMMITTED";
      const accessMode = options.readOnly ? "READ ONLY" : "READ WRITE";
      try {
        await client.query(
          `BEGIN ISOLATION LEVEL ${isolationLevel} ${accessMode}`,
        );
        await client.query(
          `SET LOCAL statement_timeout = '${configuration.statementTimeoutMillis}ms'`,
        );
        await client.query(
          `SET LOCAL lock_timeout = '${configuration.lockTimeoutMillis}ms'`,
        );
        const transaction: TransactionHandle = {
          client,
          ...queryable(client),
        };
        const result = await work(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          client.release(error instanceof Error ? error : undefined);
          released = true;
          throw error;
        }
        throw error;
      } finally {
        if (!released) {
          client.release();
        }
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function getDatabase(): DatabaseHandle {
  singleton ??= openDatabase();
  return singleton;
}

export async function closeDatabase(): Promise<void> {
  const database = singleton;
  singleton = null;
  await database?.close();
}

export async function applyMigrations(
  database: DatabaseHandle,
): Promise<number> {
  const client = await database.pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [MIGRATION_LOCK_KEY],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        execution_ms integer NOT NULL CHECK (execution_ms >= 0)
      )
    `);

    const applied = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      `
        SELECT version, name, checksum
        FROM schema_migrations
        ORDER BY version
      `,
    );
    const knownVersions = new Set(migrations.map(({ version }) => version));
    for (const row of applied.rows) {
      if (!knownVersions.has(row.version)) {
        throw new Error(`database-migration-unknown:${row.version}`);
      }
    }

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const existing = applied.rows.find(
        ({ version }) => version === migration.version,
      );
      if (existing) {
        if (
          existing.name !== migration.name ||
          existing.checksum !== checksum
        ) {
          throw new Error(`database-migration-checksum-mismatch:${migration.version}`);
        }
        continue;
      }

      const startedAt = performance.now();
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `
            INSERT INTO schema_migrations(
              version, name, checksum, applied_at, execution_ms
            )
            VALUES ($1, $2, $3, clock_timestamp(), $4)
          `,
          [
            migration.version,
            migration.name,
            checksum,
            Math.max(0, Math.round(performance.now() - startedAt)),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return await databaseMigrationVersion(queryable(client));
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [MIGRATION_LOCK_KEY],
      );
    } finally {
      client.release();
    }
  }
}

export async function databaseMigrationVersion(
  database: Queryable,
): Promise<number> {
  const row = await database.one<{ version: number }>(`
    SELECT COALESCE(MAX(version), 0)::integer AS version
    FROM schema_migrations
  `);
  return row.version;
}

export async function configureApplicationDatabaseRole(
  database: DatabaseHandle,
  roleName: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) {
    throw new Error("database-application-role-invalid");
  }
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (
    passwordBytes < 12 ||
    passwordBytes > 1_024 ||
    password.includes("\0")
  ) {
    throw new Error("database-application-role-password-invalid");
  }
  const databaseIdentity = await database.one<{
    database_name: string;
    current_user_name: string;
  }>(
    `
      SELECT
        current_database() AS database_name,
        current_user AS current_user_name
    `,
  );
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseIdentity.database_name)) {
    throw new Error("database-name-invalid-for-privilege-configuration");
  }
  if (databaseIdentity.current_user_name === roleName) {
    throw new Error("database-application-role-must-differ-from-migrator");
  }
  const role = quoteIdentifier(roleName);
  const databaseName = quoteIdentifier(databaseIdentity.database_name);

  await database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [APPLICATION_ROLE_LOCK_KEY],
    );
    // Store both values as transaction-local settings through bind parameters.
    // The server-side block can then safely quote the identifier and password
    // without putting the credential into client SQL text or command output.
    await transaction.query(
      `
        SELECT
          set_config('ucm.provision_role_name', $1, true),
          set_config('ucm.provision_role_password', $2, true)
      `,
      [roleName, password],
    );
    await transaction.query(`
      DO $ucm_application_role$
      DECLARE
        target_role text :=
          current_setting('ucm.provision_role_name');
        target_password text :=
          current_setting('ucm.provision_role_password');
        related_role text;
        failure_state text;
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = target_role
        ) THEN
          EXECUTE format(
            'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
            target_role,
            target_password
          );
        ELSE
          EXECUTE format(
            'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
            target_role,
            target_password
          );
        END IF;
        FOR related_role IN
          SELECT parent_role.rolname
          FROM pg_auth_members membership
          JOIN pg_roles parent_role
            ON parent_role.oid = membership.roleid
          JOIN pg_roles member_role
            ON member_role.oid = membership.member
          WHERE member_role.rolname = target_role
        LOOP
          EXECUTE format(
            'REVOKE %I FROM %I',
            related_role,
            target_role
          );
        END LOOP;
        FOR related_role IN
          SELECT member_role.rolname
          FROM pg_auth_members membership
          JOIN pg_roles parent_role
            ON parent_role.oid = membership.roleid
          JOIN pg_roles member_role
            ON member_role.oid = membership.member
          WHERE parent_role.rolname = target_role
        LOOP
          EXECUTE format(
            'REVOKE %I FROM %I',
            target_role,
            related_role
          );
        END LOOP;
      EXCEPTION
        WHEN query_canceled OR assert_failure THEN
          GET STACKED DIAGNOSTICS
            failure_state = RETURNED_SQLSTATE;
          RAISE EXCEPTION USING
            ERRCODE = failure_state,
            MESSAGE =
              'application database role provisioning failed';
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            failure_state = RETURNED_SQLSTATE;
          RAISE EXCEPTION USING
            ERRCODE = failure_state,
            MESSAGE =
              'application database role provisioning failed';
      END
      $ucm_application_role$;
    `);
    const ownership = await transaction.one<{
      owns_objects: boolean;
    }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_database target
              ON target.datdba = role.oid
            WHERE role.rolname = $1
              AND target.datname = current_database()
          )
          OR EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_namespace target
              ON target.nspowner = role.oid
            WHERE role.rolname = $1
          )
          OR EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_class target
              ON target.relowner = role.oid
            WHERE role.rolname = $1
          )
          OR EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_proc target
              ON target.proowner = role.oid
            WHERE role.rolname = $1
          )
          OR EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_type target
              ON target.typowner = role.oid
            WHERE role.rolname = $1
          )
          OR EXISTS (
            SELECT 1
            FROM pg_roles role
            JOIN pg_extension target
              ON target.extowner = role.oid
            WHERE role.rolname = $1
          )
          AS owns_objects
      `,
      [roleName],
    );
    if (ownership.owns_objects) {
      throw new Error("database-application-role-owns-objects");
    }
    await transaction.query(
      `REVOKE ALL PRIVILEGES ON DATABASE ${databaseName} FROM PUBLIC`,
    );
    await transaction.query(
      "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC",
    );
    await transaction.query(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC",
    );
    await transaction.query(
      "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`,
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC`,
    );
    await transaction.query(
      `REVOKE ALL PRIVILEGES ON DATABASE ${databaseName} FROM ${role}`,
    );
    await transaction.query(
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role}`,
    );
    await transaction.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`,
    );
    await transaction.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`,
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`,
    );
    await transaction.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${role}`);
    await transaction.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await transaction.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await transaction.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await transaction.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    );
    await transaction.query(
      `REVOKE UPDATE, DELETE ON
         public.source_documents,
         public.catalogue_releases,
         public.catalogue_items,
         public.audit_ledger
       FROM ${role}`,
    );
  });
}

export const LATEST_DATABASE_MIGRATION =
  migrations.at(-1)?.version ?? 0;

function queryable(
  executor: Pick<Pool | PoolClient, "query">,
): Queryable {
  const query = async <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> =>
    await executor.query<Row>(text, values ? [...values] : undefined);

  return {
    query,
    async one<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<Row> {
      const result = await query<Row>(text, values);
      if (result.rows.length !== 1) {
        throw new Error(`database-one-expected-one-row:${result.rows.length}`);
      }
      return result.rows[0]!;
    },
    async maybeOne<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<Row | null> {
      const result = await query<Row>(text, values);
      if (result.rows.length > 1) {
        throw new Error(`database-maybe-one-returned-many:${result.rows.length}`);
      }
      return result.rows[0] ?? null;
    },
  };
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
