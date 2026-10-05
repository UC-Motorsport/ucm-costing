import { calculateCostLine } from "@ucm/domain";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import {
  createHttpTestContext,
  mutation,
  type HttpTestContext,
} from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";
import {
  deleteCostLines,
  reorderCostLines,
} from "../src/services/cost-line-service";

describe.skipIf(!hasPostgresTestDatabase())("cost line batches", () => {
  let context: HttpTestContext;
  let nodeId: string;
  let projectId: string;
  let ids: string[];
  beforeAll(async () => {
    context = await createHttpTestContext();
  });
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(async () => {
    const system = await context.database.one<{
      id: string;
      project_id: string;
    }>("SELECT id,project_id FROM cost_nodes WHERE kind='system' LIMIT 1");
    projectId = system.project_id;
    nodeId = randomUUID();
    ids = [randomUUID(), randomUUID(), randomUUID()];
    await context.database.query(
      "INSERT INTO cost_nodes(id,project_id,parent_id,kind,system_code,name,quantity) VALUES($1,$2,$3,'assembly','CH','Batch test',4)",
      [nodeId, projectId, system.id],
    );
    for (const [index, id] of ids.entries())
      await context.database.query(
        "INSERT INTO cost_lines(id,node_id,kind,description,use_description,unit_cost,quantity,multiplier,fraction_included,size_inputs_json,calculation_json,subtotal,sort_order) VALUES($1,$2,'process',$3,'',10,1,1,1,'{}',$5::jsonb,10,$4)",
        [
          id,
          nodeId,
          `Step ${index + 1}`,
          index,
          JSON.stringify(
            calculateCostLine({
              kind: "process",
              unitCost: "10",
              quantity: "1",
            }),
          ),
        ],
      );
  });
  const selection = (values = ids, version = 0) =>
    values.map((id) => ({ id, expectedVersion: version }));
  const reorder = (lines = selection([...ids].reverse())) =>
    mutation(
      context.adminAgent.patch(`/api/nodes/${nodeId}/cost-lines/order`),
      context.adminCsrfToken,
    ).send({ kind: "process", lines });
  const remove = (lines = selection()) =>
    mutation(
      context.adminAgent.post(`/api/nodes/${nodeId}/cost-lines/delete-batch`),
      context.adminCsrfToken,
    ).send({ lines });
  const rows = async () =>
    (
      await context.database.query<{
        id: string;
        version: number;
        subtotal: string;
      }>(
        "SELECT id,version,subtotal::text FROM cost_lines WHERE node_id=$1 ORDER BY sort_order",
        [nodeId],
      )
    ).rows;
  it("persists order, preserves costs, and rejects stale concurrent moves", async () => {
    const responses = await Promise.all([
      reorder(),
      reorder(selection([ids[1]!, ids[0]!, ids[2]!])),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(
      (await rows()).every(
        (row) => Number(row.subtotal) === 10 && row.version === 1,
      ),
    ).toBe(true);
    const detail = await context.adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(200);
    expect(
      detail.body.flatNodes
        .find((n: { id: string }) => n.id === nodeId)
        .costLines.map((l: { id: string }) => l.id),
    ).toEqual((await rows()).map((l) => l.id));
    await reorder(selection(ids, 1)).expect(204);
    expect((await rows()).map((l) => l.id)).toEqual(ids);
  });
  it("rejects incomplete, duplicate, and foreign order lists", async () => {
    await reorder(selection(ids.slice(0, 2))).expect(400);
    await reorder(selection([ids[0]!, ids[0]!, ids[2]!])).expect(400);
    await reorder(selection([ids[0]!, ids[1]!, randomUUID()])).expect(400);
    expect((await rows()).map((l) => l.id)).toEqual(ids);
  });
  it("deletes selected rows together and audits each deletion", async () => {
    await remove(selection(ids.slice(0, 2))).expect(204);
    expect((await rows()).map((l) => l.id)).toEqual([ids[2]]);
    const audit = await context.database.one<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_ledger WHERE action='cost-line.deleted' AND entity_id=ANY($1::text[])",
      [ids],
    );
    expect(audit.count).toBe(2);
  });
  it("rolls back the whole deletion for a stale or foreign selection", async () => {
    await remove([
      { id: ids[0]!, expectedVersion: 0 },
      { id: ids[1]!, expectedVersion: 1 },
    ]).expect(409);
    await remove(selection([ids[0]!, randomUUID()])).expect(400);
    await remove(selection([ids[0]!, ids[0]!])).expect(400);
    expect(await rows()).toHaveLength(3);
  });
  it("denies viewers and locked projects for both operations", async () => {
    const actor = {
      actorUserId: context.adminUser.id,
      systemRole: "viewer" as const,
      requestId: "batch-test",
      userAgent: null,
      ipAddressHash: null,
    };
    await expect(
      deleteCostLines(context.database, actor, nodeId, { lines: selection() }),
    ).rejects.toThrow("permission-denied");
    await expect(
      reorderCostLines(context.database, actor, nodeId, {
        kind: "process",
        lines: selection(),
      }),
    ).rejects.toThrow("permission-denied");
    for (const column of ["is_historical", "status"]) {
      await context.database.query(
        `UPDATE projects SET ${column}=$1 WHERE id=$2`,
        [column === "status" ? "submitted" : true, projectId],
      );
      try {
        await remove().expect(409);
        await reorder().expect(409);
      } finally {
        await context.database.query(
          `UPDATE projects SET ${column}=$1 WHERE id=$2`,
          [column === "status" ? "draft" : false, projectId],
        );
      }
    }
  });
});
