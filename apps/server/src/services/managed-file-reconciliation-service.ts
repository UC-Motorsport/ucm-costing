import {
  lstat,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { QueryResultRow } from "pg";

import {
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../config";
import type { DbExecutor } from "../db/database";

interface ManagedPathRow extends QueryResultRow {
  storage_path: string;
}

export interface ManagedFileReconciliationResult {
  referenced: number;
  scanned: number;
  removed: number;
}

/**
 * Reconciles the application-owned file roots before the HTTP server starts.
 * A hard crash can occur after an atomic rename but before its database
 * completion record. Those unreferenced bytes are confidential orphans and
 * are removed here. Conversely, a database row that references a missing file
 * is a stop-startup integrity failure rather than a silently broken download.
 */
export async function reconcileManagedFiles(
  database: DbExecutor,
  paths: AppPaths,
): Promise<ManagedFileReconciliationResult> {
  const rows = await database.query<ManagedPathRow>(
    `
      SELECT storage_path
      FROM evidence
      UNION
      SELECT pdf_path AS storage_path
      FROM report_snapshots
      WHERE status = 'complete' AND pdf_path IS NOT NULL
      UNION
      SELECT storage_path
      FROM artifacts
      WHERE status = 'complete' AND storage_path IS NOT NULL
      ORDER BY storage_path
    `,
  );
  const referenced = new Set<string>();
  for (const row of rows.rows) {
    const absolute = resolveStoredDataPath(row.storage_path, paths);
    const stats = await lstat(absolute).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        throw new Error(
          `managed-file-reference-missing:${toStoredDataPath(absolute, paths)}`,
        );
      }
      throw error;
    });
    if (!stats.isFile()) {
      throw new Error(
        `managed-file-reference-not-regular:${toStoredDataPath(absolute, paths)}`,
      );
    }
    referenced.add(toStoredDataPath(absolute, paths));
  }

  const roots = [
    paths.uploadRoot,
    paths.reportRoot,
    path.join(paths.dataRoot, "artifacts"),
  ];
  let scanned = 0;
  let removed = 0;
  for (const root of roots) {
    for (const absolute of await listManagedEntries(root)) {
      scanned += 1;
      const storedPath = toStoredDataPath(absolute, paths);
      if (referenced.has(storedPath)) {
        continue;
      }
      await unlink(absolute);
      removed += 1;
    }
  }

  const result = {
    referenced: referenced.size,
    scanned,
    removed,
  };
  await database.query(
    `
      INSERT INTO app_metadata(key, value, updated_at)
      VALUES (
        'managed-file-reconciliation',
        $1,
        clock_timestamp()
      )
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `,
    [JSON.stringify({ ...result, completedAt: new Date().toISOString() })],
  );
  return result;
}

async function listManagedEntries(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Never follow a symlink from an application-owned directory. An
        // unreferenced symlink itself is safely unlinked like any other orphan.
        result.push(absolute);
      } else {
        throw new Error(
          `managed-file-type-unsupported:${entry.name}`,
        );
      }
    }
  }
  return result.sort();
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
