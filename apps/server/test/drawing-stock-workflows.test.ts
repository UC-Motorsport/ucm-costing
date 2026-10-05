import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpTestContext, getTeamWorkspace, mutation, type HttpTestContext } from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";
import { resolveCatalogueUnitCost } from "../src/services/catalogue-service";

describe.skipIf(!hasPostgresTestDatabase())("drawing and stock persistence", () => {
  let context: HttpTestContext;
  let projectId: string;
  beforeAll(async () => {
    context = await createHttpTestContext();
    projectId = (await getTeamWorkspace(context)).id;
  }, 120000);
  afterAll(async () => { await context?.close(); });

  it("persists a reversible version-checked drawing exception with an audit entry", async () => {
    const detail = (await context.adminAgent.get(`/api/projects/${projectId}`)).body;
    const system = detail.flatNodes.find((node: { kind: string }) => node.kind === "system");
    const created = await mutation(context.adminAgent.post(`/api/nodes/${system.id}/children`), context.adminCsrfToken)
      .send({ expectedParentVersion: system.version, kind: "assembly", name: "Drawing exception test" }).expect(201);
    const node = created.body.node;
    expect(node.drawing_required).toBe(true);
    const waived = await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: node.version, drawingRequired: false }).expect(200);
    expect(waived.body.node.drawing_required).toBe(false);
    const persisted = (await context.adminAgent.get(`/api/projects/${projectId}`)).body.flatNodes.find((item: { id: string }) => item.id === node.id);
    expect(persisted.drawing_required).toBe(false);
    await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: node.version, drawingRequired: true }).expect(409);
    const restored = await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: waived.body.node.version, drawingRequired: true }).expect(200);
    expect(restored.body.node.drawing_required).toBe(true);
    const audits = await context.database.query("SELECT after_json FROM audit_ledger WHERE entity_id = $1 AND action = 'cost-node.updated'", [node.id]);
    expect(audits.rows.some((row) => row.after_json.drawingRequired === false)).toBe(true);
  });

  it("persists and audits a reversible image exemption, requiring a reason", async () => {
    const detail = (await context.adminAgent.get(`/api/projects/${projectId}`)).body;
    const system = detail.flatNodes.find((node: { kind: string }) => node.kind === "system");
    const created = await mutation(context.adminAgent.post(`/api/nodes/${system.id}/children`), context.adminCsrfToken)
      .send({ expectedParentVersion: system.version, kind: "assembly", name: "Image exemption" }).expect(201);
    const node = created.body.node;
    expect(node.image_required).toBe(true);
    await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: node.version, imageRequired: false }).expect(400);
    const waived = await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: node.version, imageRequired: false, imageRequirementReason: "Standard bought component" }).expect(200);
    expect(waived.body.node).toMatchObject({ image_required: false, image_requirement_reason: "Standard bought component", drawing_required: true });
    const persisted = (await context.adminAgent.get(`/api/projects/${projectId}`)).body.flatNodes.find((item: { id: string }) => item.id === node.id);
    expect(persisted.image_required).toBe(false);
    await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: node.version, imageRequired: true }).expect(409);
    const restored = await mutation(context.adminAgent.patch(`/api/nodes/${node.id}`), context.adminCsrfToken)
      .send({ expectedVersion: waived.body.node.version, imageRequired: true, imageRequirementReason: "" }).expect(200);
    expect(restored.body.node.image_required).toBe(true);
    const audits = await context.database.query("SELECT after_json FROM audit_ledger WHERE entity_id = $1 AND action = 'cost-node.updated'", [node.id]);
    expect(audits.rows.some((row) => row.after_json.imageRequired === false && row.after_json.imageRequirementReason === "Standard bought component")).toBe(true);
  });

  it("pairs stock dimensions with a material price and rejects invalid stock references", async () => {
    const release = (await context.database.one<{catalogue_release_id: string}>("SELECT catalogue_release_id FROM projects WHERE id = $1", [projectId])).catalogue_release_id;
    const stock = await context.database.one<{id: string}>("SELECT id FROM catalogue_items WHERE release_id = $1 AND kind = 'stock-size' LIMIT 1", [release]);
    const material = await context.database.one<{id: string; fixed_cost: string}>("SELECT id, fixed_cost::text FROM catalogue_items WHERE release_id = $1 AND kind = 'material' AND fixed_cost > 0 LIMIT 1", [release]);
    const cost = await resolveCatalogueUnitCost(context.database, release, { kind: "material", catalogueItemId: material.id, sizeInputs: { stockSizeCatalogueItemId: stock.id } });
    expect(cost).toBe(material.fixed_cost);
    await expect(resolveCatalogueUnitCost(context.database, release, { kind: "material", catalogueItemId: material.id, sizeInputs: { stockSizeCatalogueItemId: material.id } })).rejects.toThrow("catalogue-kind-mismatch");
    await expect(resolveCatalogueUnitCost(context.database, release, { kind: "process", catalogueItemId: material.id, sizeInputs: { stockSizeCatalogueItemId: stock.id } })).rejects.toThrow("catalogue-kind-mismatch");
    await expect(resolveCatalogueUnitCost(context.database, "different-release", { kind: "material", catalogueItemId: material.id, sizeInputs: { stockSizeCatalogueItemId: stock.id } })).rejects.toThrow("catalogue-kind-mismatch");
  });
});
