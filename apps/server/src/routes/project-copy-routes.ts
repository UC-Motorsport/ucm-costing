import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import { actorContextFromRequest } from "../security/http-security";
import {
  commitProjectCopy,
  previewProjectCopy,
} from "../services/project-copy-service";
import { asyncRoute } from "./http";

export function createProjectCopyRouter(
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
  router.post(
    "/preview",
    asyncRoute(async (request, response) => {
      response.json(
        await previewProjectCopy(
          database,
          actorContextFromRequest(request),
          request.body,
        ),
      );
    }),
  );
  router.post(
    "/commit",
    asyncRoute(async (request, response) => {
      const result = await commitProjectCopy(
        database,
        paths,
        actorContextFromRequest(request),
        request.body,
      );
      response.status(result.alreadyCommitted ? 200 : 201).json(result);
    }),
  );
  return router;
}
