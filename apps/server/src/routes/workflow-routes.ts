import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import { actorContextFromRequest } from "../security/http-security";
import {
  addCostAmendmentItem,
  assertCostAmendmentMayLock,
  createCostAmendmentDraft,
  deleteCostAmendmentItem,
  getCostAmendmentDetail,
  listCostAmendments,
  updateCostAmendmentItem,
} from "../services/cost-amendment-service";
import { createCostAmendmentPreviewArtifact } from "../services/cost-amendment-preview-service";
import {
  attachCairEvidence,
  createCairDraft,
  detachCairEvidence,
  getCair,
  listCairs,
  transitionCair,
  updateCairDraft,
} from "../services/cair-service";
import {
  markSubmissionExported,
  getSubmission,
  listSubmissions,
  recordManualSubmission,
} from "../services/submission-service";
import { prepareSubmissionPackage } from "../services/submission-package-service";
import {
  artifactForApi,
} from "./report-routes";
import { asyncRoute, routeParam } from "./http";

const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "workflow-generation-rate-limited",
      message: "Too many export operations; try again later",
    },
  },
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export function createWorkflowRouter(
  database: DatabaseHandle,
  paths: AppPaths,
): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/cairs",
    asyncRoute(async (request, response) => {
      const query = paginationSchema.parse(request.query);
      response.json({
        cairs: await listCairs(
          database,
          actorContextFromRequest(request),
          routeParam(request, "projectId"),
          query.limit,
          query.offset,
        ),
      });
    }),
  );

  router.post(
    "/projects/:projectId/cairs",
    asyncRoute(async (request, response) => {
      const cair = await createCairDraft(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.body,
      );
      response.status(201).json({ cair });
    }),
  );

  router.delete(
    "/cairs/:cairId/evidence/:evidenceId",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          expectedVersion: z.number().int().nonnegative(),
        })
        .parse(request.body);
      const cair = await detachCairEvidence(
        database,
        actorContextFromRequest(request),
        routeParam(request, "cairId"),
        routeParam(request, "evidenceId"),
        input.expectedVersion,
      );
      response.json({ cair });
    }),
  );

  router.get(
    "/cairs/:cairId",
    asyncRoute(async (request, response) => {
      const cair = await getCair(
        database,
        actorContextFromRequest(request),
        routeParam(request, "cairId"),
      );
      if (!cair) {
        throw new Error("cair-not-found");
      }
      response.json({ cair });
    }),
  );

  router.put(
    "/cairs/:cairId",
    asyncRoute(async (request, response) => {
      const expectedVersion = z
        .object({ expectedVersion: z.number().int().nonnegative() })
        .parse(request.body).expectedVersion;
      const cair = await updateCairDraft(
        database,
        actorContextFromRequest(request),
        routeParam(request, "cairId"),
        request.body,
        expectedVersion,
      );
      response.json({ cair });
    }),
  );

  router.post(
    "/cairs/:cairId/transitions",
    asyncRoute(async (request, response) => {
      const cair = await transitionCair(
        database,
        actorContextFromRequest(request),
        routeParam(request, "cairId"),
        request.body,
        paths,
      );
      response.json({ cair });
    }),
  );

  router.post(
    "/cairs/:cairId/evidence",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          evidenceId: z.string().trim().min(1),
          expectedVersion: z.number().int().nonnegative(),
        })
        .parse(request.body);
      const cair = await attachCairEvidence(
        database,
        actorContextFromRequest(request),
        routeParam(request, "cairId"),
        input.evidenceId,
        input.expectedVersion,
      );
      response.json({ cair });
    }),
  );

  router.get(
    "/projects/:projectId/cost-amendments",
    asyncRoute(async (request, response) => {
      const query = paginationSchema.parse(request.query);
      response.json({
        amendments: await listCostAmendments(
          database,
          actorContextFromRequest(request),
          routeParam(request, "projectId"),
          query.limit,
          query.offset,
        ),
      });
    }),
  );

  router.post(
    "/projects/:projectId/cost-amendments",
    asyncRoute(async (request, response) => {
      const amendment = await createCostAmendmentDraft(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.body,
      );
      response.status(201).json({ amendment });
    }),
  );

  router.get(
    "/cost-amendments/:amendmentId",
    asyncRoute(async (request, response) => {
      const detail = await getCostAmendmentDetail(
        database,
        actorContextFromRequest(request),
        routeParam(request, "amendmentId"),
      );
      if (!detail) {
        throw new Error("cost-amendment-not-found");
      }
      response.json(detail);
    }),
  );

  router.post(
    "/cost-amendments/:amendmentId/items",
    asyncRoute(async (request, response) => {
      const expectedAmendmentVersion = expectedAmendmentVersionFrom(
        request.body,
      );
      response.status(201).json(
        await addCostAmendmentItem(
          database,
          actorContextFromRequest(request),
          routeParam(request, "amendmentId"),
          expectedAmendmentVersion,
          request.body,
        ),
      );
    }),
  );

  router.put(
    "/cost-amendments/:amendmentId/items/:itemId",
    asyncRoute(async (request, response) => {
      const expectedAmendmentVersion = expectedAmendmentVersionFrom(
        request.body,
      );
      response.json(
        await updateCostAmendmentItem(
          database,
          actorContextFromRequest(request),
          routeParam(request, "amendmentId"),
          routeParam(request, "itemId"),
          expectedAmendmentVersion,
          request.body,
        ),
      );
    }),
  );

  router.delete(
    "/cost-amendments/:amendmentId/items/:itemId",
    asyncRoute(async (request, response) => {
      const expectedAmendmentVersion = expectedAmendmentVersionFrom(
        request.body,
      );
      response.json(
        await deleteCostAmendmentItem(
          database,
          actorContextFromRequest(request),
          routeParam(request, "amendmentId"),
          routeParam(request, "itemId"),
          expectedAmendmentVersion,
        ),
      );
    }),
  );

  router.post(
    "/cost-amendments/:amendmentId/preview",
    generationLimiter,
    asyncRoute(async (request, response) => {
      const artifact = await createCostAmendmentPreviewArtifact(
        database,
        paths,
        actorContextFromRequest(request),
        routeParam(request, "amendmentId"),
      );
      response.status(201).json({ artifact: artifactForApi(artifact) });
    }),
  );

  router.post(
    "/cost-amendments/:amendmentId/lock",
    asyncRoute(async (request, response) => {
      const detail = await getCostAmendmentDetail(
        database,
        actorContextFromRequest(request),
        routeParam(request, "amendmentId"),
      );
      if (!detail) {
        throw new Error("cost-amendment-not-found");
      }
      assertCostAmendmentMayLock(detail);
      response.status(204).end();
    }),
  );

  router.get(
    "/projects/:projectId/submissions",
    asyncRoute(async (request, response) => {
      const query = paginationSchema.parse(request.query);
      response.json({
        submissions: await listSubmissions(
          database,
          actorContextFromRequest(request),
          routeParam(request, "projectId"),
          query.limit,
          query.offset,
        ),
      });
    }),
  );

  router.post(
    "/projects/:projectId/submissions/prepare",
    generationLimiter,
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          reportSnapshotId: z.string().trim().min(1),
          supportingArtifactId: z.string().trim().min(1),
        })
        .parse(request.body);
      const prepared = await prepareSubmissionPackage(
        database,
        paths,
        actorContextFromRequest(request),
        {
          projectId: routeParam(request, "projectId"),
          ...input,
        },
      );
      response.status(201).json({
        submission: prepared.submission,
        packageArtifact: artifactForApi(prepared.packageArtifact),
        manifestArtifact: artifactForApi(prepared.manifestArtifact),
      });
    }),
  );

  router.get(
    "/submissions/:submissionId",
    asyncRoute(async (request, response) => {
      const submission = await getSubmission(
        database,
        actorContextFromRequest(request),
        routeParam(request, "submissionId"),
      );
      if (!submission) {
        throw new Error("submission-not-found");
      }
      response.json({ submission });
    }),
  );

  router.post(
    "/submissions/:submissionId/exported",
    asyncRoute(async (request, response) => {
      const input = z
        .object({ expectedVersion: z.number().int().nonnegative() })
        .parse(request.body);
      const submission = await markSubmissionExported(
        database,
        actorContextFromRequest(request),
        routeParam(request, "submissionId"),
        input.expectedVersion,
      );
      response.json({ submission });
    }),
  );

  router.post(
    "/submissions/:submissionId/manual-submission",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          externalReference: z.string().trim().min(1).max(2_000),
        })
        .parse(request.body);
      const submission = await recordManualSubmission(
        database,
        actorContextFromRequest(request),
        routeParam(request, "submissionId"),
        input.expectedVersion,
        input.externalReference,
      );
      response.json({ submission });
    }),
  );

  return router;
}

function expectedAmendmentVersionFrom(body: unknown): number {
  return z
    .object({
      expectedAmendmentVersion: z.number().int().nonnegative(),
    })
    .parse(body).expectedAmendmentVersion;
}
