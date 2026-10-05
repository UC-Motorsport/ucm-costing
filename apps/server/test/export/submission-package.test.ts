import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertManualSubmissionCanBeRecorded,
  writeSubmissionPackage,
  type SubmissionPackageInput,
} from "../../src/export/submission-package";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ucm-package-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): SubmissionPackageInput {
  const report = new TextEncoder().encode("%PDF-1.7\nfixture report\n");
  const workbook = Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
  ]);
  return {
    schemaVersion: 1,
    submissionId: "submission-1",
    projectId: "project-1",
    projectName: "University of Canterbury Motorsport",
    entryNumber: "26",
    reportSnapshotId: "snapshot-1",
    preparedAt: "2026-09-30T08:00:00.000Z",
    preparedBy: "user-1",
    mode: "competition-ready",
    sources: {
      rulePackVersion: "FSAE-A 2026 Local Addendum v1.2",
      rulePackSha256: "a".repeat(64),
      catalogueRevision: "26_R1",
      catalogueSha256: "b".repeat(64),
    },
    validationBlockers: [],
    artifacts: [
      {
        role: "cost-report",
        filename: "UCM26-Cost-Report.pdf",
        mimeType: "application/pdf",
        expectedSha256: sha256(report),
        expectedByteSize: report.byteLength,
        reportSnapshotId: "snapshot-1",
        source: { bytes: report },
      },
      {
        role: "supporting-workbook",
        filename: "UCM26-Supporting-Data.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        expectedSha256: sha256(workbook),
        expectedByteSize: workbook.byteLength,
        reportSnapshotId: "snapshot-1",
        source: { bytes: workbook },
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("manual submission package", () => {
  it("streams a deterministic verified archive and honest manifest", async () => {
    const directory = await tempDirectory();
    const firstPath = path.join(directory, "first.zip");
    const secondPath = path.join(directory, "second.zip");
    const first = await writeSubmissionPackage(firstPath, fixture());
    const second = await writeSubmissionPackage(secondPath, fixture());
    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));

    const archive = unzipSync(await readFile(firstPath));
    expect(Object.keys(archive)).toEqual([
      "UCM26-Cost-Report.pdf",
      "UCM26-Supporting-Data.xlsx",
      "MANUAL-SUBMISSION-CHECKLIST.txt",
      "submission-manifest.json",
    ]);
    const manifest = JSON.parse(
      strFromU8(archive["submission-manifest.json"]!),
    ) as Record<string, unknown>;
    expect(manifest.state).toBe("prepared");
    expect(manifest.externalSubmission).toMatchObject({
      transmittedByApplication: false,
      status: "not-recorded",
    });
    expect(
      strFromU8(archive["MANUAL-SUBMISSION-CHECKLIST.txt"]!),
    ).toContain("Download/export alone is not submission");
  });

  it("removes a partial package when an immutable source hash is wrong", async () => {
    const directory = await tempDirectory();
    const destination = path.join(directory, "invalid.zip");
    const input = fixture();
    input.artifacts[0]!.expectedSha256 = "0".repeat(64);
    await expect(
      writeSubmissionPackage(destination, input),
    ).rejects.toThrow("submission-artifact-integrity-mismatch");
    expect(existsSync(destination)).toBe(false);
  });

  it("blocks ready packages with blockers and requires a manual receipt", async () => {
    const directory = await tempDirectory();
    const input = fixture();
    input.validationBlockers = [
      { code: "evidence-missing", message: "Evidence is missing." },
    ];
    await expect(
      writeSubmissionPackage(path.join(directory, "blocked.zip"), input),
    ).rejects.toThrow("submission-package-blocked");
    expect(() =>
      assertManualSubmissionCanBeRecorded("exported", ""),
    ).toThrow("submission-external-reference-required");
    expect(() =>
      assertManualSubmissionCanBeRecorded("exported", "receipt-42"),
    ).not.toThrow();
  });
});
