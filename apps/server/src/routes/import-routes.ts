import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";

import type { DatabaseHandle } from "../db/database";
import {
  actorContextFromRequest,
  requireSystemRole,
} from "../security/http-security";
import {
  cancelImportPreview,
  commitImportPreview,
  createImportPreview,
  getImportPreview,
  listImportBatches,
} from "../services/import-service";
import { asyncRoute, routeParam } from "./http";

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
    fields: 10,
  },
});

const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "import-rate-limited",
      message: "Too many import operations; try again later",
    },
  },
});

export function createImportRouter(database: DatabaseHandle): Router {
  const router = Router();
  router.use(requireSystemRole("admin"));
  router.use(importLimiter);

  router.get(
    "/projects/:projectId/imports",
    asyncRoute(async (request, response) => {
      const query = z
        .object({
          status: z.enum(["preview", "committed", "cancelled"]).optional(),
          cursor: z.string().max(1_000).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(request.query);
      response.json(
        await listImportBatches(
          database,
          actorContextFromRequest(request),
          routeParam(request, "projectId"),
          query,
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/imports/preview",
    importUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) {
        throw new Error("import-file-required");
      }
      const preview = await createImportPreview(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.file.originalname,
        request.file.buffer,
      );
      response.status(201).json(preview);
    }),
  );

  router.get(
    "/imports/:batchId",
    asyncRoute(async (request, response) => {
      const preview = await getImportPreview(
        database,
        actorContextFromRequest(request),
        routeParam(request, "batchId"),
      );
      if (!preview) {
        throw new Error("import-not-found");
      }
      response.json(preview);
    }),
  );

  router.delete(
    "/imports/:batchId",
    asyncRoute(async (request, response) => {
      const input = z
        .object({ expectedVersion: z.number().int().nonnegative() })
        .parse(request.body);
      const preview = await cancelImportPreview(
        database,
        actorContextFromRequest(request),
        routeParam(request, "batchId"),
        input.expectedVersion,
      );
      response.json(preview);
    }),
  );

  router.post(
    "/imports/:batchId/commit",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          commitValidOnly: z.boolean().default(false),
          idempotencyKey: z.string().min(8).max(200),
        })
        .parse(request.body);
      response.json(
        await commitImportPreview(
          database,
          actorContextFromRequest(request),
          routeParam(request, "batchId"),
          input,
        ),
      );
    }),
  );

  return router;
}
