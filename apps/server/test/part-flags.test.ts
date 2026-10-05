import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpTestContext, getTeamWorkspace, mutation, createAndLogin, type HttpTestContext } from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";
import { updateNode } from "../src/services/project-node-service";

describe("part flag input validation", () => {
  it("rejects unknown statuses and oversized comments before writing", async () => {
    const database = {} as Parameters<typeof updateNode>[0];
    const actor = {} as Parameters<typeof updateNode>[1];
    await expect(updateNode(database, actor, "part", { expectedVersion: 0, workStatus: "invalid" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(updateNode(database, actor, "part", { expectedVersion: 0, flagComment: "x".repeat(2001) })).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe.skipIf(!hasPostgresTestDatabase())("shared part flag persistence", () => {
  let context: HttpTestContext;
  let projectId: string;
  beforeAll(async () => {
    context = await createHttpTestContext();
    projectId = (await getTeamWorkspace(context)).id;
  }, 120000);
  afterAll(async () => { await context?.close(); });

  it("persists status and comments, audits edits, rejects stale versions, and clears the flag", async () => {
    const detail = (await context.adminAgent.get(`/api/projects/${projectId}`)).body;
    const system = detail.flatNodes.find((node: { kind: string }) => node.kind === "system");
    const assembly = (await mutation(context.adminAgent.post(`/api/nodes/${system.id}/children`), context.adminCsrfToken)
      .send({ expectedParentVersion: system.version, kind: "assembly", name: "Flag test" }).expect(201)).body.node;
    const node = (await mutation(context.adminAgent.post(`/api/nodes/${assembly.id}/children`), context.adminCsrfToken)
      .send({ expectedParentVersion: assembly.version, kind: "part", name: "Flagged part" }).expect(201)).body.node;
    expect(node.work_status).toBe("none");
    expect(node.flag_comment).toBe("");
    const patch = (body: Record<string, unknown>) => mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken).send(body);
    const flagged = (await patch({ expectedVersion: node.version, workStatus: "needs-attention", flagComment: " Check drawing " }).expect(200)).body.node;
    expect(flagged.flag_comment).toBe("Check drawing");
    const persisted = (await context.adminAgent.get(`/api/projects/${projectId}`)).body.flatNodes.find((item: { id: string }) => item.id === node.id);
    expect(persisted).toMatchObject({ work_status: "needs-attention", flag_comment: "Check drawing" });
    await patch({ expectedVersion: node.version, workStatus: "done" }).expect(409);
    const done = (await patch({ expectedVersion: flagged.version, workStatus: "done" }).expect(200)).body.node;
    expect(done).toMatchObject({ work_status: "done", flag_comment: "Check drawing" });
    const cleared = (await patch({ expectedVersion: done.version, workStatus: "none", flagComment: "" }).expect(200)).body.node;
    expect(cleared).toMatchObject({ work_status: "none", flag_comment: "" });
    await patch({ expectedVersion: cleared.version, workStatus: "invalid" }).expect(400);
    await patch({ expectedVersion: cleared.version, flagComment: "x".repeat(2001) }).expect(400);
    await mutation(context.adminAgent.patch(`/api/nodes/${assembly.id}`), context.adminCsrfToken)
      .send({ expectedVersion: assembly.version + 1, workStatus: "done" }).expect(400);
    const audits = await context.database.query("SELECT before_json, after_json FROM audit_ledger WHERE entity_id = $1 AND action = 'cost-node.updated'", [node.id]);
    expect(audits.rows.some(row => row.after_json.workStatus === "needs-attention" && row.after_json.flagComment === "Check drawing")).toBe(true);

    const viewer = await createAndLogin(context, { email: "flag-viewer@example.test", displayName: "Flag viewer", role: "viewer" });
    await mutation(viewer.agent.patch(`/api/nodes/${node.id}`), viewer.csrfToken)
      .send({ expectedVersion: cleared.version, workStatus: "done" }).expect(403);
  });
});
