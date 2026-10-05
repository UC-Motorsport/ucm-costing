import { Router } from "express";
import { z } from "zod";

import type { DatabaseHandle } from "../db/database";
import {
  actorContextFromRequest,
} from "../security/http-security";
import { assertProjectPermission } from "../security/authorization";
import {
  confirmProjectSetup,
  listActiveProjects,
  updateProject,
  type ProjectRow,
} from "../services/project-lifecycle-service";
import { getProjectDetail } from "../services/project-detail-service";
import { listProjectAuditEntries } from "../services/audit-query-service";
import { validateProjectForActor } from "../services/validation-service";
import { asyncRoute, routeParam } from "./http";

export function createProjectRouter(database: DatabaseHandle): Router {
  const router = Router();

  router.get(
    "/",
    asyncRoute(async (_request, response) => {
      const projects = await listActiveProjects(database);
      response.json({ projects: projects.map(projectForApi) });
    }),
  );

  router.get(
    "/:projectId",
    asyncRoute(async (request, response) => {
      const projectId = routeParam(request, "projectId");
      const actor = actorContextFromRequest(request);
      await assertProjectPermission(database, actor, projectId, "read");
      const detail = await getProjectDetail(database, projectId);
      if (!detail) {
        throw new Error("project-not-found");
      }
      response.json(detail);
    }),
  );

  router.patch(
    "/:projectId",
    asyncRoute(async (request, response) => {
      const project = await updateProject(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.body,
      );
      response.json({ project: projectForApi(project) });
    }),
  );

  router.post(
    "/:projectId/declarations",
    asyncRoute(async (request, response) => {
      const project = await confirmProjectSetup(
        database,
        actorContextFromRequest(request),
        routeParam(request, "projectId"),
        request.body,
      );
      response.status(201).json({ project: projectForApi(project) });
    }),
  );

  router.get(
    "/:projectId/validation",
    asyncRoute(async (request, response) => {
      const query = z
        .object({
          mode: z
            .enum(["draft", "deadline", "competition-ready", "export"])
            .default("competition-ready"),
        })
        .parse(request.query);
      response.json(
        await validateProjectForActor(
          database,
          actorContextFromRequest(request),
          routeParam(request, "projectId"),
          query.mode,
        ),
      );
    }),
  );

  router.get(
    "/:projectId/activity",
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
          routeParam(request, "projectId"),
          { beforeSequence: query.cursor, limit: query.limit },
        ),
      );
    }),
  );

  return router;
}

export function projectForApi(project: ProjectRow) {
  const { focus_systems_json: focusSystemsJson, ...safe } = project;
  return {
    ...safe,
    focusSystems: JSON.parse(focusSystemsJson) as string[],
  };
}
