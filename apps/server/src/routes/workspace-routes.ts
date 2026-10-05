import { Router } from "express";
import { z } from "zod";

import type { DatabaseHandle } from "../db/database";
import {
  actorContextFromRequest,
} from "../security/http-security";
import { assertProjectPermission } from "../security/authorization";
import { listProjectAuditEntries } from "../services/audit-query-service";
import { getProjectDetail } from "../services/project-detail-service";
import {
  confirmProjectSetup,
  updateProject,
} from "../services/project-lifecycle-service";
import { getTeamWorkspaceId } from "../services/workspace-service";
import { asyncRoute } from "./http";
import { projectForApi } from "./project-routes";

export function createWorkspaceRouter(
  database: DatabaseHandle,
): Router {
  const router = Router();

  router.get(
    "/",
    asyncRoute(async (request, response) => {
      const workspaceId = await getTeamWorkspaceId(database);
      await assertProjectPermission(
        database,
        actorContextFromRequest(request),
        workspaceId,
        "read",
      );
      const detail = await getProjectDetail(database, workspaceId);
      if (!detail) {
        throw new Error("workspace-not-provisioned");
      }
      response.json(detail);
    }),
  );

  router.patch(
    "/",
    asyncRoute(async (request, response) => {
      const workspaceId = await getTeamWorkspaceId(database);
      const project = await updateProject(
        database,
        actorContextFromRequest(request),
        workspaceId,
        request.body,
      );
      response.json({ project: projectForApi(project) });
    }),
  );

  router.post(
    "/report-setup-confirmation",
    asyncRoute(async (request, response) => {
      const workspaceId = await getTeamWorkspaceId(database);
      const project = await confirmProjectSetup(
        database,
        actorContextFromRequest(request),
        workspaceId,
        request.body,
      );
      response.status(201).json({ project: projectForApi(project) });
    }),
  );

  router.get(
    "/activity",
    asyncRoute(async (request, response) => {
      const query = z
        .object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      response.json(
        await listProjectAuditEntries(
          database,
          actorContextFromRequest(request),
          await getTeamWorkspaceId(database),
          { beforeSequence: query.cursor, limit: query.limit },
        ),
      );
    }),
  );

  return router;
}
