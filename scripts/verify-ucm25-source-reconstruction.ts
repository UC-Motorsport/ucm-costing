#!/usr/bin/env tsx
/** Import the source-backed archive into a disposable PostgreSQL database.
 *
 * The script exports the real historical report, commits one historical-to-
 * current copy only inside that disposable database, and exports the resulting
 * ordinary 2026 report.  The database and managed-file staging directory are
 * removed on completion; the two verification PDFs and JSON summary remain.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getAppPaths,
  resolveStoredDataPath,
  type AppPaths,
} from "../apps/server/src/config";
import { bootstrapAdministrator } from "../apps/server/src/security/auth-service";
import type { ActorContext } from "../apps/server/src/security/authorization";
import {
  commitProjectArchive,
  previewProjectArchive,
} from "../apps/server/src/services/project-archive-service";
import {
  commitProjectCopy,
  previewProjectCopy,
} from "../apps/server/src/services/project-copy-service";
import { storeEvidence } from "../apps/server/src/services/evidence-service";
import { installReferenceData } from "../apps/server/src/services/reference-data-service";
import { createReport } from "../apps/server/src/services/report-service";
import {
  ensureTeamWorkspace,
} from "../apps/server/src/services/workspace-service";
import { createPostgresTestDatabase } from "../apps/server/test/helpers/postgres";


const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(
  repositoryRoot,
  "outputs",
  "ucm25-source-reconstruction",
);
const archivePath = path.join(outputRoot, "ucm25-source-backed.ucm.zip");
const evidenceIndexPath = path.join(
  repositoryRoot,
  "tmp",
  "pdfs",
  "ucm25-evidence-source-v2",
  "evidence-index.json",
);
const historicalPdf = path.join(outputRoot, "app-source-backed-2025-export-v4.pdf");
const copied2026Pdf = path.join(outputRoot, "app-copied-2026-export-v4.pdf");
const resultPath = path.join(outputRoot, "local-import-export-verification-v4.json");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function persistReport(
  sourcePath: string,
  destination: string,
): Promise<{ path: string; bytes: number; sha256: string }> {
  await copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
  const bytes = await readFile(destination);
  return { path: destination, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function main(): Promise<void> {
  const archive = await readFile(archivePath);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ucm25-source-verify-"));
  const postgres = await createPostgresTestDatabase();
  try {
    const defaults = getAppPaths();
    const dataRoot = path.join(temporaryRoot, "data");
    const paths: AppPaths = {
      ...defaults,
      dataRoot,
      uploadRoot: path.join(dataRoot, "uploads"),
      reportRoot: path.join(dataRoot, "reports"),
      outputPdfRoot: path.join(temporaryRoot, "output", "pdf"),
      webDistRoot: path.join(temporaryRoot, "missing-web-dist"),
    };
    await mkdir(paths.uploadRoot, { recursive: true });
    await installReferenceData(postgres.database);
    const administrator = await bootstrapAdministrator(postgres.database, {
      email: "ucm25-source-verifier@example.test",
      displayName: "UCM25 Source Verifier",
    });
    const actor: ActorContext = {
      actorUserId: administrator.id,
      systemRole: "admin",
      requestId: "ucm25-source-verification",
      userAgent: null,
      ipAddressHash: null,
    };
    const current = await ensureTeamWorkspace(postgres.database);
    const target = {
      targetSeason: 2025,
      targetName: "UC Motorsport 2025 — Source Archive",
      targetEntryNumber: "E13",
      targetIsHistorical: true,
    };
    const archivePreview = await previewProjectArchive(
      postgres.database,
      archive,
      target,
    );
    if (archivePreview.conflicts.length > 0) {
      throw new Error(`archive conflicts: ${archivePreview.conflicts.join(", ")}`);
    }
    const imported = await commitProjectArchive(
      postgres.database,
      paths,
      actor,
      archive,
      {
        ...target,
        expectedArchiveSha256: archivePreview.archiveSha256,
        previewHash: archivePreview.previewHash,
        idempotencyKey: `ucm25-source-${archivePreview.archiveSha256}`,
      },
    );
    const repeatedImport = await commitProjectArchive(
      postgres.database,
      paths,
      actor,
      archive,
      {
        ...target,
        expectedArchiveSha256: archivePreview.archiveSha256,
        previewHash: archivePreview.previewHash,
        idempotencyKey: `ucm25-source-${archivePreview.archiveSha256}`,
      },
    );
    if (!repeatedImport.alreadyImported || repeatedImport.projectId !== imported.projectId) {
      throw new Error("archive import is not idempotent");
    }

    const evidenceIndex = JSON.parse(
      await readFile(evidenceIndexPath, "utf8"),
    ) as {
      uploadItems: Array<{
        path: string;
        displayName: string;
        mimeType: string;
        contentSha256: string;
        byteSize: number;
        kind: "other";
        reportCaption: string;
      }>;
    };
    for (const item of evidenceIndex.uploadItems) {
      const buffer = await readFile(path.join(repositoryRoot, item.path));
      if (buffer.byteLength !== item.byteSize || sha256(buffer) !== item.contentSha256) {
        throw new Error(`historical sidecar integrity mismatch: ${item.displayName}`);
      }
      await storeEvidence(
        postgres.database,
        paths,
        actor,
        imported.projectId,
        {
          fieldname: "file",
          originalname: item.displayName,
          encoding: "7bit",
          mimetype: item.mimeType,
          size: buffer.byteLength,
          buffer,
          destination: "",
          filename: item.displayName,
          path: item.path,
          stream: undefined as never,
        },
        {
          kind: item.kind,
          visibility: "report",
          reportCaption: item.reportCaption,
        },
        { allowHistorical: true },
      );
    }

    const historicalReport = await createReport(
      postgres.database,
      actor,
      imported.projectId,
      "export",
      { paths },
    );
    if (!historicalReport.pdf_path || historicalReport.status !== "complete") {
      throw new Error("historical report did not complete");
    }
    const historicalOutput = await persistReport(
      resolveStoredDataPath(historicalReport.pdf_path, paths),
      historicalPdf,
    );

    const sourceAssembly = await postgres.database.one<{ id: string }>(
      `
        SELECT id
        FROM cost_nodes
        WHERE project_id = $1 AND kind = 'assembly' AND system_code = 'BR'
        ORDER BY sort_order, id
        LIMIT 1
      `,
      [imported.projectId],
    );
    const targetSystem = await postgres.database.one<{ id: string }>(
      `
        SELECT id
        FROM cost_nodes
        WHERE project_id = $1 AND kind = 'system' AND system_code = 'BR'
      `,
      [current.id],
    );
    const currentBefore = await postgres.database.one<{
      version: number;
      nodes: number;
      lines: number;
    }>(
      `
        SELECT project.version,
               (SELECT COUNT(*)::int FROM cost_nodes WHERE project_id = project.id) AS nodes,
               (SELECT COUNT(*)::int FROM cost_lines line JOIN cost_nodes node ON node.id = line.node_id WHERE node.project_id = project.id) AS lines
        FROM projects project
        WHERE project.id = $1
      `,
      [current.id],
    );
    const copyRequest = {
      sourceProjectId: imported.projectId,
      sourceNodeId: sourceAssembly.id,
      targetProjectId: current.id,
      targetParentId: targetSystem.id,
      includeDescendants: true,
      copyEvidence: false,
    };
    const copyPreview = await previewProjectCopy(postgres.database, actor, copyRequest);
    if (copyPreview.conflicts.length > 0) {
      throw new Error(`copy conflicts: ${copyPreview.conflicts.join(", ")}`);
    }
    const afterPreview = await postgres.database.one<{ version: number; nodes: number; lines: number }>(
      `
        SELECT project.version,
               (SELECT COUNT(*)::int FROM cost_nodes WHERE project_id = project.id) AS nodes,
               (SELECT COUNT(*)::int FROM cost_lines line JOIN cost_nodes node ON node.id = line.node_id WHERE node.project_id = project.id) AS lines
        FROM projects project
        WHERE project.id = $1
      `,
      [current.id],
    );
    if (JSON.stringify(currentBefore) !== JSON.stringify(afterPreview)) {
      throw new Error("copy preview mutated the 2026 workspace");
    }
    const copy = await commitProjectCopy(postgres.database, paths, actor, {
      ...copyRequest,
      previewHash: copyPreview.previewHash,
      idempotencyKey: "ucm25-source-copy-verification",
    });
    const currentReport = await createReport(
      postgres.database,
      actor,
      current.id,
      "export",
      { paths },
    );
    if (!currentReport.pdf_path || currentReport.status !== "complete") {
      throw new Error("copied 2026 report did not complete");
    }
    const currentOutput = await persistReport(
      resolveStoredDataPath(currentReport.pdf_path, paths),
      copied2026Pdf,
    );
    const finalState = await postgres.database.one<{
      historical_projects: number;
      current_projects: number;
      historical_nodes: number;
      historical_lines: number;
      historical_evidence: number;
      current_nodes: number;
      current_lines: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE is_historical)::int AS historical_projects,
          COUNT(*) FILTER (WHERE NOT is_historical)::int AS current_projects,
          (SELECT COUNT(*)::int FROM cost_nodes WHERE project_id = $1) AS historical_nodes,
          (SELECT COUNT(*)::int FROM cost_lines line JOIN cost_nodes node ON node.id = line.node_id WHERE node.project_id = $1) AS historical_lines,
          (SELECT COUNT(*)::int FROM evidence WHERE project_id = $1) AS historical_evidence,
          (SELECT COUNT(*)::int FROM cost_nodes WHERE project_id = $2) AS current_nodes,
          (SELECT COUNT(*)::int FROM cost_lines line JOIN cost_nodes node ON node.id = line.node_id WHERE node.project_id = $2) AS current_lines
        FROM projects
      `,
      [imported.projectId, current.id],
    );
    const result = {
      format: "ucm25-source-local-verification",
      schemaVersion: 1,
      archive: {
        path: archivePath,
        bytes: archive.byteLength,
        sha256: sha256(archive),
        preview: archivePreview.totals,
        conflicts: archivePreview.conflicts,
        warnings: archivePreview.warnings,
      },
      import: imported,
      idempotentRepeat: repeatedImport.alreadyImported,
      historicalSidecars: evidenceIndex.uploadItems.length,
      databaseState: finalState,
      historicalReport: {
        reportId: historicalReport.id,
        pageCount: historicalReport.page_count,
        ...historicalOutput,
      },
      copy: {
        preview: copyPreview.totals,
        previewConflicts: copyPreview.conflicts,
        previewDidNotMutate: true,
        commit: copy,
      },
      copied2026Report: {
        reportId: currentReport.id,
        pageCount: currentReport.page_count,
        ...currentOutput,
      },
    };
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await postgres.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
