import { createHash } from "node:crypto";

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";

import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  actorContextFromRequest,
  requireSystemRole,
} from "../security/http-security";
import {
  commitProjectArchive,
  exportProjectArchive,
  previewProjectArchive,
} from "../services/project-archive-service";
import { storeEvidenceIdempotently } from "../services/evidence-service";
import { asyncRoute, routeParam } from "./http";

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 1, fields: 20 },
});

const sidecarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 20 },
});

const historicalSidecarSchema = z.object({
  expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  reportCaption: z.string().trim().min(1).max(500),
});

export function createProjectArchiveRouter(
  database: DatabaseHandle,
  paths: AppPaths,
): Router {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1_000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.get(
    "/:projectId/download",
    asyncRoute(async (request, response) => {
      const result = await exportProjectArchive(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
      );
      response.status(200);
      response.type("application/zip");
      response.attachment(result.filename);
      response.setHeader("content-length", String(result.bytes.byteLength));
      response.setHeader("x-content-sha256", result.archiveSha256);
      response.setHeader("x-manifest-sha256", result.manifestSha256);
      response.send(Buffer.from(result.bytes));
    }),
  );
  router.post(
    "/preview",
    requireSystemRole("admin"),
    archiveUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error("archive-file-required");
      response.json(
        await previewProjectArchive(database, request.file.buffer, request.body),
      );
    }),
  );
  router.post(
    "/commit",
    requireSystemRole("admin"),
    archiveUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error("archive-file-required");
      const result = await commitProjectArchive(
        database,
        paths,
        actorContextFromRequest(request),
        request.file.buffer,
        request.body,
      );
      response.status(result.alreadyImported ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/:projectId/evidence-sidecar",
    requireSystemRole("admin"),
    sidecarUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error("evidence-file-required");
      if (!/^historical-evidence-chunk-\d{3}\.pdf$/.test(request.file.originalname)) {
        throw new Error("archive-sidecar-name-invalid");
      }
      const input = historicalSidecarSchema.parse(request.body);
      const contentSha256 = createHash("sha256")
        .update(request.file.buffer)
        .digest("hex");
      if (contentSha256 !== input.expectedContentSha256) {
        throw new Error("archive-sidecar-integrity-mismatch");
      }
      const stored = await storeEvidenceIdempotently(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.file,
        {
          kind: "other",
          visibility: "report",
          reportCaption: input.reportCaption,
        },
        { allowHistorical: true },
      );
      response.status(stored.alreadyStored ? 200 : 201).json({
        alreadyStored: stored.alreadyStored,
        evidenceId: stored.evidence.id,
        displayName: stored.evidence.display_name,
        contentSha256: stored.evidence.content_sha256,
      });
    }),
  );
  return router;
}
