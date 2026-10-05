import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runAtomicPostgresRestore,
  runPostgresCommand as runCommand,
} from "./postgres-process.mjs";

export const BACKUP_FORMAT = "ucm-costing-postgres-backup";
export const BACKUP_FORMAT_VERSION = 2;
export const DATABASE_DUMP_FILENAME = "ucm.dump";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function operationalPaths(environment = process.env) {
  return {
    repositoryRoot,
    dataRoot: path.resolve(
      environment.UCM_DATA_ROOT ?? path.join(repositoryRoot, "data"),
    ),
    outputRoot: path.resolve(
      environment.UCM_OUTPUT_ROOT ?? path.join(repositoryRoot, "output"),
    ),
    backupRoot: path.resolve(
      environment.UCM_BACKUP_ROOT ?? path.join(repositoryRoot, "backups"),
    ),
    databaseUrl: environment.DATABASE_URL,
  };
}

export function defaultBackupName(date = new Date()) {
  const timestamp = date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
  return `ucm-costing-${timestamp}`;
}

export function validateBackupName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(
      "Backup names must be 1-128 characters and contain only letters, numbers, dot, underscore, or hyphen.",
    );
  }
  return name;
}

export function createPostgresOperations(databaseUrl) {
  const connection = postgresEnvironment(databaseUrl);
  return {
    async dump(destination) {
      await runCommand(
        "pg_dump",
        [
          "--format=custom",
          "--compress=6",
          "--no-password",
          "--file",
          destination,
        ],
        connection.environment,
      );
    },
    async verifyDump(filename) {
      await verifyPostgresDump(filename);
    },
    async inspect() {
      const hasMigrations =
        (await psqlScalar(
          "SELECT to_regclass('public.schema_migrations') IS NOT NULL",
          connection.environment,
        )) === "t";
      const schemaVersion = hasMigrations
        ? Number(
            await psqlScalar(
              "SELECT COALESCE(MAX(version), 0)::integer FROM schema_migrations",
              connection.environment,
            ),
          )
        : 0;
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error("PostgreSQL returned an invalid migration version.");
      }
      const serverVersion = await psqlScalar(
        "SHOW server_version",
        connection.environment,
      );
      const databaseName = await psqlScalar(
        "SELECT current_database()",
        connection.environment,
      );
      return { databaseName, schemaVersion, serverVersion };
    },
    async hasManagedState() {
      return (
        (await psqlScalar(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_class AS relation
              JOIN pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'public'
                AND relation.relkind IN ('r', 'p', 'S', 'v', 'm')
            )
          `,
          connection.environment,
        )) === "t"
      );
    },
    async restore(filename) {
      await assertRegularFile(filename, "PostgreSQL dump");
      await runAtomicPostgresRestore(
        filename,
        connection.environment,
      );
    },
  };
}

export async function createBackup({
  name = defaultBackupName(),
  paths = operationalPaths(),
  postgres = createPostgresOperations(paths.databaseUrl),
} = {}) {
  validateBackupName(name);
  await mkdir(paths.backupRoot, { recursive: true });

  const finalRoot = path.join(paths.backupRoot, name);
  if (await pathExists(finalRoot)) {
    throw new Error(`Backup already exists: ${finalRoot}`);
  }
  const temporaryRoot = path.join(
    paths.backupRoot,
    `.backup-${process.pid}-${randomUUID()}`,
  );
  const databaseDump = path.join(
    temporaryRoot,
    "database",
    DATABASE_DUMP_FILENAME,
  );
  await mkdir(path.dirname(databaseDump), { recursive: true });

  try {
    const before = await postgres.inspect();
    await postgres.dump(databaseDump);
    await postgres.verifyDump(databaseDump);
    const after = await postgres.inspect();
    if (before.schemaVersion !== after.schemaVersion) {
      throw new Error(
        "Database migration version changed while the backup was running.",
      );
    }

    await copyTreeIfPresent(
      path.join(paths.dataRoot, "uploads"),
      path.join(temporaryRoot, "data", "uploads"),
    );
    await copyTreeIfPresent(
      path.join(paths.dataRoot, "reports"),
      path.join(temporaryRoot, "data", "reports"),
    );
    await copyTreeIfPresent(
      path.join(paths.dataRoot, "artifacts"),
      path.join(temporaryRoot, "data", "artifacts"),
    );
    await copyTreeIfPresent(
      path.join(paths.outputRoot, "pdf"),
      path.join(temporaryRoot, "output", "pdf"),
    );

    const files = await describeFiles(temporaryRoot);
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      application: "UCM Costing",
      database: {
        filename: DATABASE_DUMP_FILENAME,
        archiveFormat: "postgres-custom",
        databaseName: before.databaseName,
        schemaVersion: before.schemaVersion,
        serverVersion: before.serverVersion,
      },
      files,
    };
    await writeFile(
      path.join(temporaryRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    const verified = await verifyBackup(temporaryRoot, {
      verifyDump: postgres.verifyDump,
    });
    await rename(temporaryRoot, finalRoot);
    return {
      backupRoot: finalRoot,
      manifest,
      manifestSha256: verified.manifestSha256,
    };
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

export async function verifyBackup(
  backupRoot,
  { verifyDump = verifyPostgresDump } = {},
) {
  const resolvedRoot = path.resolve(backupRoot);
  await assertDirectory(resolvedRoot, "Backup root");
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  await assertRegularFile(manifestPath, "Backup manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);

  const actualFiles = await describeFiles(resolvedRoot, {
    exclude: new Set(["manifest.json"]),
  });
  const expectedByPath = new Map(
    manifest.files.map((entry) => [entry.path, entry]),
  );
  const actualByPath = new Map(actualFiles.map((entry) => [entry.path, entry]));

  for (const expected of manifest.files) {
    const actual = actualByPath.get(expected.path);
    if (!actual) {
      throw new Error(`Backup file is missing: ${expected.path}`);
    }
    if (
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`Backup checksum mismatch: ${expected.path}`);
    }
  }
  for (const actual of actualFiles) {
    if (!expectedByPath.has(actual.path)) {
      throw new Error(`Backup contains an unlisted file: ${actual.path}`);
    }
  }

  await verifyDump(
    path.join(resolvedRoot, "database", DATABASE_DUMP_FILENAME),
  );
  return {
    backupRoot: resolvedRoot,
    manifest,
    manifestSha256: await sha256File(manifestPath),
  };
}

export async function copyVerifiedBackupToStaging(
  backupRoot,
  staging,
  { verifyDump = verifyPostgresDump } = {},
) {
  await verifyBackup(backupRoot, { verifyDump });
  await mkdir(staging.dataRoot, { recursive: true });
  await mkdir(staging.outputRoot, { recursive: true });
  await copyTreeIfPresent(
    path.join(backupRoot, "data", "uploads"),
    path.join(staging.dataRoot, "uploads"),
  );
  await copyTreeIfPresent(
    path.join(backupRoot, "data", "reports"),
    path.join(staging.dataRoot, "reports"),
  );
  await copyTreeIfPresent(
    path.join(backupRoot, "data", "artifacts"),
    path.join(staging.dataRoot, "artifacts"),
  );
  await copyTreeIfPresent(
    path.join(backupRoot, "output", "pdf"),
    path.join(staging.outputRoot, "pdf"),
  );
  await mkdir(path.join(staging.dataRoot, "uploads"), { recursive: true });
  await mkdir(path.join(staging.dataRoot, "reports"), { recursive: true });
  await mkdir(path.join(staging.dataRoot, "artifacts"), { recursive: true });
  await mkdir(path.join(staging.outputRoot, "pdf"), { recursive: true });
}

export async function rootHasManagedState(paths, postgres) {
  if (await postgres.hasManagedState()) {
    return true;
  }
  const managedPaths = [
    path.join(paths.dataRoot, "uploads"),
    path.join(paths.dataRoot, "reports"),
    path.join(paths.dataRoot, "artifacts"),
    path.join(paths.outputRoot, "pdf"),
  ];
  for (const managedPath of managedPaths) {
    if (!(await pathExists(managedPath))) {
      continue;
    }
    const metadata = await stat(managedPath);
    if (metadata.isFile()) {
      return true;
    }
    if (metadata.isDirectory() && (await readdir(managedPath)).length > 0) {
      return true;
    }
  }
  return false;
}

export async function replaceManagedState(
  paths,
  staging,
  {
    recoveryDescription = "the pre-restore recovery backup",
    replaceDatabase,
    rollbackDatabase,
    validateDatabase = async () => {},
    validateManagedState = async () => {},
    validateRollback = async () => {},
  },
) {
  for (const [name, operation] of Object.entries({
    replaceDatabase,
    rollbackDatabase,
    validateDatabase,
    validateManagedState,
    validateRollback,
  })) {
    if (typeof operation !== "function") {
      throw new TypeError(`${name} must be a function.`);
    }
  }

  const recoveryId = `.restore-rollback-${process.pid}-${randomUUID()}`;
  const dataRecovery = path.join(paths.dataRoot, recoveryId);
  const outputRecovery = path.join(paths.outputRoot, recoveryId);
  await mkdir(paths.dataRoot, { recursive: true });
  await mkdir(paths.outputRoot, { recursive: true });
  await mkdir(dataRecovery, { recursive: true });
  await mkdir(outputRecovery, { recursive: true });

  const managed = [
    {
      sourceRoot: paths.dataRoot,
      stagingRoot: staging.dataRoot,
      recoveryRoot: dataRecovery,
      names: ["uploads", "reports", "artifacts"],
    },
    {
      sourceRoot: paths.outputRoot,
      stagingRoot: staging.outputRoot,
      recoveryRoot: outputRecovery,
      names: ["pdf"],
    },
  ];
  const movedOld = [];
  const movedNew = [];
  let databaseReplacementAttempted = false;

  try {
    for (const group of managed) {
      for (const name of group.names) {
        const source = path.join(group.sourceRoot, name);
        if (await pathExists(source)) {
          const recovery = path.join(group.recoveryRoot, name);
          await rename(source, recovery);
          movedOld.push({ current: source, recovery });
        }
      }
    }
    for (const group of managed) {
      for (const name of group.names) {
        const source = path.join(group.stagingRoot, name);
        const destination = path.join(group.sourceRoot, name);
        await rename(source, destination);
        movedNew.push(destination);
      }
    }

    databaseReplacementAttempted = true;
    const database = await replaceDatabase();
    await validateDatabase(database);
    await validateManagedState();
    const cleanupWarnings = await removeRecoveryDirectories([
      dataRecovery,
      outputRecovery,
    ]);
    return { cleanupWarnings, value: database };
  } catch (error) {
    if (databaseReplacementAttempted) {
      try {
        await rollbackDatabase();
      } catch (rollbackError) {
        throw rollbackFailureError({
          error,
          recoveryDescription,
          rollbackError,
          preservedPaths: [dataRecovery, outputRecovery],
        });
      }
    }

    const fileRollbackErrors = await rollbackManagedFiles(
      movedNew,
      movedOld,
    );
    if (fileRollbackErrors.length > 0) {
      throw rollbackFailureError({
        error,
        recoveryDescription,
        rollbackError: new AggregateError(
          fileRollbackErrors,
          "Managed-file rollback failed.",
        ),
        preservedPaths: [dataRecovery, outputRecovery],
      });
    }

    try {
      await validateRollback();
    } catch (rollbackValidationError) {
      throw rollbackFailureError({
        error,
        recoveryDescription,
        rollbackError: rollbackValidationError,
        preservedPaths: [dataRecovery, outputRecovery],
      });
    }

    const cleanupWarnings = await removeRecoveryDirectories([
      dataRecovery,
      outputRecovery,
    ]);
    throw rollbackCompletedError(error, cleanupWarnings);
  }
}

export async function verifyManagedFiles(paths, manifest) {
  validateManifest(manifest);
  const expectedFiles = manifest.files.filter(
    (entry) =>
      entry.path.startsWith("data/uploads/") ||
      entry.path.startsWith("data/reports/") ||
      entry.path.startsWith("data/artifacts/") ||
      entry.path.startsWith("output/pdf/"),
  );
  const actualFiles = await describeManagedFiles(paths);
  const expectedByPath = new Map(
    expectedFiles.map((entry) => [entry.path, entry]),
  );
  const actualByPath = new Map(
    actualFiles.map((entry) => [entry.path, entry]),
  );

  for (const expected of expectedFiles) {
    const actual = actualByPath.get(expected.path);
    if (!actual) {
      throw new Error(`Restored managed file is missing: ${expected.path}`);
    }
    if (
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(
        `Restored managed-file checksum mismatch: ${expected.path}`,
      );
    }
  }
  for (const actual of actualFiles) {
    if (!expectedByPath.has(actual.path)) {
      throw new Error(
        `Restored state contains an unexpected managed file: ${actual.path}`,
      );
    }
  }
}

export async function verifyPostgresDump(filename) {
  await assertRegularFile(filename, "PostgreSQL dump");
  await runCommand("pg_restore", ["--list", filename], process.env);
}

async function describeManagedFiles(paths) {
  const managedRoots = [
    {
      absolute: path.join(paths.dataRoot, "uploads"),
      prefix: "data/uploads",
    },
    {
      absolute: path.join(paths.dataRoot, "reports"),
      prefix: "data/reports",
    },
    {
      absolute: path.join(paths.dataRoot, "artifacts"),
      prefix: "data/artifacts",
    },
    {
      absolute: path.join(paths.outputRoot, "pdf"),
      prefix: "output/pdf",
    },
  ];
  const files = [];
  for (const managedRoot of managedRoots) {
    if (!(await pathExists(managedRoot.absolute))) {
      continue;
    }
    await assertDirectory(managedRoot.absolute, "Managed file directory");
    for (const entry of await describeFiles(managedRoot.absolute)) {
      files.push({
        ...entry,
        path: `${managedRoot.prefix}/${entry.path}`,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function rollbackManagedFiles(movedNew, movedOld) {
  const errors = [];
  for (const destination of [...movedNew].reverse()) {
    try {
      await rm(destination, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const moved of [...movedOld].reverse()) {
    try {
      if (await pathExists(moved.recovery)) {
        await rename(moved.recovery, moved.current);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function removeRecoveryDirectories(directories) {
  const warnings = [];
  for (const directory of directories) {
    try {
      await rm(directory, { force: true, recursive: true });
    } catch (error) {
      warnings.push(
        `Could not remove restore staging directory ${directory}: ${error.message}`,
      );
    }
  }
  return warnings;
}

function rollbackCompletedError(error, cleanupWarnings) {
  const warning =
    cleanupWarnings.length === 0
      ? ""
      : ` Cleanup warning: ${cleanupWarnings.join(" ")}`;
  const wrapped = new Error(
    `Restore failed, and the database and managed files were automatically rolled back: ${error.message}.${warning}`,
    { cause: error },
  );
  wrapped.name = "RestoreRolledBackError";
  return wrapped;
}

function rollbackFailureError({
  error,
  recoveryDescription,
  rollbackError,
  preservedPaths,
}) {
  return new AggregateError(
    [error, rollbackError],
    [
      "RESTORE FAILED AND AUTOMATIC ROLLBACK DID NOT COMPLETE.",
      "Keep the application stopped.",
      `Recover from ${recoveryDescription}.`,
      `Preserved file rollback directories: ${preservedPaths.join(", ")}.`,
    ].join(" "),
    { cause: error },
  );
}

async function psqlScalar(sql, environment) {
  const output = await runCommand(
    "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--command",
      sql,
    ],
    environment,
  );
  return output.trim();
}

function postgresEnvironment(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") {
    throw new Error("DATABASE_URL is required for PostgreSQL backup/restore.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseName) {
    throw new Error("DATABASE_URL must name a PostgreSQL database.");
  }
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  environment.PGHOST = parsed.hostname;
  environment.PGPORT = parsed.port || "5432";
  environment.PGDATABASE = databaseName;
  environment.PGUSER = decodeURIComponent(parsed.username);
  environment.PGPASSWORD = decodeURIComponent(parsed.password);
  environment.PGCONNECT_TIMEOUT = "10";
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) {
    environment.PGSSLMODE = sslMode;
  }
  return { databaseName, environment };
}

async function copyTreeIfPresent(source, destination) {
  if (!(await pathExists(source))) {
    return;
  }
  await assertDirectory(source, "Managed file directory");
  await assertTreeHasOnlyRegularFiles(source, source);
  await cp(source, destination, {
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function assertTreeHasOnlyRegularFiles(root, current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing managed symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await assertTreeHasOnlyRegularFiles(root, absolutePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Refusing managed non-regular file: ${relativePath}`);
    }
  }
}

async function describeFiles(root, { exclude = new Set() } = {}) {
  const files = [];
  await walkFiles(root, root, files, exclude);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function walkFiles(root, current, files, exclude) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    if (exclude.has(relativePath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Backup contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, files, exclude);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Backup contains a non-regular file: ${relativePath}`);
    }
    const metadata = await stat(absolutePath);
    files.push({
      path: relativePath,
      bytes: metadata.size,
      sha256: await sha256File(absolutePath),
    });
  }
}

async function sha256File(filename) {
  const handle = await open(filename, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) {
      hash.update(Buffer.from(chunk));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.format !== BACKUP_FORMAT ||
    manifest.formatVersion !== BACKUP_FORMAT_VERSION
  ) {
    throw new Error("Unsupported or invalid UCM Costing backup manifest.");
  }
  if (
    !manifest.database ||
    manifest.database.filename !== DATABASE_DUMP_FILENAME ||
    manifest.database.archiveFormat !== "postgres-custom" ||
    typeof manifest.database.databaseName !== "string" ||
    typeof manifest.database.serverVersion !== "string" ||
    !Number.isSafeInteger(manifest.database.schemaVersion) ||
    manifest.database.schemaVersion < 0
  ) {
    throw new Error("Backup manifest has invalid database metadata.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Backup manifest does not list any files.");
  }

  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Backup manifest contains an invalid file entry.");
    }
    const normalized = path.posix.normalize(file.path);
    if (
      normalized !== file.path ||
      path.posix.isAbsolute(file.path) ||
      file.path.startsWith("../") ||
      (!file.path.startsWith("database/") &&
        !file.path.startsWith("data/") &&
        !file.path.startsWith("output/"))
    ) {
      throw new Error(`Unsafe path in backup manifest: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate path in backup manifest: ${file.path}`);
    }
    seen.add(file.path);
  }
  if (!seen.has(`database/${DATABASE_DUMP_FILENAME}`)) {
    throw new Error("Backup manifest does not contain the PostgreSQL dump.");
  }
}

async function assertRegularFile(filename, label) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filename}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filename}`);
  }
}

async function assertDirectory(filename, label) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filename}`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a directory: ${filename}`);
  }
}

export async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
