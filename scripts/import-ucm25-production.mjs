#!/usr/bin/env node

/** Controlled API migration for the hash-locked UCM25 source archive.
 *
 * `preview` is read-only apart from the authenticated operator session.
 * `commit` repeats the same preview, pins its hashes, performs the idempotent
 * historical import, uploads hash-checked sidecars, renders/downloads the
 * production report, and performs a non-mutating copy preview into 2026.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EXPECTED_ARCHIVE_SHA256 =
  "11aaf186f5d16b6d850aca749a5fe76036f53e408a53c8bb1d78ce97e843dab3";
const EXPECTED_PREVIEW_HASH =
  "ff9d53c6966150ff99c1861ced30117d2f37c3139f57db78bb528de1c01fb8b2";
const EXPECTED_TOTALS = { nodes: 477, costLines: 2628, evidence: 440 };
const TARGET = {
  targetSeason: "2025",
  targetName: "UC Motorsport 2025 — Source Archive",
  targetEntryNumber: "E13",
  targetIsHistorical: "true",
};

function parseArguments(argv) {
  const result = { operation: argv[2] };
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    result[key.slice(2)] = value;
  }
  if (!new Set(["preview", "commit", "verify"]).has(result.operation)) {
    throw new Error("Usage: import-ucm25-production.mjs <preview|commit|verify> --email EMAIL --archive PATH [--sidecar-index PATH --sidecar-dir PATH --output PATH]");
  }
  if (!result.email || !result.archive) {
    throw new Error("--email and --archive are required");
  }
  if (result.operation === "commit" && (!result["sidecar-index"] || !result["sidecar-dir"] || !result.output)) {
    throw new Error("commit also requires --sidecar-index, --sidecar-dir, and --output");
  }
  if (
    result.operation === "verify" &&
    (!result["report-id"] || !result["expected-report-sha256"] || !result.output)
  ) {
    throw new Error("verify also requires --report-id, --expected-report-sha256, and --output");
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const input = parseArguments(process.argv);
  const baseUrl = input["base-url"] ?? "http://app:8080";
  const origin = input.origin ?? process.env.UCM_ALLOWED_ORIGINS;
  const adminKey = process.env.UCM_ADMIN_ACCESS_KEY;
  if (!origin || !adminKey) {
    throw new Error("UCM_ALLOWED_ORIGINS and UCM_ADMIN_ACCESS_KEY are required");
  }
  const archive = await readFile(input.archive);
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== EXPECTED_ARCHIVE_SHA256) {
    throw new Error(`archive hash mismatch: ${archiveSha256}`);
  }

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: input.email, key: adminKey }),
  });
  const session = await responseJson(login, "login");
  if (session.user?.role !== "admin" || typeof session.csrfToken !== "string") {
    throw new Error("migration login did not produce an administrator session");
  }
  const setCookie = login.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) throw new Error("migration login did not set a session cookie");

  const request = async (pathname, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("cookie", cookie);
    headers.set("origin", origin);
    if (options.method && options.method !== "GET") {
      headers.set("x-csrf-token", session.csrfToken);
    }
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
    return await responseJson(response, pathname);
  };
  const multipart = async (
    pathname,
    fields,
    fileBytes,
    fileName,
    mimeType = "application/octet-stream",
  ) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    body.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
    return await request(pathname, { method: "POST", body });
  };

  const projectsBefore = await request("/api/projects");
  const currentBefore = projectsBefore.projects.find(
    (project) => project.season === 2026 && !project.is_historical,
  );
  if (!currentBefore) throw new Error("active 2026 workspace not found");
  const existing2025 = projectsBefore.projects.filter(
    (project) => project.season === 2025,
  );
  if (
    existing2025.length > 1 ||
    (existing2025.length === 1 &&
      (!existing2025[0].is_historical ||
        existing2025[0].name !== TARGET.targetName))
  ) {
    throw new Error("the existing 2025 project is not the controlled historical import");
  }
  if (input.operation === "verify") {
    if (existing2025.length !== 1) {
      throw new Error("verify requires exactly one controlled historical 2025 project");
    }
    const historicalProject = existing2025[0];
    const evidenceResult = await request(
      `/api/projects/${historicalProject.id}/evidence`,
    );
    const chunkEvidence = evidenceResult.evidence.filter((item) =>
      /^historical-evidence-chunk-\d{3}\.pdf$/.test(item.display_name),
    );
    assertEqual(evidenceResult.evidence.length, 460, "historical evidence count");
    assertEqual(chunkEvidence.length, 20, "historical sidecar count");

    const sourceDetail = await request(`/api/projects/${historicalProject.id}`);
    const targetDetailBefore = await request(`/api/projects/${currentBefore.id}`);
    const sourceAssembly = sourceDetail.flatNodes.find(
      (node) => node.kind === "assembly" && node.system_code === "BR",
    );
    const targetSystem = targetDetailBefore.flatNodes.find(
      (node) => node.kind === "system" && node.system_code === "BR",
    );
    if (!sourceAssembly || !targetSystem) throw new Error("copy-preview nodes not found");
    const copyPreview = await request("/api/project-copy/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: historicalProject.id,
        sourceNodeId: sourceAssembly.id,
        targetProjectId: currentBefore.id,
        targetParentId: targetSystem.id,
        includeDescendants: true,
        copyEvidence: false,
      }),
    });
    assertEqual(copyPreview.conflicts, [], "copy preview conflicts");
    const targetDetailAfter = await request(`/api/projects/${currentBefore.id}`);
    assertEqual(targetDetailAfter, targetDetailBefore, "2026 detail after copy preview");

    const download = await fetch(
      `${baseUrl}/api/reports/${input["report-id"]}/download`,
      { headers: { cookie, origin } },
    );
    if (!download.ok) throw new Error(`report download failed with ${download.status}`);
    const pdf = new Uint8Array(await download.arrayBuffer());
    const reportSha256 = sha256(pdf);
    assertEqual(
      reportSha256,
      input["expected-report-sha256"],
      "production report hash",
    );
    assertEqual(
      download.headers.get("x-content-sha256"),
      reportSha256,
      "production report integrity header",
    );
    await writeFile(input.output, pdf, { flag: "wx" });
    process.stdout.write(
      `${JSON.stringify(
        {
          operation: "verify",
          archiveSha256,
          historicalProjectId: historicalProject.id,
          historicalEvidence: evidenceResult.evidence.length,
          historicalSidecars: chunkEvidence.length,
          current2026: {
            id: currentBefore.id,
            version: currentBefore.version,
            unchangedByCopyPreview: true,
          },
          copyPreview: {
            totals: copyPreview.totals,
            conflicts: copyPreview.conflicts,
          },
          report: {
            id: input["report-id"],
            bytes: pdf.byteLength,
            sha256: reportSha256,
            output: input.output,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (input.operation === "preview" && existing2025.length > 0) {
    throw new Error("the controlled 2025 import already exists; use commit to verify/resume idempotently");
  }

  const preview = existing2025.length === 0
    ? await multipart(
        "/api/project-archives/preview",
        TARGET,
        archive,
        path.basename(input.archive),
        "application/zip",
      )
    : {
        archiveSha256: EXPECTED_ARCHIVE_SHA256,
        previewHash: EXPECTED_PREVIEW_HASH,
        totals: { ...EXPECTED_TOTALS, evidenceBytes: 36042554 },
        conflicts: [],
        warnings: ["Resuming the exact idempotent production import after sidecar upload interruption."],
      };
  assertEqual(preview.archiveSha256, EXPECTED_ARCHIVE_SHA256, "preview archive hash");
  assertEqual(preview.previewHash, EXPECTED_PREVIEW_HASH, "preview hash");
  assertEqual(preview.conflicts, [], "preview conflicts");
  assertEqual(preview.totals, { ...EXPECTED_TOTALS, evidenceBytes: 36042554 }, "preview totals");
  const previewResult = {
    operation: "preview",
    archiveSha256,
    previewHash: preview.previewHash,
    totals: preview.totals,
    conflicts: preview.conflicts,
    warnings: preview.warnings,
    current2026: {
      id: currentBefore.id,
      version: currentBefore.version,
      updatedAt: currentBefore.updated_at,
    },
  };
  if (input.operation === "preview") {
    process.stdout.write(`${JSON.stringify(previewResult, null, 2)}\n`);
    return;
  }

  const evidenceIndex = JSON.parse(await readFile(input["sidecar-index"], "utf8"));
  const verifiedSidecars = [];
  for (const item of evidenceIndex.uploadItems) {
    const bytes = await readFile(path.join(input["sidecar-dir"], item.displayName));
    assertEqual(bytes.byteLength, item.byteSize, `${item.displayName} byte size`);
    assertEqual(sha256(bytes), item.contentSha256, `${item.displayName} hash`);
    verifiedSidecars.push({ item, bytes });
  }
  assertEqual(verifiedSidecars.length, 20, "historical sidecar count");

  const commitFields = {
    ...TARGET,
    expectedArchiveSha256: EXPECTED_ARCHIVE_SHA256,
    previewHash: preview.previewHash,
    idempotencyKey: `ucm25-source-${EXPECTED_ARCHIVE_SHA256}`,
  };
  const imported = await multipart(
    "/api/project-archives/commit",
    commitFields,
    archive,
    path.basename(input.archive),
    "application/zip",
  );
  assertEqual(
    {
      season: imported.season,
      createdNodes: imported.createdNodes,
      createdCostLines: imported.createdCostLines,
      createdEvidence: imported.createdEvidence,
      alreadyImported: imported.alreadyImported,
    },
    {
      season: 2025,
      createdNodes: EXPECTED_TOTALS.nodes,
      createdCostLines: EXPECTED_TOTALS.costLines,
      createdEvidence: EXPECTED_TOTALS.evidence,
      alreadyImported: existing2025.length === 1,
    },
    "archive commit",
  );
  const repeated = await multipart(
    "/api/project-archives/commit",
    commitFields,
    archive,
    path.basename(input.archive),
    "application/zip",
  );
  if (!repeated.alreadyImported || repeated.projectId !== imported.projectId) {
    throw new Error("production archive commit is not idempotent");
  }

  const sidecars = [];
  for (const { item, bytes } of verifiedSidecars) {
    const stored = await multipart(
      `/api/project-archives/${imported.projectId}/evidence-sidecar`,
      {
        expectedContentSha256: item.contentSha256,
        reportCaption: item.reportCaption,
      },
      bytes,
      item.displayName,
      item.mimeType,
    );
    sidecars.push(stored);
  }
  const firstItem = verifiedSidecars[0].item;
  const firstBytes = verifiedSidecars[0].bytes;
  const repeatedSidecar = await multipart(
    `/api/project-archives/${imported.projectId}/evidence-sidecar`,
    {
      expectedContentSha256: firstItem.contentSha256,
      reportCaption: firstItem.reportCaption,
    },
    firstBytes,
    firstItem.displayName,
    firstItem.mimeType,
  );
  if (!repeatedSidecar.alreadyStored || repeatedSidecar.evidenceId !== sidecars[0].evidenceId) {
    throw new Error("production sidecar upload is not idempotent");
  }

  const projectsAfter = await request("/api/projects");
  const currentAfter = projectsAfter.projects.find((project) => project.id === currentBefore.id);
  assertEqual(currentAfter, currentBefore, "2026 project after historical import");
  const historical = projectsAfter.projects.filter(
    (project) => project.season === 2025 && project.is_historical,
  );
  if (historical.length !== 1 || historical[0].id !== imported.projectId) {
    throw new Error("production did not contain exactly one imported historical 2025 workspace");
  }

  const sourceDetail = await request(`/api/projects/${imported.projectId}`);
  const targetDetailBefore = await request(`/api/projects/${currentBefore.id}`);
  const sourceAssembly = sourceDetail.flatNodes.find(
    (node) => node.kind === "assembly" && node.system_code === "BR",
  );
  const targetSystem = targetDetailBefore.flatNodes.find(
    (node) => node.kind === "system" && node.system_code === "BR",
  );
  if (!sourceAssembly || !targetSystem) throw new Error("copy-preview nodes not found");
  const copyPreview = await request("/api/project-copy/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceProjectId: imported.projectId,
      sourceNodeId: sourceAssembly.id,
      targetProjectId: currentBefore.id,
      targetParentId: targetSystem.id,
      includeDescendants: true,
      copyEvidence: false,
    }),
  });
  assertEqual(copyPreview.conflicts, [], "copy preview conflicts");
  const targetDetailAfter = await request(`/api/projects/${currentBefore.id}`);
  assertEqual(targetDetailAfter, targetDetailBefore, "2026 detail after copy preview");

  const reportResult = await request(`/api/projects/${imported.projectId}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "export" }),
  });
  const report = reportResult.report;
  if (report.status !== "complete" || report.page_count !== 1078 || !report.downloadUrl) {
    throw new Error(`production report did not complete correctly: ${JSON.stringify(report)}`);
  }
  const download = await fetch(`${baseUrl}${report.downloadUrl}`, {
    headers: { cookie, origin },
  });
  if (!download.ok) throw new Error(`report download failed with ${download.status}`);
  const pdf = new Uint8Array(await download.arrayBuffer());
  const reportSha256 = sha256(pdf);
  const expectedReportHash = download.headers.get("x-content-sha256");
  assertEqual(reportSha256, expectedReportHash, "downloaded report hash");
  await writeFile(input.output, pdf, { flag: "wx" });

  process.stdout.write(
    `${JSON.stringify(
      {
        ...previewResult,
        operation: "commit",
        import: imported,
        repeatedImportWasIdempotent: repeated.alreadyImported,
        sidecars: {
          uploaded: sidecars.length,
          repeatedUploadWasIdempotent: repeatedSidecar.alreadyStored,
        },
        projects: {
          total: projectsAfter.projects.length,
          historical2025: historical.length,
          current2026Unchanged: true,
        },
        copyPreview: {
          totals: copyPreview.totals,
          conflicts: copyPreview.conflicts,
          current2026Unchanged: true,
        },
        report: {
          id: report.id,
          pages: report.page_count,
          bytes: pdf.byteLength,
          sha256: reportSha256,
          output: input.output,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
