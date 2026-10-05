import path from "node:path";
import { pipeline } from "node:stream/promises";

import { Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";

import { resolveStoredDataPath, type AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  createVerifiedReadStream,
  openVerifiedFile,
} from "../integrity/file-integrity";
import { actorContextFromRequest } from "../security/http-security";
import {
  deleteEvidence,
  getEvidenceForActor,
  listEvidence,
  replaceEvidenceFile,
  storeEvidence,
  updateEvidenceMetadata,
  type EvidenceRow,
} from "../services/evidence-service";
import { asyncRoute, routeParam } from "./http";
import { evidenceThumbnail } from "../services/evidence-thumbnail-service";

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    fields: 20,
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "upload-rate-limited",
      message: "Too many uploads; try again later",
    },
  },
});

export function createEvidenceRouter(
  database: DatabaseHandle,
  paths: AppPaths,
): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/evidence",
    asyncRoute(async (request, response) => {
      const evidence = await listEvidence(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
      );
      response.json({ evidence: evidence.map(evidenceForApi) });
    }),
  );

  router.post(
    "/projects/:projectId/evidence",
    uploadLimiter,
    evidenceUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) {
        throw new Error("evidence-file-required");
      }
      const evidence = await storeEvidence(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.file,
        {
          kind: request.body.kind,
          nodeId: request.body.nodeId || null,
          visibility: request.body.visibility,
          reportCaption: request.body.reportCaption,
        },
      );
      response.status(201).json({ evidence: evidenceForApi(evidence) });
    }),
  );

  router.patch(
    "/evidence/:evidenceId",
    asyncRoute(async (request, response) => {
      const evidence = await updateEvidenceMetadata(
        database,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
        request.body,
      );
      response.json({ evidence: evidenceForApi(evidence) });
    }),
  );

  router.put(
    "/evidence/:evidenceId/file",
    uploadLimiter,
    evidenceUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) {
        throw new Error("evidence-file-required");
      }
      const evidence = await replaceEvidenceFile(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
        request.file,
        { expectedVersion: request.body.expectedVersion },
      );
      response.json({ evidence: evidenceForApi(evidence) });
    }),
  );

  router.delete(
    "/evidence/:evidenceId",
    asyncRoute(async (request, response) => {
      const expectedVersion = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(request.query.expectedVersion);
      await deleteEvidence(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
        expectedVersion,
      );
      response.status(204).end();
    }),
  );

  router.get(
    "/evidence/:evidenceId/thumbnail",
    asyncRoute(async (request, response) => {
      const evidence = await getEvidenceForActor(
        database,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
      );
      if (!evidence) throw new Error("evidence-not-found");
      const png = await evidenceThumbnail(evidence, paths);
      response.setHeader("cache-control", "private, no-cache");
      response.type("image/png").send(Buffer.from(png));
    }),
  );

  router.get(
    "/evidence/:evidenceId/view",
    asyncRoute(async (request, response) => {
      const evidence = await getEvidenceForActor(
        database,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
      );
      if (!evidence) {
        throw new Error("evidence-not-found");
      }
      await streamEvidence(response, evidence, paths, "inline");
    }),
  );

  router.get(
    "/evidence/:evidenceId/download",
    asyncRoute(async (request, response) => {
      const evidence = await getEvidenceForActor(
        database,
        actorContextFromRequest(request),
        routeParam(request, "evidenceId"),
      );
      if (!evidence) {
        throw new Error("evidence-not-found");
      }
      await streamEvidence(response, evidence, paths, "attachment");
    }),
  );

  return router;
}

export function evidenceForApi(evidence: EvidenceRow) {
  const { storage_path: _storagePath, ...safe } = evidence;
  return {
    ...safe,
    viewUrl: `/api/evidence/${evidence.id}/view`,
    thumbnailUrl:
      evidence.mime_type === "application/pdf"
        ? `/api/evidence/${evidence.id}/thumbnail?v=${evidence.version}`
        : null,
    downloadUrl: `/api/evidence/${evidence.id}/download`,
  };
}

async function streamEvidence(
  response: Response,
  evidence: EvidenceRow,
  paths: AppPaths,
  disposition: "inline" | "attachment",
): Promise<void> {
  const verified = await openVerifiedFile(
    resolveStoredDataPath(evidence.storage_path, paths),
    evidence.content_sha256,
  );
  if (
    evidence.byte_size !== null &&
    verified.stats.size !== Number(evidence.byte_size)
  ) {
    await verified.handle.close();
    throw new Error("stored-file-byte-size-mismatch");
  }
  response.status(200);
  response.type(evidence.mime_type);
  if (disposition === "attachment") {
    response.attachment(safeDownloadName(evidence.display_name));
  } else {
    response.setHeader("content-disposition", "inline");
  }
  response.setHeader("content-length", String(verified.stats.size));
  response.setHeader("x-content-sha256", verified.sha256);
  await pipeline(createVerifiedReadStream(verified), response);
}

function safeDownloadName(displayName: string): string {
  const basename = path.basename(displayName).replaceAll(/[\r\n"]/g, "_");
  return basename.length > 0 ? basename.slice(0, 255) : "evidence";
}
