import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { getAppPaths } from "../../src/config";
import {
  createHttpTestContext,
  getTeamWorkspace,
  mutation,
  type HttpTestContext,
} from "../helpers/http-app";
import { hasPostgresTestDatabase } from "../helpers/postgres";

describe
  .skipIf(!hasPostgresTestDatabase())
  .sequential("2025 legacy master import rehearsal", () => {
  let context: HttpTestContext;
  let projectId: string;

  beforeAll(async () => {
    context = await createHttpTestContext({ enableLegacyImports: true });
    projectId = (await getTeamWorkspace(context, {
      name: "Isolated 2025 import rehearsal",
      season: 2025,
    })).id;
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("commits every valid 2025 hierarchy record without touching the live workspace", async () => {
    const csv = await readFile(
      path.join(
        getAppPaths().repositoryRoot,
        "apps/server/test/fixtures/legacy-master.csv",
      ),
    );
    const preview = await mutation(
      context.adminAgent.post(
        `/api/projects/${projectId}/imports/preview`,
      ),
      context.adminCsrfToken,
    )
      .attach("file", csv, {
        filename: "2025-master-parts.csv",
        contentType: "text/csv",
      })
      .expect(201);

    expect(preview.body.preview.stats).toMatchObject({
      apparentRecordCount: 9,
      assemblyRecordCount: 3,
      componentRecordCount: 6,
    });

    const committed = await mutation(
      context.adminAgent.post(`/api/imports/${preview.body.id}/commit`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: preview.body.version,
        commitValidOnly: true,
        idempotencyKey: "isolated-2025-master-rehearsal",
      })
      .expect(200);

    expect(committed.body).toMatchObject({
      status: "committed",
      alreadyCommitted: false,
    });
    expect(committed.body.insertedNodes).toBeGreaterThan(5);
    expect(committed.body.skippedRows).toBeGreaterThan(0);
    expect(
      committed.body.insertedNodes + committed.body.skippedRows,
    ).toBe(9);

    const workspace = await context.adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(200);
    const imported = workspace.body.flatNodes.filter(
      (node: { source_import_batch_id: string | null }) =>
        node.source_import_batch_id === preview.body.id,
    );
    expect(imported).toHaveLength(committed.body.insertedNodes);
    expect(
      imported.filter(
        (node: { kind: string }) =>
          node.kind === "assembly" || node.kind === "subassembly",
      ).length,
    ).toBeGreaterThan(1);
    expect(
      imported.filter((node: { kind: string }) => node.kind === "part")
        .length,
    ).toBeGreaterThan(2);
  }, 120_000);
});
