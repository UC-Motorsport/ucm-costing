import { createHash } from "node:crypto";

import {
  resolveStoredDataPath,
  type AppPaths,
} from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  buildSubmissionPackageManifest,
  writeSubmissionPackage,
} from "../export/submission-package";
import {
  openVerifiedFile,
} from "../integrity/file-integrity";
import { canonicalJson } from "../security/canonical-json";
import type { ActorContext } from "../security/authorization";
import {
  getArtifactForActor,
  materializeReservedArtifact,
  materializeReservedFileArtifact,
  type ArtifactRow,
} from "./artifact-service";
import {
  getReport,
  type ReportSnapshotRow,
} from "./report-service";
import {
  beginSubmissionPreparation,
  failSubmissionPreparation,
  finalizeSubmissionPreparation,
  reserveSubmissionPreparation,
  withSubmissionPreparationLock,
} from "./submission-preparation-service";
import type { SubmissionRow } from "./submission-service";

export interface PreparedSubmissionPackage {
  submission: SubmissionRow;
  packageArtifact: ArtifactRow;
  manifestArtifact: ArtifactRow;
}

export async function prepareSubmissionPackage(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  input: {
    projectId: string;
    reportSnapshotId: string;
    supportingArtifactId: string;
  },
): Promise<PreparedSubmissionPackage> {
  const report = await getReport(
    database,
    actor,
    input.reportSnapshotId,
  );
  if (
    !report ||
    report.status !== "complete" ||
    report.mode !== "competition-ready" ||
    report.project_id !== input.projectId ||
    !report.pdf_path ||
    !report.pdf_sha256 ||
    report.pdf_bytes === null
  ) {
    throw new Error("submission-report-not-competition-ready");
  }
  const blockers = report.validation_json.issues.filter(
    ({ severity }) => severity === "blocker",
  );
  if (blockers.length > 0) {
    throw new Error("submission-report-has-blockers");
  }
  const supporting = await getArtifactForActor(
    database,
    actor,
    input.supportingArtifactId,
  );
  if (
    !supporting ||
    supporting.status !== "complete" ||
    supporting.kind !== "supporting-workbook" ||
    supporting.report_snapshot_id !== report.id ||
    !supporting.storage_path ||
    !supporting.content_sha256 ||
    supporting.byte_size === null
  ) {
    throw new Error("submission-supporting-workbook-invalid");
  }

  const reportPath = resolveStoredDataPath(report.pdf_path, paths);
  const supportingPath = resolveStoredDataPath(
    supporting.storage_path,
    paths,
  );
  const [verifiedReport, verifiedSupporting] = await Promise.all([
    openVerifiedFile(reportPath, report.pdf_sha256),
    openVerifiedFile(supportingPath, supporting.content_sha256),
  ]);
  try {
    if (
      verifiedReport.stats.size !== Number(report.pdf_bytes) ||
      verifiedSupporting.stats.size !== Number(supporting.byte_size)
    ) {
      throw new Error("submission-source-byte-size-mismatch");
    }
  } finally {
    await Promise.all([
      verifiedReport.handle.close(),
      verifiedSupporting.handle.close(),
    ]);
  }

  const snapshot = submissionSnapshot(report);
  const packageFilename =
    `UCM-${snapshot.project.entry_number}-submission.zip`;
  const manifestFilename =
    `UCM-${snapshot.project.entry_number}-submission-manifest.json`;
  const preparation = await reserveSubmissionPreparation(
    database,
    actor,
    {
      projectId: report.project_id,
      reportSnapshotId: report.id,
      supportingArtifactId: supporting.id,
      packageFilename,
      manifestFilename,
    },
  );

  return withSubmissionPreparationLock(
    database,
    preparation.id,
    async () => {
      const active = await beginSubmissionPreparation(
        database,
        actor,
        preparation.id,
      );
      try {
        const packageInput = {
          schemaVersion: 1,
          submissionId: active.id,
          projectId: report.project_id,
          projectName: snapshot.project.name,
          entryNumber: snapshot.project.entry_number,
          reportSnapshotId: report.id,
          preparedAt: active.prepared_at,
          preparedBy: active.prepared_by,
          mode: report.mode,
          sources: {
            rulePackVersion: snapshot.sources.rulePack.version,
            rulePackSha256: snapshot.sources.rulePack.sha256,
            catalogueRevision: snapshot.sources.catalogue.revision,
            catalogueSha256: snapshot.sources.catalogue.sha256,
          },
          validationBlockers: blockers.map((blocker) => ({
            code: blocker.code,
            message: blocker.detail,
          })),
          artifacts: [
            {
              role: "cost-report",
              filename: "cost-report.pdf",
              mimeType: "application/pdf",
              expectedSha256: report.pdf_sha256!,
              expectedByteSize: Number(report.pdf_bytes),
              reportSnapshotId: report.id,
              source: { filePath: reportPath },
            },
            {
              role: "supporting-workbook",
              filename: "supporting-cost-data.xlsx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              expectedSha256: supporting.content_sha256!,
              expectedByteSize: Number(supporting.byte_size),
              reportSnapshotId: report.id,
              source: { filePath: supportingPath },
            },
          ],
        } as const;
        const manifest = buildSubmissionPackageManifest(packageInput);
        const manifestBytes = Buffer.from(
          `${canonicalJson(manifest)}\n`,
          "utf8",
        );
        const manifestSha256 = createHash("sha256")
          .update(manifestBytes)
          .digest("hex");

        const packageArtifact =
          await materializeReservedFileArtifact(
            database,
            paths,
            actor,
            {
              artifactId: active.package_artifact_id,
              projectId: report.project_id,
              kind: "submission-package",
              reportSnapshotId: report.id,
              filename: packageFilename,
              mimeType: "application/zip",
              metadata: {
                submissionId: active.id,
                mode: report.mode,
                externalSubmissionRecorded: false,
              },
              generate: async (destination) => {
                const result = await writeSubmissionPackage(
                  destination,
                  packageInput,
                );
                if (
                  canonicalJson(result.manifest) !==
                  canonicalJson(manifest)
                ) {
                  throw new Error(
                    "submission-manifest-generation-mismatch",
                  );
                }
                return {
                  sha256: result.sha256,
                  byteSize: result.byteSize,
                  metadata: {
                    manifestSha256: result.manifestSha256,
                    manifestBytes: result.manifestBytes,
                  },
                };
              },
            },
          );
        const manifestArtifact = await materializeReservedArtifact(
          database,
          paths,
          actor,
          {
            artifactId: active.manifest_artifact_id,
            projectId: report.project_id,
            kind: "submission-manifest",
            reportSnapshotId: report.id,
            filename: manifestFilename,
            mimeType: "application/json",
            metadata: {
              submissionId: active.id,
              canonicalJson: true,
            },
            generate: () => ({
              bytes: manifestBytes,
              sha256: manifestSha256,
            }),
          },
        );
        const submission = await finalizeSubmissionPreparation(
          database,
          actor,
          active.id,
          { manifest },
        );
        return { submission, packageArtifact, manifestArtifact };
      } catch (error) {
        await failSubmissionPreparation(
          database,
          actor,
          active.id,
          error,
        ).catch(() => undefined);
        throw error;
      }
    },
  );
}

interface SubmissionSnapshot {
  project: {
    name: string;
    entry_number: string;
  };
  sources: {
    rulePack: { version: string; sha256: string };
    catalogue: { revision: string; sha256: string };
  };
}

function submissionSnapshot(
  report: ReportSnapshotRow,
): SubmissionSnapshot {
  const value = report.snapshot_json as Partial<SubmissionSnapshot>;
  if (
    !value.project?.name ||
    !value.project.entry_number ||
    !value.sources?.rulePack?.version ||
    !value.sources.rulePack.sha256 ||
    !value.sources.catalogue?.revision ||
    !value.sources.catalogue.sha256
  ) {
    throw new Error("submission-report-snapshot-invalid");
  }
  return value as SubmissionSnapshot;
}
