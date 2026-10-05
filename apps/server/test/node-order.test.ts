import { calculateCostLine } from "@ucm/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHttpTestContext,
  mutation,
  type HttpTestContext,
} from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";
import { reorderNodeChildren } from "../src/services/node-order-service";

describe.skipIf(!hasPostgresTestDatabase())("child ordering", () => {
  let context: HttpTestContext;
  let projectId: string;
  let parentId: string;
  let ids: string[];
  let grandchildId: string;
  beforeAll(async () => {
    context = await createHttpTestContext();
    projectId = (
      await context.database.one<{ id: string }>(
        "SELECT id FROM projects WHERE is_historical = false LIMIT 1",
      )
    ).id;
  });
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(async () => {
    parentId = randomUUID();
    ids = [randomUUID(), randomUUID(), randomUUID()];
    grandchildId = randomUUID();
    const system = await context.database.one<{ id: string }>(
      "SELECT id FROM cost_nodes WHERE project_id = $1 AND kind = 'system' LIMIT 1",
      [projectId],
    );
    for (const [id, parent, kind, name, sort] of [
      [parentId, system.id, "assembly", "Chassis", 0],
      [ids[0], parentId, "part", "Panel", 0],
      [ids[1], parentId, "subassembly", "Mounts", 1],
      [ids[2], parentId, "part", "Floor", 2],
      [grandchildId, ids[1], "part", "Bracket", 0],
    ]) {
      await context.database.query(
        `INSERT INTO cost_nodes(id,project_id,parent_id,kind,system_code,name,description,quantity,internal_note,sort_order) VALUES($1,$2,$3,$4,'CH',$5,'',1,'',$6)`,
        [id, projectId, parent, kind, name, sort],
      );
    }
    await context.database.query(
      `INSERT INTO cost_lines(id,node_id,kind,description,use_description,unit_cost,quantity,multiplier,fraction_included,size_inputs_json,calculation_json,subtotal,sort_order) VALUES($1,$2,'material','Plate','',7,1,1,1,'{}',$3,7,0)`,
      [
        randomUUID(),
        ids[2],
        JSON.stringify(
          calculateCostLine({
            kind: "material",
            unitCost: "7",
            quantity: "1",
            multiplier: "1",
            fractionIncluded: "1",
          }),
        ),
      ],
    );
  });
  const patch = (childIds: string[], version = 0) =>
    mutation(
      context.adminAgent.patch(`/api/nodes/${parentId}/children/order`),
      context.adminCsrfToken,
    ).send({ childIds, expectedParentVersion: version });
  const order = async () =>
    (
      await context.database.query<{ id: string }>(
        "SELECT id FROM cost_nodes WHERE parent_id = $1 ORDER BY sort_order, lower(name), id",
        [parentId],
      )
    ).rows.map((row) => row.id);

  it("persists order in project trees while preserving child data, costs and descendants", async () => {
    const before = await context.database.query(
      "SELECT id,parent_id,kind,full_number,name,quantity FROM cost_nodes WHERE id = ANY($1::text[]) ORDER BY id",
      [[...ids, grandchildId]],
    );
    const wanted = [ids[2]!, ids[0]!, ids[1]!];
    const saved = await patch(wanted).expect(200);
    expect(saved.body).toEqual({ parentVersion: 1, childIds: wanted });
    const project = await context.adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(200);
    const parent = project.body.flatNodes.find(
      (node: { id: string }) => node.id === parentId,
    );
    expect(parent.children.map((child: { id: string }) => child.id)).toEqual(
      wanted,
    );
    expect(parent.children[0].costLines[0].subtotal).toBe("7");
    expect(parent.children[2].children[0].id).toBe(grandchildId);
    const after = await context.database.query(
      "SELECT id,parent_id,kind,full_number,name,quantity FROM cost_nodes WHERE id = ANY($1::text[]) ORDER BY id",
      [[...ids, grandchildId]],
    );
    expect(after.rows).toEqual(before.rows);
    const audit = await context.database.one<{
      after_json: { childIds: string[] };
    }>(
      "SELECT after_json FROM audit_ledger WHERE entity_id = $1 AND action = 'cost-node.children-reordered'",
      [parentId],
    );
    expect(audit.after_json.childIds).toEqual(wanted);
    await patch(wanted, 1)
      .expect(200)
      .expect(({ body }) => expect(body.parentVersion).toBe(1));
    await patch(ids, 1).expect(200);
    expect(await order()).toEqual(ids);
  });

  it("rejects incomplete, foreign and duplicate child lists without changing order", async () => {
    await patch([ids[0]!]).expect(400);
    await patch([ids[0]!, ids[1]!, grandchildId]).expect(400);
    await patch([ids[0]!, ids[0]!, ids[2]!]).expect(400);
    expect(await order()).toEqual(ids);
  });

  it("accepts only one of two simultaneous edits based on the same parent version", async () => {
    const results = await Promise.all([
      patch([...ids].reverse()),
      patch([ids[1]!, ids[0]!, ids[2]!]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    expect(await order()).toEqual(winner.body.childIds);
  });

  it("rejects viewers, submitted and historical projects", async () => {
    const actor = {
      actorUserId: context.adminUser.id,
      systemRole: "viewer" as const,
      requestId: "reorder-test",
      userAgent: null,
      ipAddressHash: null,
    };
    await expect(
      reorderNodeChildren(context.database, actor, parentId, {
        childIds: [...ids].reverse(),
        expectedParentVersion: 0,
      }),
    ).rejects.toThrow("permission-denied");
    await context.database.query(
      "UPDATE projects SET status = 'submitted' WHERE id = $1",
      [projectId],
    );
    try {
      await patch([...ids].reverse()).expect(409);
    } finally {
      await context.database.query(
        "UPDATE projects SET status = 'draft' WHERE id = $1",
        [projectId],
      );
    }
    await context.database.query(
      "UPDATE projects SET is_historical = true WHERE id = $1",
      [projectId],
    );
    try {
      await patch([...ids].reverse()).expect(409);
    } finally {
      await context.database.query(
        "UPDATE projects SET is_historical = false WHERE id = $1",
        [projectId],
      );
    }
    expect(await order()).toEqual(ids);
  });
});
