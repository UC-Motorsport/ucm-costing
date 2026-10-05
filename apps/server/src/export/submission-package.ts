import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import { assertSubmissionTransition } from "@ucm/domain";
import {
  strToU8,
  Zip,
  ZipPassThrough,
} from "fflate";

import { canonicalJson } from "../security/canonical-json";

// fflate validates the local DOS timestamp fields (1980-2099).
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0, 0);
const SOURCE_CHUNK_BYTES = 64 * 1024;
const MAX_PDF_BYTES = 9_000_000_000 - 1;
const MAX_SUPPORTING_BYTES = 512 * 1024 * 1024;
const MAX_AMENDMENT_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type SubmissionArtifactRole =
  | "cost-report"
  | "supporting-workbook"
  | "cost-amendment";

export type SubmissionArtifactSource =
  | { bytes: Uint8Array }
  | { filePath: string };

export interface SubmissionPackageArtifact {
  role: SubmissionArtifactRole;
  filename: string;
  mimeType: string;
  expectedSha256: string;
  expectedByteSize: number;
  reportSnapshotId: string;
  source: SubmissionArtifactSource;
}

export interface SubmissionPackageInput {
  schemaVersion: 1;
  submissionId: string;
  projectId: string;
  projectName: string;
  entryNumber: string;
  reportSnapshotId: string;
  preparedAt: string;
  preparedBy: string;
  mode: "draft" | "deadline" | "competition-ready" | "export";
  sources: {
    rulePackVersion: string;
    rulePackSha256: string;
    catalogueRevision: string;
    catalogueSha256: string;
  };
  validationBlockers: readonly {
    code: string;
    message: string;
  }[];
  artifacts: readonly SubmissionPackageArtifact[];
}

export interface SubmissionManifestArtifact {
  role: SubmissionArtifactRole;
  filename: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  reportSnapshotId: string;
}

export interface SubmissionPackageManifest {
  schemaVersion: 1;
  submissionId: string;
  state: "prepared";
  project: {
    id: string;
    name: string;
    entryNumber: string;
  };
  reportSnapshotId: string;
  preparedAt: string;
  preparedBy: string;
  mode: "draft" | "deadline" | "competition-ready" | "export";
  sources: SubmissionPackageInput["sources"];
  artifacts: SubmissionManifestArtifact[];
  checklist: {
    filename: "MANUAL-SUBMISSION-CHECKLIST.txt";
    sha256: string;
    byteSize: number;
  };
  externalSubmission: {
    transmittedByApplication: false;
    status: "not-recorded";
    instruction: string;
  };
}

export interface SubmissionPackageResult {
  destination: string;
  sha256: string;
  byteSize: number;
  manifest: SubmissionPackageManifest;
  manifestSha256: string;
  manifestBytes: number;
}

/**
 * Streams an immutable PDF/XLSX package and verifies every input while it is
 * read. A mismatch removes the incomplete destination. This prepares a local
 * artifact only; it does not and cannot contact the event organizer.
 */
export async function writeSubmissionPackage(
  destination: string,
  input: SubmissionPackageInput,
): Promise<SubmissionPackageResult> {
  validatePackageInput(input);
  const output = createWriteStream(destination, { flags: "wx" });
  const packageHash = createHash("sha256");
  let packageBytes = 0;
  let callbackError: Error | null = null;
  let pendingDrain: Promise<void> | null = null;

  const zip = new Zip((error, data, final) => {
    if (error) {
      callbackError = error;
      output.destroy(error);
      return;
    }
    if (data.byteLength > 0) {
      packageHash.update(data);
      packageBytes += data.byteLength;
      if (!output.write(data)) {
        pendingDrain = new Promise((resolve, reject) => {
          output.once("drain", resolve);
          output.once("error", reject);
        });
      }
    }
    if (final) {
      output.end();
    }
  });

  try {
    const verified: SubmissionManifestArtifact[] = [];
    for (const artifact of orderedArtifacts(input.artifacts)) {
      const entry = new ZipPassThrough(artifact.filename);
      entry.mtime = ZIP_EPOCH;
      entry.os = 3;
      entry.attrs = 0o100644 << 16;
      zip.add(entry);

      const digest = createHash("sha256");
      let byteSize = 0;
      const signature = new Uint8Array(8);
      let signatureBytes = 0;
      for await (const chunk of sourceChunks(artifact.source)) {
        digest.update(chunk);
        byteSize += chunk.byteLength;
        if (signatureBytes < signature.byteLength) {
          const retained = chunk.subarray(
            0,
            Math.min(
              chunk.byteLength,
              signature.byteLength - signatureBytes,
            ),
          );
          signature.set(retained, signatureBytes);
          signatureBytes += retained.byteLength;
        }
        assertWithinRoleLimit(artifact.role, byteSize);
        entry.push(chunk, false);
        await drain(pendingDrain);
        pendingDrain = null;
        if (callbackError) {
          throw callbackError;
        }
      }
      entry.push(new Uint8Array(), true);
      await drain(pendingDrain);
      pendingDrain = null;

      const sha256 = digest.digest("hex");
      assertFileSignature(
        artifact.role,
        signature.subarray(0, signatureBytes),
      );
      if (
        sha256 !== artifact.expectedSha256 ||
        byteSize !== artifact.expectedByteSize
      ) {
        throw new Error(
          `submission-artifact-integrity-mismatch:${artifact.role}`,
        );
      }
      verified.push({
        role: artifact.role,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sha256,
        byteSize,
        reportSnapshotId: artifact.reportSnapshotId,
      });
    }

    const checklistBytes = strToU8(manualChecklist(input));
    addBufferEntry(zip, "MANUAL-SUBMISSION-CHECKLIST.txt", checklistBytes);
    await drain(pendingDrain);
    pendingDrain = null;
    const manifest = assembleSubmissionPackageManifest(
      input,
      verified,
      checklistBytes,
    );
    const manifestBytes = strToU8(`${canonicalJson(manifest)}\n`);
    const manifestSha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    addBufferEntry(zip, "submission-manifest.json", manifestBytes);
    zip.end();
    await finished(output);
    if (callbackError) {
      throw callbackError;
    }

    return {
      destination,
      sha256: packageHash.digest("hex"),
      byteSize: packageBytes,
      manifest,
      manifestSha256,
      manifestBytes: manifestBytes.byteLength,
    };
  } catch (error) {
    zip.terminate();
    output.destroy();
    await finished(output).catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

/**
 * Builds the exact canonical manifest that `writeSubmissionPackage` embeds in
 * the ZIP. Callers use this before file generation so a crashed preparation
 * can reconstruct the same manifest from its durable reservation.
 *
 * The source files still have to be verified before this result is trusted;
 * `writeSubmissionPackage` independently streams and verifies them again.
 */
export function buildSubmissionPackageManifest(
  input: SubmissionPackageInput,
): SubmissionPackageManifest {
  validatePackageInput(input);
  const artifacts = orderedArtifacts(input.artifacts).map(
    (artifact): SubmissionManifestArtifact => ({
      role: artifact.role,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sha256: artifact.expectedSha256,
      byteSize: artifact.expectedByteSize,
      reportSnapshotId: artifact.reportSnapshotId,
    }),
  );
  return assembleSubmissionPackageManifest(
    input,
    artifacts,
    strToU8(manualChecklist(input)),
  );
}

export function assertManualSubmissionCanBeRecorded(
  current: "prepared" | "exported" | "manually-submitted",
  externalReference: string,
): void {
  assertSubmissionTransition(
    current,
    "manually-submitted",
    externalReference,
  );
}

function assembleSubmissionPackageManifest(
  input: SubmissionPackageInput,
  artifacts: SubmissionManifestArtifact[],
  checklistBytes: Uint8Array,
): SubmissionPackageManifest {
  return {
    schemaVersion: 1,
    submissionId: input.submissionId,
    state: "prepared",
    project: {
      id: input.projectId,
      name: input.projectName,
      entryNumber: input.entryNumber,
    },
    reportSnapshotId: input.reportSnapshotId,
    preparedAt: new Date(input.preparedAt).toISOString(),
    preparedBy: input.preparedBy,
    mode: input.mode,
    sources: input.sources,
    artifacts,
    checklist: {
      filename: "MANUAL-SUBMISSION-CHECKLIST.txt",
      sha256: createHash("sha256").update(checklistBytes).digest("hex"),
      byteSize: checklistBytes.byteLength,
    },
    externalSubmission: {
      transmittedByApplication: false,
      status: "not-recorded",
      instruction:
        "Submit through the organizer's current official route, then record the external receipt/reference in UCM Costing. Preparing or downloading this package is not submission.",
    },
  };
}

async function* sourceChunks(
  source: SubmissionArtifactSource,
): AsyncGenerator<Uint8Array> {
  if ("bytes" in source) {
    for (
      let offset = 0;
      offset < source.bytes.byteLength;
      offset += SOURCE_CHUNK_BYTES
    ) {
      yield source.bytes.subarray(
        offset,
        Math.min(source.bytes.byteLength, offset + SOURCE_CHUNK_BYTES),
      );
    }
    return;
  }
  for await (const chunk of createReadStream(source.filePath, {
    highWaterMark: SOURCE_CHUNK_BYTES,
  })) {
    yield new Uint8Array(chunk as Buffer);
  }
}

function validatePackageInput(input: SubmissionPackageInput): void {
  if (input.mode === "competition-ready" && input.validationBlockers.length > 0) {
    throw new Error(
      `submission-package-blocked:${input.validationBlockers.map(({ code }) => code).join(",")}`,
    );
  }
  if (
    !SHA256_PATTERN.test(input.sources.rulePackSha256) ||
    !SHA256_PATTERN.test(input.sources.catalogueSha256)
  ) {
    throw new Error("submission-package-source-hash-invalid");
  }
  if (!input.entryNumber.trim()) {
    throw new Error("submission-package-entry-number-required");
  }
  const roles = new Set(input.artifacts.map(({ role }) => role));
  if (
    input.artifacts.length < 2 ||
    input.artifacts.length > 3 ||
    !roles.has("cost-report") ||
    !roles.has("supporting-workbook") ||
    roles.size !== input.artifacts.length
  ) {
    throw new Error(
      "submission package requires one cost report, one supporting workbook, and at most one cost amendment",
    );
  }
  const names = new Set<string>();
  for (const artifact of input.artifacts) {
    assertSafeFilename(artifact.filename);
    const normalizedName = artifact.filename.toLocaleLowerCase("en");
    if (names.has(normalizedName)) {
      throw new Error("submission-package-duplicate-filename");
    }
    names.add(normalizedName);
    if (
      artifact.reportSnapshotId !== input.reportSnapshotId ||
      !SHA256_PATTERN.test(artifact.expectedSha256) ||
      !Number.isSafeInteger(artifact.expectedByteSize) ||
      artifact.expectedByteSize < 0
    ) {
      throw new Error(
        `submission-package-artifact-contract-invalid:${artifact.role}`,
      );
    }
    assertWithinRoleLimit(artifact.role, artifact.expectedByteSize);
    assertExpectedMedia(artifact);
  }
  if (
    names.has("submission-manifest.json") ||
    names.has("manual-submission-checklist.txt")
  ) {
    throw new Error("submission-package-reserved-filename");
  }
  const preparedAt = new Date(input.preparedAt);
  if (Number.isNaN(preparedAt.getTime())) {
    throw new Error("submission-package-prepared-at-invalid");
  }
}

function orderedArtifacts(
  artifacts: readonly SubmissionPackageArtifact[],
): SubmissionPackageArtifact[] {
  const order: Record<SubmissionArtifactRole, number> = {
    "cost-report": 0,
    "supporting-workbook": 1,
    "cost-amendment": 2,
  };
  return [...artifacts].sort(
    (left, right) => order[left.role] - order[right.role],
  );
}

function assertExpectedMedia(artifact: SubmissionPackageArtifact): void {
  const expected: Record<SubmissionArtifactRole, {
    extension: string;
    mimeType: string;
  }> = {
    "cost-report": {
      extension: ".pdf",
      mimeType: "application/pdf",
    },
    "supporting-workbook": {
      extension: ".xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    "cost-amendment": {
      extension: ".pdf",
      mimeType: "application/pdf",
    },
  };
  const contract = expected[artifact.role];
  if (
    path.extname(artifact.filename).toLowerCase() !== contract.extension ||
    artifact.mimeType !== contract.mimeType
  ) {
    throw new Error(
      `submission-package-artifact-media-invalid:${artifact.role}`,
    );
  }
}

function assertFileSignature(
  role: SubmissionArtifactRole,
  signature: Uint8Array,
): void {
  const expected =
    role === "supporting-workbook"
      ? [0x50, 0x4b, 0x03, 0x04]
      : [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (
    signature.byteLength < expected.length ||
    expected.some((byte, index) => signature[index] !== byte)
  ) {
    throw new Error(`submission-artifact-signature-invalid:${role}`);
  }
}

function assertSafeFilename(filename: string): void {
  if (
    !filename ||
    filename !== path.basename(filename) ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new Error(`unsafe submission filename: ${filename}`);
  }
}

function assertWithinRoleLimit(
  role: SubmissionArtifactRole,
  byteSize: number,
): void {
  const limit =
    role === "cost-report"
      ? MAX_PDF_BYTES
      : role === "supporting-workbook"
        ? MAX_SUPPORTING_BYTES
        : MAX_AMENDMENT_BYTES;
  if (byteSize > limit) {
    throw new Error(`submission-artifact-size-limit:${role}`);
  }
}

function addBufferEntry(
  zip: Zip,
  filename: string,
  bytes: Uint8Array,
): void {
  const entry = new ZipPassThrough(filename);
  entry.mtime = ZIP_EPOCH;
  entry.os = 3;
  entry.attrs = 0o100644 << 16;
  zip.add(entry);
  entry.push(bytes, true);
}

async function drain(pending: Promise<void> | null): Promise<void> {
  await pending;
}

function manualChecklist(input: SubmissionPackageInput): string {
  const draftWarning =
    input.mode === "draft"
      ? "DRAFT PACKAGE: resolve all listed blockers before any competition submission.\n"
      : input.mode === "deadline"
        ? "INCOMPLETE DEADLINE FALLBACK: this package is not competition-ready and must not be submitted as final.\n"
        : "";
  const blockerList =
    input.validationBlockers.length === 0
      ? "None recorded in the frozen validation result."
      : input.validationBlockers
          .map(({ code, message }) => `- ${code}: ${message}`)
          .join("\n");
  return [
    "UCM COSTING — MANUAL COMPETITION SUBMISSION CHECKLIST",
    "",
    draftWarning.trimEnd(),
    `Submission package ID: ${input.submissionId}`,
    `Frozen report snapshot: ${input.reportSnapshotId}`,
    `Project: ${input.projectName}`,
    `Entry number: ${input.entryNumber}`,
    "",
    "Before submission:",
    "1. Verify every file hash against submission-manifest.json.",
    "2. Confirm the current organizer instructions, destination, filename rules, deadline, and timezone from an official source.",
    "3. Upload the cost-report PDF and supporting XLSX as separate files if the organizer route requires separate uploads; this ZIP is a local transfer/audit package.",
    "4. Include a Cost Amendment Report only when applicable and only in the official accepted template.",
    "5. Retain the organizer acknowledgment or receipt.",
    "6. In UCM Costing, explicitly record manual submission and its external reference. Download/export alone is not submission.",
    "",
    "Frozen validation blockers:",
    blockerList,
    "",
    "This application does not transmit files to the organizer.",
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

/**
 * Optional preflight for callers that want to show a file-size error before
 * reserving a package artifact. Hashes are still recomputed during packaging.
 */
export async function preflightSubmissionSource(
  artifact: SubmissionPackageArtifact,
): Promise<void> {
  if ("filePath" in artifact.source) {
    const details = await stat(artifact.source.filePath);
    if (!details.isFile() || details.size !== artifact.expectedByteSize) {
      throw new Error(
        `submission-artifact-size-mismatch:${artifact.role}`,
      );
    }
  } else if (artifact.source.bytes.byteLength !== artifact.expectedByteSize) {
    throw new Error(
      `submission-artifact-size-mismatch:${artifact.role}`,
    );
  }
  assertWithinRoleLimit(artifact.role, artifact.expectedByteSize);
}
