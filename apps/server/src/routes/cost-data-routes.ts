import { Router } from "express";
import { z } from "zod";

import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import { actorContextFromRequest } from "../security/http-security";
import { processEvidenceFileCleanup } from "../services/evidence-service";
import {
  createCostLine,
  deleteCostLine,
  deleteCostLines,
  reorderCostLines,
  updateCostLine,
} from "../services/cost-line-service";
import {
  importHistoricalCostLine,
  importHistoricalCostLines,
  listHistoricalSourceCosts,
  searchHistoricalCostSources,
  searchHistoricalCostLines,
} from "../services/historical-cost-line-service";
import {
  catalogueItemKinds,
  createTeamCatalogueItem,
  getCatalogueItem,
  reviseCatalogueItem,
  searchCatalogue,
} from "../services/catalogue-service";
import {
  createNode,
  deleteNode,
  moveNode,
  updateNode,
} from "../services/project-node-service";
import { asyncRoute, routeParam } from "./http";
import { reorderNodeChildren } from "../services/node-order-service";

export function createCostDataRouter(
  database: DatabaseHandle,
  paths: AppPaths,
): Router {
  const router = Router();

  router.patch(
    "/nodes/:nodeId/cost-lines/order",
    asyncRoute(async (request, response) => {
      await reorderCostLines(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        request.body,
      );
      response.status(204).end();
    }),
  );

  router.post(
    "/nodes/:nodeId/cost-lines/delete-batch",
    asyncRoute(async (request, response) => {
      await deleteCostLines(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        request.body,
      );
      response.status(204).end();
    }),
  );

  router.patch(
    "/nodes/:parentId/children/order",
    asyncRoute(async (request, response) => {
      response.json(
        await reorderNodeChildren(
          database,
          actorContextFromRequest(request),
          routeParam(request, "parentId"),
          request.body,
        ),
      );
    }),
  );

  router.post(
    "/nodes/:nodeId/move",
    asyncRoute(async (request, response) => {
      const node = await moveNode(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        request.body,
      );
      response.json({ node });
    }),
  );

  router.patch(
    "/nodes/:nodeId",
    asyncRoute(async (request, response) => {
      const node = await updateNode(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        request.body,
      );
      response.json({ node });
    }),
  );

  router.post(
    "/nodes/:parentId/children",
    asyncRoute(async (request, response) => {
      const node = await createNode(
        database,
        actorContextFromRequest(request),
        routeParam(request, "parentId"),
        request.body,
      );
      response.status(201).json({ node });
    }),
  );

  router.delete(
    "/nodes/:nodeId",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          expectedVersion: z.coerce.number().int().nonnegative(),
          cascade: z
            .enum(["true", "false"])
            .default("false")
            .transform((value) => value === "true"),
        })
        .parse(request.query);
      const queuedEvidencePaths = await deleteNode(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        input.expectedVersion,
        input.cascade,
      );
      for (const storagePath of queuedEvidencePaths) {
        await processEvidenceFileCleanup(database, paths, { storagePath });
      }
      response.status(204).end();
    }),
  );

  router.post(
    "/nodes/:nodeId/cost-lines",
    asyncRoute(async (request, response) => {
      const line = await createCostLine(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        request.body,
      );
      response.status(201).json({ line });
    }),
  );

  router.get(
    "/nodes/:nodeId/cost-lines/import-2025",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          q: z.string().max(200).default(""),
          limit: z.coerce.number().int().min(1).max(100).default(40),
        })
        .parse(request.query);
      response.json(
        await searchHistoricalCostLines(
          database,
          actorContextFromRequest(request),
          routeParam(request, "nodeId"),
          input.q,
          input.limit,
        ),
      );
    }),
  );

  router.post(
    "/nodes/:nodeId/cost-lines/import-2025",
    asyncRoute(async (request, response) => {
      const input = z
        .object({ sourceLineId: z.string().min(1) })
        .parse(request.body);
      const result = await importHistoricalCostLine(
        database,
        actorContextFromRequest(request),
        routeParam(request, "nodeId"),
        input.sourceLineId,
      );
      response.status(201).json(result);
    }),
  );

  router.get(
    "/nodes/:nodeId/cost-lines/import-2025/sources",
    asyncRoute(async (request, response) => {
      const { q } = z
        .object({ q: z.string().max(200).default("") })
        .parse(request.query);
      response.json(
        await searchHistoricalCostSources(
          database,
          actorContextFromRequest(request),
          routeParam(request, "nodeId"),
          q,
        ),
      );
    }),
  );
  router.get(
    "/nodes/:nodeId/cost-lines/import-2025/sources/:sourceNodeId",
    asyncRoute(async (request, response) => {
      response.json(
        await listHistoricalSourceCosts(
          database,
          actorContextFromRequest(request),
          routeParam(request, "nodeId"),
          routeParam(request, "sourceNodeId"),
        ),
      );
    }),
  );
  router.post(
    "/nodes/:nodeId/cost-lines/import-2025/batch",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          sourceNodeId: z.string().min(1),
          sourceLineIds: z
            .array(z.string().min(1))
            .min(1)
            .max(1000)
            .refine(
              (ids) => new Set(ids).size === ids.length,
              "Select each row once",
            ),
        })
        .parse(request.body);
      response
        .status(201)
        .json(
          await importHistoricalCostLines(
            database,
            actorContextFromRequest(request),
            routeParam(request, "nodeId"),
            input.sourceNodeId,
            input.sourceLineIds,
          ),
        );
    }),
  );

  router.put(
    "/cost-lines/:lineId",
    asyncRoute(async (request, response) => {
      const line = await updateCostLine(
        database,
        actorContextFromRequest(request),
        routeParam(request, "lineId"),
        request.body,
      );
      response.json({ line });
    }),
  );

  router.delete(
    "/cost-lines/:lineId",
    asyncRoute(async (request, response) => {
      const expectedVersion = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(request.query.expectedVersion);
      await deleteCostLine(
        database,
        actorContextFromRequest(request),
        routeParam(request, "lineId"),
        expectedVersion,
      );
      response.status(204).end();
    }),
  );

  router.get(
    "/catalogue",
    asyncRoute(async (request, response) => {
      const query = z
        .object({
          releaseId: z.string().min(1),
          kind: z.enum(catalogueItemKinds),
          q: z.string().max(200).default(""),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query);
      response.json({
        items: await searchCatalogue(
          database,
          query.releaseId,
          query.kind,
          query.q,
          query.limit,
        ),
      });
    }),
  );

  router.post(
    "/catalogue/team",
    asyncRoute(async (request, response) => {
      const item = await createTeamCatalogueItem(
        database,
        actorContextFromRequest(request),
        request.body,
      );
      response.status(201).json({ item });
    }),
  );

  router.post(
    "/catalogue/:itemId/revisions",
    asyncRoute(async (request, response) => {
      const item = await reviseCatalogueItem(
        database,
        actorContextFromRequest(request),
        routeParam(request, "itemId"),
        request.body,
      );
      response.status(201).json({ item });
    }),
  );

  router.get(
    "/catalogue/:itemId",
    asyncRoute(async (request, response) => {
      const query = z
        .object({ releaseId: z.string().min(1) })
        .parse(request.query);
      const item = await getCatalogueItem(
        database,
        query.releaseId,
        routeParam(request, "itemId"),
      );
      if (!item) {
        throw new Error("catalogue-item-not-found");
      }
      response.json({ item });
    }),
  );

  return router;
}
