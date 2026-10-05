import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  DATABASE_DUMP_FILENAME,
  copyVerifiedBackupToStaging,
  createBackup,
  replaceManagedState,
  rootHasManagedState,
  verifyBackup,
  verifyManagedFiles,
} from "./backup-lib.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

test("creates a PostgreSQL custom-dump backup and detects file tampering", async () => {
  const fixture = await makeFixture();
  const postgres = fakePostgres({ marker: "known-good" });
  const result = await createBackup({
    name: "test-backup",
    paths: fixture.paths,
    postgres,
  });

  assert.equal(result.manifest.database.archiveFormat, "postgres-custom");
  assert.equal(result.manifest.database.schemaVersion, 3);
  assert.equal(result.manifest.database.serverVersion, "15.13");
  assert.equal(
    result.manifest.files.some(
      (entry) =>
        entry.path === `database/${DATABASE_DUMP_FILENAME}`,
    ),
    true,
  );
  assert.equal(
    result.manifest.files.some(
      (entry) =>
        entry.path === "data/artifacts/supporting.xlsx",
    ),
    true,
  );
  await verifyBackup(result.backupRoot, {
    verifyDump: postgres.verifyDump,
  });

  await writeFile(
    path.join(result.backupRoot, "data", "uploads", "drawing.txt"),
    "changed",
  );
  await assert.rejects(
    verifyBackup(result.backupRoot, {
      verifyDump: postgres.verifyDump,
    }),
    /checksum mismatch/,
  );
});

test("restores verified managed files with the matching database dump", async () => {
  const source = await makeFixture();
  const sourcePostgres = fakePostgres({ marker: "known-good" });
  const backup = await createBackup({
    name: "known-good",
    paths: source.paths,
    postgres: sourcePostgres,
  });

  const destinationRoot = await mkdtemp(
    path.join(tmpdir(), "ucm-restore-test-"),
  );
  temporaryRoots.push(destinationRoot);
  const destination = {
    dataRoot: path.join(destinationRoot, "data"),
    outputRoot: path.join(destinationRoot, "output"),
    backupRoot: source.paths.backupRoot,
  };
  await mkdir(path.join(destination.dataRoot, "uploads"), {
    recursive: true,
  });
  await writeFile(
    path.join(destination.dataRoot, "uploads", "existing.txt"),
    "existing",
  );

  const targetPostgres = fakePostgres({
    marker: "old",
    managedState: true,
  });
  assert.equal(
    await rootHasManagedState(destination, targetPostgres),
    true,
  );

  const staging = {
    dataRoot: path.join(destinationRoot, "stage-data"),
    outputRoot: path.join(destinationRoot, "stage-output"),
  };
  await copyVerifiedBackupToStaging(backup.backupRoot, staging, {
    verifyDump: sourcePostgres.verifyDump,
  });
  const replacement = await replaceManagedState(
    destination,
    staging,
    {
      async replaceDatabase() {
        await targetPostgres.restore(
          databaseDumpPath(backup.backupRoot),
        );
        return await targetPostgres.inspect();
      },
      async rollbackDatabase() {
        throw new Error("rollback must not run on success");
      },
      async validateManagedState() {
        await verifyManagedFiles(destination, backup.manifest);
      },
    },
  );
  const restored = replacement.value;

  assert.equal(restored.schemaVersion, 3);
  assert.deepEqual(replacement.cleanupWarnings, []);
  assert.equal(targetPostgres.marker(), "known-good");
  assert.equal(
    await readFile(
      path.join(destination.dataRoot, "uploads", "drawing.txt"),
      "utf8",
    ),
    "drawing",
  );
  assert.equal(
    await readFile(
      path.join(
        destination.dataRoot,
        "artifacts",
        "supporting.xlsx",
      ),
      "utf8",
    ),
    "xlsx",
  );
  await assert.rejects(
    readFile(
      path.join(destination.dataRoot, "uploads", "existing.txt"),
      "utf8",
    ),
    /ENOENT/,
  );
});

test("rolls managed files back when database restore fails", async () => {
  const fixture = await makeFixture();
  const staging = {
    dataRoot: path.join(fixture.root, "staging-data"),
    outputRoot: path.join(fixture.root, "staging-output"),
  };
  await mkdir(path.join(staging.dataRoot, "uploads"), { recursive: true });
  await mkdir(path.join(staging.dataRoot, "reports"), { recursive: true });
  await mkdir(path.join(staging.dataRoot, "artifacts"), {
    recursive: true,
  });
  await mkdir(path.join(staging.outputRoot, "pdf"), { recursive: true });
  await writeFile(
    path.join(staging.dataRoot, "uploads", "replacement.txt"),
    "replacement",
  );

  await assert.rejects(
    replaceManagedState(fixture.paths, staging, {
      async replaceDatabase() {
        throw new Error("restore transaction failed");
      },
      async rollbackDatabase() {},
    }),
    /restore transaction failed/,
  );
  assert.equal(
    await readFile(
      path.join(fixture.paths.dataRoot, "uploads", "drawing.txt"),
      "utf8",
    ),
    "drawing",
  );
});

test("rolls PostgreSQL and managed files back after committed restore validation fails", async () => {
  const fixture = await makeFixture();
  const sourcePostgres = fakePostgres({ marker: "replacement" });
  const sourceBackup = await createBackup({
    name: "replacement",
    paths: fixture.paths,
    postgres: sourcePostgres,
  });

  await writeFile(
    path.join(fixture.paths.dataRoot, "uploads", "drawing.txt"),
    "original-live-file",
  );
  const targetPostgres = fakePostgres({
    marker: "original-live-database",
    managedState: true,
  });
  const recoveryBackup = await createBackup({
    name: "pre-restore-test",
    paths: fixture.paths,
    postgres: targetPostgres,
  });
  const staging = {
    dataRoot: path.join(fixture.root, "validation-stage-data"),
    outputRoot: path.join(fixture.root, "validation-stage-output"),
  };
  await copyVerifiedBackupToStaging(sourceBackup.backupRoot, staging, {
    verifyDump: sourcePostgres.verifyDump,
  });

  let replacementCommitted = false;
  await assert.rejects(
    replaceManagedState(fixture.paths, staging, {
      recoveryDescription: recoveryBackup.backupRoot,
      async replaceDatabase() {
        await targetPostgres.restore(
          databaseDumpPath(sourceBackup.backupRoot),
        );
        replacementCommitted = true;
        return await targetPostgres.inspect();
      },
      async validateDatabase() {
        assert.equal(targetPostgres.marker(), "replacement");
        throw new Error("post-commit migration validation failed");
      },
      async rollbackDatabase() {
        await targetPostgres.restore(
          databaseDumpPath(recoveryBackup.backupRoot),
        );
      },
      async validateRollback() {
        assert.equal(
          targetPostgres.marker(),
          "original-live-database",
        );
        await verifyManagedFiles(
          fixture.paths,
          recoveryBackup.manifest,
        );
      },
    }),
    (error) => {
      assert.equal(error.name, "RestoreRolledBackError");
      assert.match(error.message, /automatically rolled back/i);
      assert.match(
        error.message,
        /post-commit migration validation failed/,
      );
      return true;
    },
  );

  assert.equal(replacementCommitted, true);
  assert.equal(targetPostgres.marker(), "original-live-database");
  assert.equal(
    await readFile(
      path.join(fixture.paths.dataRoot, "uploads", "drawing.txt"),
      "utf8",
    ),
    "original-live-file",
  );
  await verifyBackup(sourceBackup.backupRoot, {
    verifyDump: sourcePostgres.verifyDump,
  });
  await verifyBackup(recoveryBackup.backupRoot, {
    verifyDump: targetPostgres.verifyDump,
  });
});

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ucm-backup-test-"));
  temporaryRoots.push(root);
  const paths = {
    dataRoot: path.join(root, "data"),
    outputRoot: path.join(root, "output"),
    backupRoot: path.join(root, "backups"),
  };
  await mkdir(path.join(paths.dataRoot, "uploads"), { recursive: true });
  await mkdir(path.join(paths.dataRoot, "reports"), { recursive: true });
  await mkdir(path.join(paths.dataRoot, "artifacts"), { recursive: true });
  await mkdir(path.join(paths.outputRoot, "pdf"), { recursive: true });
  await mkdir(paths.backupRoot, { recursive: true });
  await writeFile(
    path.join(paths.dataRoot, "uploads", "drawing.txt"),
    "drawing",
  );
  await writeFile(
    path.join(paths.dataRoot, "reports", "snapshot.json"),
    "{}\n",
  );
  await writeFile(
    path.join(paths.dataRoot, "artifacts", "supporting.xlsx"),
    "xlsx",
  );
  await writeFile(path.join(paths.outputRoot, "pdf", "report.pdf"), "%PDF");
  return { root, paths };
}

function fakePostgres({
  marker: initialMarker,
  managedState = true,
} = {}) {
  let marker = initialMarker ?? "fixture";
  return {
    marker: () => marker,
    async dump(destination) {
      await writeFile(
        destination,
        JSON.stringify({
          archive: "fake-postgres-custom",
          marker,
          schemaVersion: 3,
        }),
      );
    },
    async verifyDump(filename) {
      const archive = JSON.parse(await readFile(filename, "utf8"));
      if (archive.archive !== "fake-postgres-custom") {
        throw new Error("invalid PostgreSQL custom dump");
      }
    },
    async inspect() {
      return {
        databaseName: "ucm_test",
        schemaVersion: 3,
        serverVersion: "15.13",
      };
    },
    async hasManagedState() {
      return managedState;
    },
    async restore(filename) {
      const archive = JSON.parse(await readFile(filename, "utf8"));
      marker = archive.marker;
    },
  };
}

function databaseDumpPath(backupRoot) {
  return path.join(
    backupRoot,
    "database",
    DATABASE_DUMP_FILENAME,
  );
}
