import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppPaths } from "../src/config";
import type { DbExecutor } from "../src/db/database";
import {
  reconcileManagedFiles,
} from "../src/services/managed-file-reconciliation-service";

describe("managed-file crash reconciliation", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("keeps referenced bytes and removes final, temporary, and symlink orphans", async () => {
    const paths = await temporaryPaths();
    const evidence = path.join(paths.uploadRoot, "project", "evidence.pdf");
    const report = path.join(paths.reportRoot, "report.pdf");
    const orphan = path.join(
      paths.dataRoot,
      "artifacts",
      "project",
      "orphan.xlsx",
    );
    const temporary = path.join(paths.reportRoot, ".crashed.pdf.tmp");
    const symlinkPath = path.join(paths.uploadRoot, "orphan-link");
    await Promise.all(
      [evidence, report, orphan, temporary].map(async (file) => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, path.basename(file), "utf8");
      }),
    );
    await symlink(orphan, symlinkPath);

    const metadataWrites: unknown[][] = [];
    const database = fakeDatabase(
      [
        { storage_path: "uploads/project/evidence.pdf" },
        { storage_path: "reports/report.pdf" },
      ],
      metadataWrites,
    );
    await expect(reconcileManagedFiles(database, paths)).resolves.toEqual({
      referenced: 2,
      scanned: 5,
      removed: 3,
    });
    await expect(access(evidence)).resolves.toBeUndefined();
    await expect(access(report)).resolves.toBeUndefined();
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(symlinkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(metadataWrites).toHaveLength(1);
  });

  it("fails startup when PostgreSQL references missing managed bytes", async () => {
    const paths = await temporaryPaths();
    const database = fakeDatabase(
      [{ storage_path: "reports/missing.pdf" }],
      [],
    );
    await expect(
      reconcileManagedFiles(database, paths),
    ).rejects.toThrow(
      "managed-file-reference-missing:reports/missing.pdf",
    );
  });

  async function temporaryPaths(): Promise<AppPaths> {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ucm-managed-file-reconciliation-"),
    );
    temporaryRoots.push(root);
    const dataRoot = path.join(root, "data");
    return {
      repositoryRoot: root,
      dataRoot,
      uploadRoot: path.join(dataRoot, "uploads"),
      reportRoot: path.join(dataRoot, "reports"),
      outputPdfRoot: path.join(root, "output", "pdf"),
      webDistRoot: path.join(root, "web"),
    };
  }
});

function fakeDatabase(
  references: Array<{ storage_path: string }>,
  metadataWrites: unknown[][],
): DbExecutor {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("SELECT storage_path")) {
        return {
          rows: references as Row[],
          rowCount: references.length,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }
      metadataWrites.push([...(values ?? [])]);
      return {
        rows: [],
        rowCount: 1,
        command: "INSERT",
        oid: 0,
        fields: [],
      };
    },
    async one() {
      throw new Error("unexpected-one-query");
    },
    async maybeOne() {
      throw new Error("unexpected-maybe-one-query");
    },
  } as DbExecutor;
}
