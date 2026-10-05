import path from "node:path";
import { pipeline } from "node:stream/promises";

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import {
  resolveStoredDataPath,
  type AppPaths,
} from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  createVerifiedReadStream,
  openVerifiedFile,
} from "../integrity/file-integrity";
import { actorContextFromRequest } from "../security/http-security";
import {
  getArtifactForActor,
  listArtifacts,
  type ArtifactRow,
} from "../services/artifact-service";
import {
  createReport,
  listReports,
  openReportDownload,
  type ReportSnapshotRow,
} from "../services/report-service";
import { createSupportingWorkbookArtifact } from "../services/supporting-workbook-service";
import { asyncRoute, routeParam } from "./http";

const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "report-rate-limited",
      message: "Too many report or export operations; try again later",
    },
  },
});

export function createReportRouter(
  database: DatabaseHandle,
  paths: AppPaths,
): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/reports",
    asyncRoute(async (request, response) => {
      const query = paginationSchema.parse(request.query);
      const reports = await listReports(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        query.limit,
        query.offset,
      );
      response.json({ reports: reports.map(reportForApi) });
    }),
  );

  router.post(
    "/projects/:projectId/reports",
    generationLimiter,
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          mode: z.enum([
            "draft",
            "deadline",
            "competition-ready",
            "export",
          ]),
        })
        .parse(request.body);
      const report = await createReport(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        input.mode,
        { paths },
      );
      response.status(201).json({ report: reportForApi(report) });
    }),
  );

  router.get(
    "/reports/:reportId/download",
    asyncRoute(async (request, response) => {
      const { report, verified } = await openReportDownload(
        database,
        actorContextFromRequest(request),
        routeParam(request, "reportId"),
        paths,
      );
      response.status(200);
      response.type("application/pdf");
      response.attachment(
        report.mode === "export"
          ? `UCM-${report.project_id}-cost-report.pdf`
          : `UCM-${report.project_id}-${report.mode}-cost-report.pdf`,
      );
      response.setHeader("content-length", String(verified.stats.size));
      response.setHeader("x-content-sha256", verified.sha256);
      await pipeline(createVerifiedReadStream(verified), response);
    }),
  );

  router.post(
    "/reports/:reportId/supporting-workbook",
    generationLimiter,
    asyncRoute(async (request, response) => {
      const artifact = await createSupportingWorkbookArtifact(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "reportId"),
      );
      response.status(201).json({ artifact: artifactForApi(artifact) });
    }),
  );

  router.get(
    "/projects/:projectId/artifacts",
    asyncRoute(async (request, response) => {
      const query = paginationSchema.parse(request.query);
      const artifacts = await listArtifacts(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        query.limit,
        query.offset,
      );
      response.json({ artifacts: artifacts.map(artifactForApi) });
    }),
  );

  router.get(
    "/artifacts/:artifactId/download",
    asyncRoute(async (request, response) => {
      const artifact = await getArtifactForActor(
        database,
        actorContextFromRequest(request),
        routeParam(request, "artifactId"),
      );
      if (
        !artifact ||
        artifact.status !== "complete" ||
        !artifact.storage_path ||
        !artifact.content_sha256 ||
        !artifact.mime_type
      ) {
        throw new Error("artifact-not-complete");
      }
      const verified = await openVerifiedFile(
        resolveStoredDataPath(artifact.storage_path, paths),
        artifact.content_sha256,
      );
      if (
        artifact.byte_size !== null &&
        verified.stats.size !== Number(artifact.byte_size)
      ) {
        await verified.handle.close();
        throw new Error("artifact-byte-size-mismatch");
      }
      response.status(200);
      response.type(artifact.mime_type);
      response.attachment(artifactFilename(artifact));
      response.setHeader("content-length", String(verified.stats.size));
      response.setHeader("x-content-sha256", verified.sha256);
      await pipeline(createVerifiedReadStream(verified), response);
    }),
  );

  return router;
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export function reportForApi(report: ReportSnapshotRow) {
  const {
    snapshot_json: _snapshot,
    validation_json: validation,
    source_hashes_json: sourceHashes,
    pdf_path: _pdfPath,
    render_owner: _renderOwner,
    render_heartbeat_at: _renderHeartbeatAt,
    ...safe
  } = report;
  return {
    ...safe,
    validation,
    sourceHashes,
    downloadUrl:
      report.status === "complete"
        ? `/api/reports/${report.id}/download`
        : null,
  };
}

export function artifactForApi(artifact: ArtifactRow) {
  const { storage_path: _storagePath, ...safe } = artifact;
  return {
    ...safe,
    downloadUrl:
      artifact.status === "complete"
        ? `/api/artifacts/${artifact.id}/download`
        : null,
  };
}

function artifactFilename(artifact: ArtifactRow): string {
  const candidate = artifact.metadata_json.filename;
  if (
    typeof candidate === "string" &&
    candidate === path.basename(candidate) &&
    candidate.length > 0 &&
    candidate.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return candidate;
  }
  return `${artifact.kind}-${artifact.id}`;
}
