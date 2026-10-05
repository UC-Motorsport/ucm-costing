#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATABASE_DUMP_FILENAME,
  copyVerifiedBackupToStaging,
  createBackup,
  createPostgresOperations,
  operationalPaths,
  replaceManagedState,
  rootHasManagedState,
  validateBackupName,
  verifyBackup,
  verifyManagedFiles,
} from "./backup-lib.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const paths = operationalPaths();
  const postgres = createPostgresOperations(paths.databaseUrl);
  const sourceName = validateBackupName(options.from);
  const sourceRoot = path.join(paths.backupRoot, sourceName);
  const verified = await verifyBackup(sourceRoot, {
    verifyDump: postgres.verifyDump,
  });

  const destinationHasState = await rootHasManagedState(paths, postgres);
  if (destinationHasState && !options.replace) {
    throw new Error(
      "The destination contains application state. Stop the app, create a fresh backup, and pass --replace to authorize replacement.",
    );
  }

  const recoveryBackup = await createBackup({
    name: `pre-restore-${timestamp()}-${randomUUID().slice(0, 8)}`,
    paths,
    postgres,
  });

  const stagingId = `.restore-stage-${process.pid}-${randomUUID()}`;
  const staging = {
    dataRoot: path.join(paths.dataRoot, stagingId),
    outputRoot: path.join(paths.outputRoot, stagingId),
  };
  await mkdir(staging.dataRoot, { recursive: true });
  await mkdir(staging.outputRoot, { recursive: true });

  try {
    await copyVerifiedBackupToStaging(sourceRoot, staging, {
      verifyDump: postgres.verifyDump,
    });
    const replacement = await replaceManagedState(
      paths,
      staging,
      {
        recoveryDescription: recoveryBackup.backupRoot,
        async replaceDatabase() {
          await postgres.restore(databaseDumpPath(sourceRoot));
          return await postgres.inspect();
        },
        async validateDatabase(inspected) {
          assertSchemaVersion(
            inspected,
            verified.manifest.database.schemaVersion,
            "Restored",
          );
        },
        async validateManagedState() {
          await verifyManagedFiles(paths, verified.manifest);
        },
        async rollbackDatabase() {
          await postgres.restore(
            databaseDumpPath(recoveryBackup.backupRoot),
          );
          const inspected = await postgres.inspect();
          assertSchemaVersion(
            inspected,
            recoveryBackup.manifest.database.schemaVersion,
            "Recovery",
          );
        },
        async validateRollback() {
          await verifyManagedFiles(paths, recoveryBackup.manifest);
        },
      },
    );
    const database = replacement.value;
    console.log(
      JSON.stringify(
        {
          status: "restored-and-verified",
          source: verified.backupRoot,
          destination: {
            database: database.databaseName,
            dataRoot: paths.dataRoot,
            outputRoot: paths.outputRoot,
          },
          schemaVersion: database.schemaVersion,
          recoveryBackup: recoveryBackup.backupRoot,
          cleanupWarnings: replacement.cleanupWarnings,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(staging.dataRoot, { force: true, recursive: true });
    await rm(staging.outputRoot, { force: true, recursive: true });
  }
}

function databaseDumpPath(backupRoot) {
  return path.join(
    backupRoot,
    "database",
    DATABASE_DUMP_FILENAME,
  );
}

function assertSchemaVersion(inspected, expected, label) {
  if (inspected.schemaVersion !== expected) {
    throw new Error(
      `${label} migration version mismatch: expected ${expected}, found ${inspected.schemaVersion}.`,
    );
  }
}

function parseArguments(argv) {
  const options = {
    from: null,
    replace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") {
      options.from = requireValue(argv, ++index, "--from");
      continue;
    }
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.from) {
    throw new Error("--from NAME is required.");
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/restore.mjs --from BACKUP_NAME [--replace]

The source must be beneath UCM_BACKUP_ROOT. The manifest, PostgreSQL custom
dump, and every managed-file checksum are verified before the destination is
touched. A non-empty destination is refused unless --replace is present.
Every restore first creates a verified recovery backup. Database replacement
is transactional. If database or managed-file validation fails after the new
database commits, the recovery database and files are restored automatically.

Stop the application before restore.`);
}

function timestamp(date = new Date()) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  });
}
