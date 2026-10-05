#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBackup,
  operationalPaths,
  validateBackupName,
  verifyBackup,
} from "./backup-lib.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const paths = operationalPaths();

  if (options.verify) {
    const backupRoot = path.join(
      paths.backupRoot,
      validateBackupName(options.verify),
    );
    const result = await verifyBackup(backupRoot);
    console.log(
      JSON.stringify(
        {
          status: "verified",
          backup: result.backupRoot,
          createdAt: result.manifest.createdAt,
          files: result.manifest.files.length,
          schemaVersion: result.manifest.database.schemaVersion,
          manifestSha256: result.manifestSha256,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await createBackup({
    name: options.name,
    paths,
  });
  console.log(
    JSON.stringify(
      {
        status: "created-and-verified",
        backup: result.backupRoot,
        createdAt: result.manifest.createdAt,
        files: result.manifest.files.length,
        schemaVersion: result.manifest.database.schemaVersion,
        manifestSha256: result.manifestSha256,
      },
      null,
      2,
    ),
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--name") {
      options.name = requireValue(argv, ++index, "--name");
      continue;
    }
    if (argument === "--verify") {
      options.verify = requireValue(argv, ++index, "--verify");
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.name && options.verify) {
    throw new Error("--name and --verify cannot be used together.");
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
  node scripts/backup.mjs [--name NAME]
  node scripts/backup.mjs --verify NAME

The database is captured as a PostgreSQL custom-format dump. Uploads,
immutable report files, and exported PDFs are copied into the same checksummed
backup. Quiesce application writes before creating a backup.`);
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
