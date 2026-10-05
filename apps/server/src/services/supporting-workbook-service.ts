import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  generateSupportingWorkbook,
  type SupportingWorkbookSnapshot,
} from "../export/supporting-workbook";
import type { ActorContext } from "../security/authorization";
import {
  createArtifact,
  type ArtifactRow,
} from "./artifact-service";
import { getReport } from "./report-service";

export async function createSupportingWorkbookArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  reportId: string,
): Promise<ArtifactRow> {
  const report = await getReport(database, actor, reportId);
  if (!report || report.status !== "complete") {
    throw new Error("report-not-complete");
  }
  const snapshot = supportingSnapshot(report.snapshot_json);
  return await createArtifact(database, paths, actor, {
    projectId: report.project_id,
    kind: "supporting-workbook",
    reportSnapshotId: report.id,
    filename: `UCM-${report.project_id}-${report.id}-supporting.xlsx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    allowHistorical: true,
    metadata: {
      mode: report.mode,
      source: "immutable-report-snapshot",
      formulaFree: true,
    },
    generate: () => {
      const workbook = generateSupportingWorkbook(snapshot);
      return {
        bytes: workbook.bytes,
        sha256: workbook.sha256,
        metadata: {
          issues: workbook.issues,
          nodeCount: workbook.nodeCount,
          costLineCount: workbook.costLineCount,
        },
      };
    },
  });
}

function supportingSnapshot(
  value: Record<string, unknown>,
): SupportingWorkbookSnapshot {
  if (
    value.schemaVersion === undefined ||
    !value.project ||
    !value.sources ||
    !value.tree ||
    !value.breakdown
  ) {
    throw new Error("report-snapshot-supporting-data-invalid");
  }
  return value as unknown as SupportingWorkbookSnapshot;
}
