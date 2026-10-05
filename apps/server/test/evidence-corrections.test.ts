import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import request from "supertest";
import { PDFDocument } from "pdf-lib";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  resolveStoredDataPath,
  toStoredDataPath,
} from "../src/config";
import {
  getEvidenceFileCleanupStatus,
  processEvidenceFileCleanup,
} from "../src/services/evidence-service";
import {
  createHttpTestContext,
  getTeamWorkspace,
  mutation,
  type HttpTestContext,
} from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe
  .skipIf(!hasPostgresTestDatabase())
  .sequential("PostgreSQL evidence and report integrity", () => {
  let context: HttpTestContext;
  let projectId: string;
  let partId: string;

  beforeAll(async () => {
    context = await createHttpTestContext();
    projectId = (await getTeamWorkspace(context, {
      name: "Evidence Integrity Vehicle",
      entryNumber: "E14",
    })).id;
    partId = await createPart();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("renders PDF thumbnails, refreshes replacements, and verifies cached sources", async () => {
    const evidence = await uploadReportPdf(await onePagePdf(), "thumbnail.pdf", "Thumbnail drawing");
    await request(context.app).get(`/api/evidence/${evidence.id}/thumbnail`).expect(401);
    const first = await context.adminAgent.get(`/api/evidence/${evidence.id}/thumbnail`).expect(200);
    expect(first.headers["content-type"]).toMatch(/image\/png/);
    expect(first.body.subarray(0, 8)).toEqual(png.subarray(0, 8));
    const cached = await context.adminAgent.get(`/api/evidence/${evidence.id}/thumbnail`).expect(200);
    expect(cached.body).toEqual(first.body);
    const replacement = await PDFDocument.create();
    replacement.addPage([400, 300]).drawText("REPLACED DRAWING", { x: 20, y: 100 });
    const result = await mutation(context.adminAgent.put(`/api/evidence/${evidence.id}/file`), context.adminCsrfToken)
      .field("expectedVersion", "0").attach("file", Buffer.from(await replacement.save()), { filename: "replaced.pdf", contentType: "application/pdf" }).expect(200);
    expect(result.body.evidence.thumbnailUrl).toContain("v=1");
    const updated = await context.adminAgent.get(result.body.evidence.thumbnailUrl).expect(200);
    expect(updated.body).not.toEqual(first.body);
    const stored = await evidenceStorage(evidence.id);
    await writeFile(resolveStoredDataPath(stored.storage_path, context.paths), "corrupted");
    await context.adminAgent.get(result.body.evidence.thumbnailUrl).expect(409);
    await writeFile(resolveStoredDataPath(stored.storage_path, context.paths), Buffer.from(await replacement.save()));
  });

  it("validates report metadata and applies optimistic metadata updates", async () => {
    const pdf = await onePagePdf();
    const missingCaption = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "drawing")
      .field("nodeId", partId)
      .field("visibility", "report")
      .attach("file", pdf, {
        filename: "missing-caption.pdf",
        contentType: "application/pdf",
      })
      .expect(400);
    expect(missingCaption.body.error.code).toBe(
      "report-evidence-caption-required",
    );

    const internalText = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "other")
      .field("nodeId", partId)
      .field("visibility", "internal")
      .attach("file", Buffer.from("internal evidence notes"), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .expect(201);
    expect(internalText.body.evidence).toMatchObject({
      node_id: partId,
      version: 0,
      visibility: "internal",
      report_caption: "",
      viewUrl: expect.stringMatching(/^\/api\/evidence\//),
      downloadUrl: expect.stringMatching(/^\/api\/evidence\//),
    });
    expect(internalText.body.evidence).not.toHaveProperty("storage_path");

    const unsafePromotion = await mutation(
      context.adminAgent.patch(
        `/api/evidence/${internalText.body.evidence.id}`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 0,
        visibility: "report",
        reportCaption: "Text cannot be appended to reports",
      })
      .expect(400);
    expect(unsafePromotion.body.error.code).toBe(
      "report-evidence-type-unsupported",
    );

    const stored = await uploadReportPdf(
      pdf,
      "editable.pdf",
      "Original report caption",
    );
    const blankCaption = await mutation(
      context.adminAgent.patch(`/api/evidence/${stored.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 0,
        reportCaption: "   ",
      })
      .expect(400);
    expect(blankCaption.body.error.code).toBe(
      "report-evidence-caption-required",
    );

    const updated = await mutation(
      context.adminAgent.patch(`/api/evidence/${stored.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 0,
        visibility: "report",
        reportCaption: "Corrected report caption",
      })
      .expect(200);
    expect(updated.body.evidence).toMatchObject({
      id: stored.id,
      version: 1,
      visibility: "report",
      report_caption: "Corrected report caption",
    });

    const stale = await mutation(
      context.adminAgent.patch(`/api/evidence/${stored.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 0,
        reportCaption: "Stale caption",
      })
      .expect(409);
    expect(stale.body.error.code).toBe("version-conflict");
  });

  it("freezes CAIR evidence provenance and supports audited draft detach", async () => {
    const evidenceBytes = Buffer.from(
      "immutable supplier quotation evidence",
      "utf8",
    );
    const uploaded = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "other")
      .field("nodeId", partId)
      .field("visibility", "internal")
      .attach("file", evidenceBytes, {
        filename: "supplier-quotation.txt",
        contentType: "text/plain",
      })
      .expect(201);
    const evidence = uploaded.body.evidence;
    expect(evidence).toMatchObject({
      byte_size: String(evidenceBytes.byteLength),
      version: 0,
    });

    const created = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/cairs`),
      context.adminCsrfToken,
    )
      .send({
        requestedCatalogueDescription:
          "Supplier item not present in the governing catalogue",
        rationale:
          "The quotation is retained as request evidence pending an official catalogue decision.",
        proposedCost: "42.5",
      })
      .expect(201);
    const cairId = created.body.cair.id as string;

    const attached = await mutation(
      context.adminAgent.post(`/api/cairs/${cairId}/evidence`),
      context.adminCsrfToken,
    )
      .send({ evidenceId: evidence.id, expectedVersion: 0 })
      .expect(200);
    expect(attached.body.cair).toMatchObject({
      version: 1,
      attachments: [
        {
          evidence_id: evidence.id,
          content_sha256: evidence.content_sha256,
          byte_size: String(evidenceBytes.byteLength),
          evidence_version: 0,
          frozen_at: null,
          download_url: evidence.downloadUrl,
        },
      ],
    });

    const fetched = await context.adminAgent
      .get(`/api/cairs/${cairId}`)
      .expect(200);
    expect(fetched.body.cair.attachments).toHaveLength(1);
    const listed = await context.adminAgent
      .get(`/api/projects/${projectId}/cairs`)
      .expect(200);
    expect(
      listed.body.cairs.find(
        (candidate: { id: string }) => candidate.id === cairId,
      ).attachments,
    ).toHaveLength(1);

    const detached = await mutation(
      context.adminAgent.delete(
        `/api/cairs/${cairId}/evidence/${evidence.id}`,
      ),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 1 })
      .expect(200);
    expect(detached.body.cair).toMatchObject({
      version: 2,
      attachments: [],
    });

    const reattached = await mutation(
      context.adminAgent.post(`/api/cairs/${cairId}/evidence`),
      context.adminCsrfToken,
    )
      .send({ evidenceId: evidence.id, expectedVersion: 2 })
      .expect(200);
    expect(reattached.body.cair.version).toBe(3);

    const storedEvidence = await context.database.one<{
      storage_path: string;
    }>(
      "SELECT storage_path FROM evidence WHERE id = $1",
      [evidence.id],
    );
    const storedEvidencePath = resolveStoredDataPath(
      storedEvidence.storage_path,
      context.paths,
    );
    await writeFile(
      storedEvidencePath,
      Buffer.from("tampered before CAIR submission", "utf8"),
    );
    try {
      const rejectedSubmission = await mutation(
        context.adminAgent.post(`/api/cairs/${cairId}/transitions`),
        context.adminCsrfToken,
      )
        .send({
          expectedVersion: 3,
          next: "submitted",
          externalReference: "CAIR-TAMPERED-EVIDENCE",
        })
        .expect(409);
      expect(rejectedSubmission.body.error.code).toBe(
        "stored-file-integrity-failed",
      );
    } finally {
      await writeFile(storedEvidencePath, evidenceBytes);
    }

    const submitted = await mutation(
      context.adminAgent.post(`/api/cairs/${cairId}/transitions`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 3,
        next: "submitted",
        externalReference: "CAIR-RECEIPT-EVIDENCE-001",
      })
      .expect(200);
    expect(submitted.body.cair).toMatchObject({
      status: "submitted",
      version: 4,
      attachments: [
        {
          evidence_id: evidence.id,
          frozen_content_sha256: evidence.content_sha256,
          frozen_byte_size: String(evidenceBytes.byteLength),
          frozen_evidence_version: 0,
          frozen_at: expect.any(String),
          frozen_metadata_json: {
            evidenceId: evidence.id,
            displayName: "supplier-quotation.txt",
            kind: "other",
            mimeType: "text/plain",
          },
        },
      ],
    });

    const replacement = await mutation(
      context.adminAgent.put(`/api/evidence/${evidence.id}/file`),
      context.adminCsrfToken,
    )
      .field("expectedVersion", "0")
      .attach("file", Buffer.from("changed quotation", "utf8"), {
        filename: "changed-quotation.txt",
        contentType: "text/plain",
      })
      .expect(409);
    expect(replacement.body.error.code).toBe(
      "evidence-cair-reference-protected",
    );
    const metadata = await mutation(
      context.adminAgent.patch(`/api/evidence/${evidence.id}`),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 0, visibility: "internal" })
      .expect(409);
    expect(metadata.body.error.code).toBe(
      "evidence-cair-reference-protected",
    );
    const deletion = await mutation(
      context.adminAgent.delete(`/api/evidence/${evidence.id}`),
      context.adminCsrfToken,
    )
      .query({ expectedVersion: 0 })
      .expect(409);
    expect(deletion.body.error.code).toBe(
      "evidence-cair-reference-protected",
    );
    const lateDetach = await mutation(
      context.adminAgent.delete(
        `/api/cairs/${cairId}/evidence/${evidence.id}`,
      ),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 4 })
      .expect(409);
    expect(lateDetach.body.error.code).toBe(
      "cair-evidence-not-editable",
    );

    await expect(
      context.database.query(
        "UPDATE evidence SET report_caption = 'tampered' WHERE id = $1",
        [evidence.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const actions = (
      await context.adminAgent
        .get(`/api/projects/${projectId}/activity`)
        .expect(200)
    ).body.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "cair.evidence-attached",
        "cair.evidence-detached",
        "cair.submitted",
      ]),
    );
  });

  it("rejects altered evidence bytes and atomically replaces files after render locks clear", async () => {
    const originalPdf = await onePagePdf();
    const stored = await uploadReportPdf(
      originalPdf,
      "replace-me.pdf",
      "Replacement integration evidence",
    );
    const originalRow = await evidenceStorage(stored.id);
    const originalPath = resolveStoredDataPath(
      originalRow.storage_path,
      context.paths,
    );
    await writeFile(originalPath, Buffer.from("tampered evidence bytes"));
    const rejectedDownload = await context.adminAgent
      .get(`/api/evidence/${stored.id}/download`)
      .expect(409);
    expect(rejectedDownload.body.error.code).toBe(
      "stored-file-integrity-failed",
    );
    await writeFile(originalPath, originalPdf);

    const renderingId = randomUUID();
    await context.database.query(
      `
        INSERT INTO report_snapshots(
          id, project_id, mode, status, snapshot_json, validation_json,
          source_hashes_json, created_by, created_at,
          render_owner, render_heartbeat_at
        )
        VALUES (
          $1, $2, 'draft', 'rendering', '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, $3, now(), $4, now()
        )
      `,
      [renderingId, projectId, context.adminUser.id, randomUUID()],
    );

    const lockedReplacement = await mutation(
      context.adminAgent.put(`/api/evidence/${stored.id}/file`),
      context.adminCsrfToken,
    )
      .field("expectedVersion", "0")
      .attach("file", png, {
        filename: "replacement.png",
        contentType: "image/png",
      })
      .expect(409);
    expect(lockedReplacement.body.error.code).toBe(
      "evidence-report-rendering-conflict",
    );
    expect(await evidenceStorage(stored.id)).toEqual(originalRow);
    expect(await readFile(originalPath)).toEqual(originalPdf);

    await context.database.query(
      `
        UPDATE report_snapshots
        SET status = 'failed', completed_at = now(),
            error_message = 'Test render released',
            render_owner = NULL, render_heartbeat_at = NULL
        WHERE id = $1
      `,
      [renderingId],
    );
    const replaced = await mutation(
      context.adminAgent.put(`/api/evidence/${stored.id}/file`),
      context.adminCsrfToken,
    )
      .field("expectedVersion", "0")
      .attach("file", png, {
        filename: "replacement.png",
        contentType: "image/png",
      })
      .expect(200);
    expect(replaced.body.evidence).toMatchObject({
      id: stored.id,
      version: 1,
      display_name: "replacement.png",
      mime_type: "image/png",
      content_sha256: createHash("sha256").update(png).digest("hex"),
    });
    await expect(access(originalPath)).rejects.toThrow();

    const download = await context.adminAgent
      .get(`/api/evidence/${stored.id}/download`)
      .expect(200);
    expect(download.body).toEqual(png);
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);

    const inline = await context.adminAgent
      .get(`/api/evidence/${stored.id}/view`)
      .expect(200);
    expect(inline.body).toEqual(png);
    expect(inline.headers["content-disposition"]).toBe("inline");
    expect(inline.headers["x-content-sha256"]).toBe(
      replaced.body.evidence.content_sha256,
    );

    const staleDelete = await mutation(
      context.adminAgent.delete(`/api/evidence/${stored.id}`),
      context.adminCsrfToken,
    )
      .query({ expectedVersion: 0 })
      .expect(409);
    expect(staleDelete.body.error.code).toBe("version-conflict");

    const replacementRow = await evidenceStorage(stored.id);
    await mutation(
      context.adminAgent.delete(`/api/evidence/${stored.id}`),
      context.adminCsrfToken,
    )
      .query({ expectedVersion: 1 })
      .expect(204);
    await context.adminAgent
      .get(`/api/evidence/${stored.id}/download`)
      .expect(404);
    await expect(
      access(
        resolveStoredDataPath(
          replacementRow.storage_path,
          context.paths,
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps completed report bytes and snapshot provenance immutable, then refuses altered report bytes", async () => {
    const evidencePdf = await onePagePdf();
    const evidence = await uploadReportPdf(
      evidencePdf,
      "snapshot-source.pdf",
      "Caption captured by immutable report",
    );
    const created = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/reports`),
      context.adminCsrfToken,
    )
      .send({ mode: "export" })
      .expect(201);
    expect(created.body.report).toMatchObject({
      project_id: projectId,
      status: "complete",
      mode: "export",
      pdf_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      page_count: expect.any(Number),
      downloadUrl: expect.stringMatching(/^\/api\/reports\//),
    });

    const storedReport = await context.database.one<{
      status: string;
      snapshot_json: {
        provenance: {
          developerDemo: boolean;
          contentSource: string;
          syntheticTechnicalContent: boolean;
        };
        evidence: Array<{
          id: string;
          content_sha256: string;
          report_caption: string;
        }>;
      };
      pdf_path: string;
      pdf_sha256: string;
      pdf_bytes: string;
      page_count: number;
    }>(
      `
        SELECT status, snapshot_json, pdf_path, pdf_sha256,
               pdf_bytes::text, page_count
        FROM report_snapshots
        WHERE id = $1
      `,
      [created.body.report.id],
    );
    expect(storedReport.snapshot_json.provenance).toEqual({
      developerDemo: false,
      contentSource: "persisted-project-records",
      syntheticTechnicalContent: false,
    });
    expect(storedReport.snapshot_json.evidence).toContainEqual(
      expect.objectContaining({
        id: evidence.id,
        content_sha256: evidence.content_sha256,
        report_caption: "Caption captured by immutable report",
      }),
    );

    const originalDownload = await context.adminAgent
      .get(created.body.report.downloadUrl)
      .expect(200);
    expect(originalDownload.body.subarray(0, 5).toString("ascii")).toBe(
      "%PDF-",
    );
    expect(originalDownload.headers["x-content-sha256"]).toBe(
      storedReport.pdf_sha256,
    );
    expect(originalDownload.body.length).toBe(
      Number(storedReport.pdf_bytes),
    );
    const originalSha256 = createHash("sha256")
      .update(originalDownload.body)
      .digest("hex");
    expect(originalSha256).toBe(storedReport.pdf_sha256);

    const metadata = await mutation(
      context.adminAgent.patch(`/api/evidence/${evidence.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: 0,
        reportCaption: "Caption for future reports only",
      })
      .expect(200);
    expect(metadata.body.evidence.version).toBe(1);
    expect(
      await context.database.one(
        "SELECT snapshot_json FROM report_snapshots WHERE id = $1",
        [created.body.report.id],
      ),
    ).toMatchObject({ snapshot_json: storedReport.snapshot_json });

    await expect(
      context.database.query(
        `
          UPDATE report_snapshots
          SET error_message = 'mutated after completion'
          WHERE id = $1
        `,
        [created.body.report.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const reportPath = resolveStoredDataPath(
      storedReport.pdf_path,
      context.paths,
    );
    const originalBytes = await readFile(reportPath);
    try {
      await writeFile(reportPath, Buffer.from("altered report bytes"));
      const rejected = await context.adminAgent
        .get(created.body.report.downloadUrl)
        .expect(409);
      expect(rejected.body.error.code).toBe(
        "stored-file-integrity-failed",
      );
    } finally {
      await writeFile(reportPath, originalBytes);
    }
  }, 120_000);

  it("recovers queued cleanup work and leaves failures observable for operators", async () => {
    const cleanupDirectory = await mkdtemp(
      path.join(context.paths.uploadRoot, "cleanup-"),
    );
    const presentPath = path.join(
      cleanupDirectory,
      "crash-window-orphan.txt",
    );
    const missingPath = path.join(cleanupDirectory, "already-removed.txt");
    await writeFile(presentPath, "orphaned evidence bytes");
    const presentStoredPath = toStoredDataPath(
      presentPath,
      context.paths,
    );
    const missingStoredPath = toStoredDataPath(
      missingPath,
      context.paths,
    );
    const invalidStoredPath = "../outside-managed-data.txt";
    for (const storedPath of [
      presentStoredPath,
      missingStoredPath,
      invalidStoredPath,
    ]) {
      await context.database.query(
        `
          INSERT INTO evidence_file_cleanup(
            storage_path, project_id, reason, queued_at, attempts
          )
          VALUES ($1, $2, 'deletion', now(), 0)
        `,
        [storedPath, projectId],
      );
    }

    expect(
      await processEvidenceFileCleanup(context.database, context.paths),
    ).toEqual({
      processed: 3,
      removed: 2,
      failed: 1,
    });
    await expect(access(presentPath)).rejects.toThrow();
    expect(
      await getEvidenceFileCleanupStatus(context.database),
    ).toEqual({
      pending: 1,
      failed: 1,
    });
    const failure = await context.database.one<{
      attempts: number;
      last_error: string;
    }>(
      `
        SELECT attempts, last_error
        FROM evidence_file_cleanup
        WHERE storage_path = $1
      `,
      [invalidStoredPath],
    );
    expect(failure.attempts).toBe(1);
    expect(failure.last_error).toContain("stored-path-outside-data-root");
    await context.database.query(
      "DELETE FROM evidence_file_cleanup WHERE storage_path = $1",
      [invalidStoredPath],
    );
    await rm(cleanupDirectory, { recursive: true, force: true });
  });

  async function createPart(): Promise<string> {
    const detail = await context.adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(200);
    const brakes = detail.body.flatNodes.find(
      (node: { kind: string; system_code: string | null }) =>
        node.kind === "system" && node.system_code === "BR",
    );
    const assembly = await mutation(
      context.adminAgent.post(`/api/nodes/${brakes.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: brakes.version,
        kind: "assembly",
        name: "Evidence test assembly",
        quantity: "1",
        procurementType: "made",
      })
      .expect(201);
    const part = await mutation(
      context.adminAgent.post(
        `/api/nodes/${assembly.body.node.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: assembly.body.node.version,
        kind: "part",
        name: "Evidence test part",
        quantity: "1",
        procurementType: "made",
      })
      .expect(201);
    return part.body.node.id as string;
  }

  async function uploadReportPdf(
    pdf: Buffer,
    filename: string,
    caption: string,
  ): Promise<{
    id: string;
    content_sha256: string;
    version: number;
  }> {
    const response = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "drawing")
      .field("nodeId", partId)
      .field("visibility", "report")
      .field("reportCaption", caption)
      .attach("file", pdf, {
        filename,
        contentType: "application/pdf",
      })
      .expect(201);
    return response.body.evidence;
  }

  async function evidenceStorage(evidenceId: string): Promise<{
    storage_path: string;
    content_sha256: string;
    display_name: string;
    mime_type: string;
    version: number;
  }> {
    return await context.database.one(
      `
        SELECT storage_path, content_sha256, display_name, mime_type, version
        FROM evidence
        WHERE id = $1
      `,
      [evidenceId],
    );
  }
  });

async function onePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  page.drawText("Verified production evidence", {
    x: 20,
    y: 100,
    size: 10,
  });
  return Buffer.from(await document.save());
}
