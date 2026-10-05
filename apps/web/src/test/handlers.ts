import { http, HttpResponse } from "msw"

import {
  adminUserFixture,
  authSessionFixture,
  catalogueItemFixture,
  editorUserFixture,
  evidenceFixture,
  importPreviewFixture,
  metaFixture,
  projectDetailFixture,
  reportFixture,
  validationFixture,
} from "@/test/fixtures"

const apiUrl = (path: string) => new URL(path, "http://localhost").toString()

export const defaultHandlers = [
  http.get(apiUrl("/api/auth/me"), () =>
    HttpResponse.json(authSessionFixture),
  ),
  http.post(apiUrl("/api/auth/logout"), () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.get(apiUrl("/api/meta"), () => HttpResponse.json(metaFixture)),
  http.get(apiUrl("/api/projects"), () =>
    HttpResponse.json({ projects: [projectDetailFixture.project] }),
  ),
  http.get(apiUrl("/api/projects/:projectId"), () =>
    HttpResponse.json(projectDetailFixture),
  ),
  http.get(
    apiUrl("/api/projects/:projectId/validation"),
    () => HttpResponse.json(validationFixture),
  ),
  http.get(apiUrl("/api/projects/:projectId/activity"), () =>
    HttpResponse.json({ entries: [], nextCursor: null }),
  ),
  http.get(apiUrl("/api/users"), () =>
    HttpResponse.json({
      users: [adminUserFixture, editorUserFixture],
    }),
  ),
  http.get(apiUrl("/api/catalogue"), () =>
    HttpResponse.json({ items: [catalogueItemFixture] }),
  ),
  http.get(apiUrl("/api/catalogue/:itemId"), ({ params }) => {
    if (params.itemId !== catalogueItemFixture.id) {
      return HttpResponse.json(
        {
          error: {
            code: "not-found",
            message: "Catalogue item not found",
          },
        },
        { status: 404 },
      )
    }
    return HttpResponse.json({ item: catalogueItemFixture })
  }),
  http.get(apiUrl("/api/projects/:projectId/evidence"), () =>
    HttpResponse.json({ evidence: [evidenceFixture] }),
  ),
  http.get(apiUrl("/api/projects/:projectId/reports"), () =>
    HttpResponse.json({ reports: [reportFixture] }),
  ),
  http.get(apiUrl("/api/projects/:projectId/artifacts"), () =>
    HttpResponse.json({ artifacts: [] }),
  ),
  http.get(apiUrl("/api/projects/:projectId/cairs"), () =>
    HttpResponse.json({ cairs: [] }),
  ),
  http.get(apiUrl("/api/projects/:projectId/cost-amendments"), () =>
    HttpResponse.json({ amendments: [] }),
  ),
  http.get(apiUrl("/api/projects/:projectId/submissions"), () =>
    HttpResponse.json({ submissions: [] }),
  ),
  http.post(
    apiUrl("/api/projects/:projectId/imports/preview"),
    () => HttpResponse.json(importPreviewFixture, { status: 201 }),
  ),
  http.get(apiUrl("/api/projects/:projectId/imports"), () =>
    HttpResponse.json({ batches: [], nextCursor: null }),
  ),
  http.get(apiUrl("/api/imports/:batchId"), () =>
    HttpResponse.json(importPreviewFixture),
  ),
  http.delete(apiUrl("/api/imports/:batchId"), () =>
    HttpResponse.json({
      ...importPreviewFixture,
      status: "cancelled",
      version: importPreviewFixture.version + 1,
      cancelledAt: "2026-07-30T00:01:00.000Z",
    }),
  ),
  http.post(apiUrl("/api/imports/:batchId/commit"), () =>
    HttpResponse.json({
      batchId: importPreviewFixture.id,
      status: "committed",
      version: importPreviewFixture.version + 1,
      insertedNodes: 1,
      skippedRows: 0,
      alreadyCommitted: false,
      committedAt: "2026-07-30T00:01:00.000Z",
    }),
  ),
]
