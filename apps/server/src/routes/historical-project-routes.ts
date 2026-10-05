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
  commitHistoricalProject,
  previewHistoricalProject,
} from "../services/historical-project-service";
import { projectForApi } from "./project-routes";
import { asyncRoute } from "./http";

const historicalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 20 },
});

const historicalLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const baseFields = z.object({
  season: z.coerce.number().int().min(2020).max(2100),
  name: z.string().trim().min(2).max(120),
  entryNumber: z.string().trim().min(1).max(20),
  vehicleType: z.enum(["electric", "combustion", "dual"]),
});

export function createHistoricalProjectRouter(
  database: DatabaseHandle,
): Router {
  const router = Router();
  router.use(requireSystemRole("admin"));
  router.use(historicalLimiter);

  router.post(
    "/preview",
    historicalUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error("import-file-required");
      const input = baseFields.parse(request.body);
      response.json(
        await previewHistoricalProject(
          database,
          request.file.originalname,
          request.file.buffer,
          input,
        ),
      );
    }),
  );

  router.post(
    "/commit",
    historicalUpload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error("import-file-required");
      const input = baseFields
        .extend({
          expectedSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
          idempotencyKey: z.string().min(8).max(200),
          commitValidOnly: z.coerce.boolean().default(true),
        })
        .parse(request.body);
      const result = await commitHistoricalProject(
        database,
        actorContextFromRequest(request),
        request.file.originalname,
        request.file.buffer,
        input,
      );
      response.status(result.alreadyImported ? 200 : 201).json({
        ...result,
        project: projectForApi(result.project),
      });
    }),
  );

  return router;
}
