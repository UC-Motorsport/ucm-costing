import { access } from "node:fs/promises";

import Decimal from "decimal.js";
import { calculateNodeRollup } from "@ucm/domain";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { resolveStoredDataPath } from "../src/config";
import {
  createHttpTestContext,
  getTeamWorkspace,
  mutation,
  type HttpTestContext,
} from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";

type CostKind = "material" | "process" | "fastener" | "tooling";

interface ApiNode {
  id: string;
  parent_id: string | null;
  kind: string;
  system_code: string | null;
  full_number: string | null;
  quantity: string;
  sort_order: number;
  version: number;
  breakdown: {
    material: string;
    process: string;
    fastener: string;
    tooling: string;
    total: string;
  };
  costLines: ApiCostLine[];
  children: ApiNode[];
}

interface ApiCostLine {
  id: string;
  kind: CostKind;
  catalogue_item_id: string | null;
  catalogue_unit: string | null;
  catalogue_unit_2: string | null;
  description: string;
  use_description: string;
  unit_cost: string;
  quantity: string;
  multiplier: string;
  multiplier_catalogue_item_id: string | null;
  fraction_included: string;
  production_volume_factor: string | null;
  sort_order: number;
  subtotal: string;
  version: number;
}

interface CatalogueItem {
  id: string;
  kind: CostKind | "multiplier";
  name: string;
  fixed_cost: string;
  unit: string | null;
}

describe
  .skipIf(!hasPostgresTestDatabase())
  .sequential("authenticated PostgreSQL hierarchy authoring", () => {
  let context: HttpTestContext;
  let projectId: string;

  beforeAll(async () => {
    context = await createHttpTestContext();
    projectId = (await getTeamWorkspace(context, {
      name: "Hierarchy Production Vehicle",
      entryNumber: "E15",
    })).id;
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("authors, costs, edits, persists, and safely removes a complete branch", async () => {
    const initial = await projectDetail();
    expect(initial.breakdown.total).toBe("0");
    const brakes = initial.flatNodes.find(
      (node) => node.kind === "system" && node.system_code === "BR",
    );
    expect(brakes).toBeTruthy();
    const initialLastSort = Math.max(
      -1,
      ...brakes!.children.map((child) => child.sort_order),
    );

    const assemblyNumber = "E15-26-BR-990000-Z";
    const createdAssembly = await mutation(
      context.adminAgent.post(`/api/nodes/${brakes!.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: brakes!.version,
        kind: "assembly",
        name: "Production hierarchy assembly",
        description: "Audited hierarchy verification branch",
        quantity: "1",
        fullNumber: assemblyNumber,
        referenceId: "990000",
        revision: "Z",
        procurementType: "made",
        internalNote: "Integration verification branch",
      })
      .expect(201);
    const assembly = createdAssembly.body.node as ApiNode;
    expect(assembly).toMatchObject({
      parent_id: brakes!.id,
      kind: "assembly",
      system_code: "BR",
      full_number: assemblyNumber,
      quantity: "1",
      sort_order: initialLastSort + 1,
      version: 0,
    });

    const staleCreate = await mutation(
      context.adminAgent.post(`/api/nodes/${brakes!.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: brakes!.version,
        kind: "assembly",
        name: "Stale assembly",
        quantity: "1",
      })
      .expect(409);
    expect(staleCreate.body.error.code).toBe("version-conflict");

    const afterAssembly = await projectDetail();
    const currentBrakes = afterAssembly.flatNodes.find(
      (node) => node.id === brakes!.id,
    )!;
    const invalidRollupQuantity = await mutation(
      context.adminAgent.patch(`/api/nodes/${currentBrakes.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: currentBrakes.version,
        quantity: "2",
      })
      .expect(400);
    expect(invalidRollupQuantity.body.error.code).toBe(
      "rollup-field-not-allowed",
    );

    const invalidPart = await mutation(
      context.adminAgent.post(
        `/api/nodes/${currentBrakes.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: currentBrakes.version,
        kind: "part",
        name: "Invalid direct system part",
        quantity: "1",
      })
      .expect(400);
    expect(invalidPart.body.error.code).toBe("invalid-node-hierarchy");

    const duplicateNumber = await mutation(
      context.adminAgent.post(
        `/api/nodes/${currentBrakes.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: currentBrakes.version,
        kind: "assembly",
        name: "Duplicate number",
        quantity: "1",
        fullNumber: assemblyNumber.toLowerCase(),
      })
      .expect(409);
    expect(duplicateNumber.body.error.code).toBe(
      "node-full-number-conflict",
    );

    const protectedVehicleDelete = await mutation(
      context.adminAgent.delete(`/api/nodes/${afterAssembly.tree.id}`),
      context.adminCsrfToken,
    )
      .query({
        expectedVersion: afterAssembly.tree.version,
        cascade: true,
      })
      .expect(409);
    expect(protectedVehicleDelete.body.error.code).toBe(
      "vehicle-root-protected",
    );

    const miscellaneous = afterAssembly.flatNodes.find(
      (node) => node.kind === "system" && node.system_code === "MS",
    )!;
    await mutation(
      context.adminAgent.delete(`/api/nodes/${miscellaneous.id}`),
      context.adminCsrfToken,
    )
      .query({
        expectedVersion: miscellaneous.version,
        cascade: true,
      })
      .expect(204);
    const withoutMiscellaneous = await projectDetail();
    expect(
      withoutMiscellaneous.flatNodes.some(
        (node) => node.system_code === "MS",
      ),
    ).toBe(false);
    const renamedDefault = await mutation(
      context.adminAgent.post(
        `/api/nodes/${withoutMiscellaneous.tree.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: withoutMiscellaneous.tree.version,
        kind: "system",
        systemCode: "MS",
        name: "Made Up",
        description: "Invalid reserved system name.",
      })
      .expect(400);
    expect(renamedDefault.body.error.code).toBe(
      "system-name-not-allowed",
    );
    const recreatedMiscellaneous = await mutation(
      context.adminAgent.post(
        `/api/nodes/${withoutMiscellaneous.tree.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: withoutMiscellaneous.tree.version,
        kind: "system",
        systemCode: "MS",
        name: "Miscellaneous",
        description: "Miscellaneous system.",
      })
      .expect(201);
    expect(recreatedMiscellaneous.body.node).toMatchObject({
      parent_id: withoutMiscellaneous.tree.id,
      kind: "system",
      system_code: "MS",
      name: "Miscellaneous",
    });

    const withMiscellaneous = await projectDetail();
    const createdCustomSystem = await mutation(
      context.adminAgent.post(
        `/api/nodes/${withMiscellaneous.tree.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: withMiscellaneous.tree.version,
        kind: "system",
        systemCode: "CO",
        name: "Cooling",
        description: "Cooling system.",
      })
      .expect(201);
    expect(createdCustomSystem.body.node).toMatchObject({
      parent_id: withMiscellaneous.tree.id,
      kind: "system",
      system_code: "CO",
      name: "Cooling",
    });

    const withCustomSystem = await projectDetail();
    const customSystem = withCustomSystem.flatNodes.find(
      (node) => node.kind === "system" && node.system_code === "CO",
    )!;
    expect(customSystem).toBeTruthy();
    await mutation(
      context.adminAgent.delete(`/api/nodes/${customSystem.id}`),
      context.adminCsrfToken,
    )
      .query({
        expectedVersion: customSystem.version,
        cascade: true,
      })
      .expect(204);

    const createdSubassembly = await mutation(
      context.adminAgent.post(`/api/nodes/${assembly.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: assembly.version,
        kind: "subassembly",
        name: "Production nested subassembly",
        quantity: "2",
        fullNumber: "E15-26-BR-990100-Z",
        referenceId: "990100",
        procurementType: "made",
      })
      .expect(201);
    const subassembly = createdSubassembly.body.node as ApiNode;
    expect(subassembly).toMatchObject({
      parent_id: assembly.id,
      kind: "subassembly",
      system_code: "BR",
      quantity: "2",
    });

    const createdPart = await mutation(
      context.adminAgent.post(
        `/api/nodes/${subassembly.id}/children`,
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: subassembly.version,
        kind: "part",
        name: "Catalogue-costed production part",
        quantity: "3",
        fullNumber: "E15-26-BR-990101-Z",
        referenceId: "990101",
        procurementType: "bought",
      })
      .expect(201);
    const part = createdPart.body.node as ApiNode;
    expect(part).toMatchObject({
      parent_id: subassembly.id,
      kind: "part",
      system_code: "BR",
      quantity: "3",
    });

    const afterPart = await projectDetail();
    const subassemblyAfterPart = afterPart.flatNodes.find(
      (node) => node.id === subassembly.id,
    )!;
    const createdNestedSubassembly = await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: subassemblyAfterPart.version,
        kind: "subassembly",
        name: "Nested hierarchy move guard",
        quantity: "1",
        fullNumber: "E15-26-BR-990200-Z",
        referenceId: "990200",
        procurementType: "made",
      })
      .expect(201);
    const nestedSubassembly = createdNestedSubassembly.body.node as ApiNode;

    const updatedPart = await mutation(
      context.adminAgent.patch(`/api/nodes/${part.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: part.version,
        name: "Reviewed catalogue-costed production part",
        description: "Reviewed report description",
        quantity: "4",
        referenceId: "990101",
        internalNote: "Reviewed internal note",
      })
      .expect(200);
    expect(updatedPart.body.node).toMatchObject({
      name: "Reviewed catalogue-costed production part",
      quantity: "4",
      reference_id: "990101",
      internal_note: "Reviewed internal note",
      version: part.version + 1,
    });
    const staleUpdate = await mutation(
      context.adminAgent.patch(`/api/nodes/${part.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: part.version,
        name: "Stale overwrite",
      })
      .expect(409);
    expect(staleUpdate.body.error.code).toBe("version-conflict");

    const material = await fixedCatalogueItem("material");
    const process = await fixedCatalogueItem("process");
    const fastener = await fixedCatalogueItem("fastener");
    const tooling = await fixedCatalogueItem("tooling");
    const multiplier = await multiplierItem();
    const exactCatalogue = await context.adminAgent
      .get(`/api/catalogue/${material.id}`)
      .query({
        releaseId: initial.project.catalogue_release_id,
      })
      .expect(200);
    expect(exactCatalogue.body.item).toMatchObject({
      id: material.id,
      name: material.name,
    });

    const systemCost = await mutation(
      context.adminAgent.post(
        `/api/nodes/${currentBrakes.id}/cost-lines`,
      ),
      context.adminCsrfToken,
    )
      .send(lineBody(material, multiplier))
      .expect(400);
    expect(systemCost.body.error.code).toBe(
      "cost-line-owner-not-allowed",
    );

    const implicitTooling = await mutation(
      context.adminAgent.post(`/api/nodes/${part.id}/cost-lines`),
      context.adminCsrfToken,
    )
      .send({
        kind: "tooling",
        catalogueItemId: tooling.id,
        description: tooling.name,
        useDescription: "Implicit tooling inputs must be rejected",
        quantity: "1",
        sizeInputs: {},
      })
      .expect(400);
    expect(implicitTooling.body.error.code).toBe("invalid-request");
    expect(
      implicitTooling.body.error.issues.map(
        (issue: { path: string[] }) => issue.path.join("."),
      ),
    ).toEqual(
      expect.arrayContaining([
        "fractionIncluded",
        "productionVolumeFactor",
      ]),
    );

    const arbitraryToolingFactor = await mutation(
      context.adminAgent.post(`/api/nodes/${part.id}/cost-lines`),
      context.adminCsrfToken,
    )
      .send({
        ...lineBody(tooling, multiplier),
        productionVolumeFactor: "500",
      })
      .expect(400);
    expect(arbitraryToolingFactor.body.error.code).toBe("invalid-request");
    expect(arbitraryToolingFactor.body.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["productionVolumeFactor"] }),
      ]),
    );

    const createdLines: ApiCostLine[] = [];
    for (const item of [material, process, fastener, tooling]) {
      const response = await mutation(
        context.adminAgent.post(`/api/nodes/${part.id}/cost-lines`),
        context.adminCsrfToken,
      )
        .send(lineBody(item, multiplier))
        .expect(201);
      createdLines.push(response.body.line as ApiCostLine);
    }
    const monocoqueTooling = await context.database.one<CatalogueItem>(
      `
        SELECT id, kind, name, fixed_cost::text AS fixed_cost
        FROM catalogue_items
        WHERE release_id = $1 AND kind = 'tooling' AND catalogue_id = '19'
      `,
      [initial.project.catalogue_release_id],
    );
    const monocoqueResponse = await mutation(
      context.adminAgent.post(`/api/nodes/${part.id}/cost-lines`),
      context.adminCsrfToken,
    )
      .send({
        ...lineBody(monocoqueTooling, multiplier),
        sizeInputs: { size1: "3.42" },
        productionVolumeFactor: "120",
      })
      .expect(201);
    expect(monocoqueResponse.body.line).toMatchObject({
      unit_cost: "68400",
      quantity: "1",
      fraction_included: "1",
      production_volume_factor: "120",
      subtotal: "570",
    });
    createdLines.push(monocoqueResponse.body.line as ApiCostLine);
    expect(createdLines.map((line) => line.kind)).toEqual([
      "material",
      "process",
      "fastener",
      "tooling",
      "tooling",
    ]);
    expect(
      createdLines.find((line) => line.kind === "tooling"),
    ).toMatchObject({
      fraction_included: "1",
      production_volume_factor: "3000",
      multiplier_catalogue_item_id: null,
    });

    const afterLines = await projectDetail();
    const costedPart = afterLines.flatNodes.find(
      (node) => node.id === part.id,
    )!;
    expect(
      costedPart.costLines.find((line) => line.kind === "material"),
    ).toMatchObject({
      catalogue_item_id: material.id,
      catalogue_unit: material.unit,
    });
    const exactPartCost = createdLines.reduce(
      (sum, line) => sum.plus(line.subtotal),
      new Decimal(0),
    );
    expect(costedPart.breakdown.total).toBe(exactPartCost.toString());
    const expectedSubassembly = calculateNodeRollup([], [
      {
        quantity: costedPart.quantity,
        breakdown: costedPart.breakdown,
      },
    ]);
    const expectedAssembly = calculateNodeRollup([], [
      {
        quantity: subassembly.quantity,
        breakdown: expectedSubassembly,
      },
    ]);
    const expectedSystem = calculateNodeRollup([], [
      {
        quantity: assembly.quantity,
        breakdown: expectedAssembly,
      },
    ]);
    expect(afterLines.breakdown).toEqual(expectedSystem);

    const laterReleaseId = "hierarchy-catalogue-release-later";
    await context.database.query(
      `
        INSERT INTO catalogue_releases(
          id, competition_year, revision_code, released_on,
          source_document_id
        )
        SELECT $1, competition_year, '26_R2-hierarchy-test',
               DATE '2026-07-31', source_document_id
        FROM catalogue_releases
        WHERE id = $2
      `,
      [laterReleaseId, afterLines.project.catalogue_release_id],
    );
    const releaseChange = await mutation(
      context.adminAgent.patch(`/api/projects/${projectId}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: afterLines.project.version,
        catalogueReleaseId: laterReleaseId,
      })
      .expect(409);
    expect(releaseChange.body.error.code).toBe(
      "project-catalogue-release-in-use",
    );

    await context.database.query(
      "UPDATE projects SET catalogue_release_id = $1 WHERE id = $2",
      [laterReleaseId, projectId],
    );
    try {
      const mismatched = await context.adminAgent
        .get(`/api/projects/${projectId}/validation`)
        .expect(200);
      expect(
        mismatched.body.issues.map(
          (issue: { code: string }) => issue.code,
        ),
      ).toEqual(
        expect.arrayContaining([
          "cost-line-catalogue-release-mismatch",
          "cost-multiplier-catalogue-release-mismatch",
        ]),
      );
      expect(mismatched.body.readyForCompetitionReport).toBe(false);
    } finally {
      await context.database.query(
        "UPDATE projects SET catalogue_release_id = $1 WHERE id = $2",
        [afterLines.project.catalogue_release_id, projectId],
      );
    }

    const materialLine = createdLines.find(
      (line) => line.kind === "material",
    )!;
    const editedMaterial = await mutation(
      context.adminAgent.put(`/api/cost-lines/${materialLine.id}`),
      context.adminCsrfToken,
    )
      .send({
        ...lineBody(material, multiplier, "2"),
        expectedVersion: materialLine.version,
      })
      .expect(200);
    expect(editedMaterial.body.line).toMatchObject({
      quantity: "2",
      version: materialLine.version + 1,
    });
    expect(
      new Decimal(editedMaterial.body.line.subtotal).greaterThan(
        materialLine.subtotal,
      ),
    ).toBe(true);

    const currentPart = (await projectDetail()).flatNodes.find(
      (node) => node.id === part.id,
    )!;
    const dependentDelete = await mutation(
      context.adminAgent.delete(`/api/nodes/${part.id}`),
      context.adminCsrfToken,
    )
      .query({
        expectedVersion: currentPart.version,
        cascade: false,
      })
      .expect(409);
    expect(dependentDelete.body.error.code).toBe(
      "node-has-dependent-data",
    );

    const evidence = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "image")
      .field("nodeId", part.id)
      .field("visibility", "internal")
      .attach("file", png, {
        filename: "cascade-evidence.png",
        contentType: "image/png",
      })
      .expect(201);
    const evidenceRow = await context.database.one<{
      storage_path: string;
    }>(
      "SELECT storage_path FROM evidence WHERE id = $1",
      [evidence.body.evidence.id],
    );
    const evidencePath = resolveStoredDataPath(
      evidenceRow.storage_path,
      context.paths,
    );
    await expect(access(evidencePath)).resolves.toBeUndefined();

    const beforeMove = await projectDetail();
    const movableSubassembly = beforeMove.flatNodes.find(
      (node) => node.id === subassembly.id,
    )!;
    const currentNestedSubassembly = beforeMove.flatNodes.find(
      (node) => node.id === nestedSubassembly.id,
    )!;
    const cycleMove = await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: movableSubassembly.version,
        targetParentId: currentNestedSubassembly.id,
        expectedTargetParentVersion: currentNestedSubassembly.version,
        kind: "subassembly",
      })
      .expect(400);
    expect(cycleMove.body.error.code).toBe("node-move-cycle");

    const crossSystemMove = await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: movableSubassembly.version,
        targetParentId: recreatedMiscellaneous.body.node.id,
        expectedTargetParentVersion: recreatedMiscellaneous.body.node.version,
        kind: "assembly",
      })
      .expect(400);
    expect(crossSystemMove.body.error.code).toBe(
      "node-move-cross-system-not-allowed",
    );

    const currentBrakesForMove = beforeMove.flatNodes.find(
      (node) => node.id === brakes!.id,
    )!;
    const staleMove = await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: subassembly.version,
        targetParentId: currentBrakesForMove.id,
        expectedTargetParentVersion: currentBrakesForMove.version,
        kind: "assembly",
      })
      .expect(409);
    expect(staleMove.body.error.code).toBe("version-conflict");

    await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: movableSubassembly.version,
        targetParentId: currentBrakesForMove.id,
        expectedTargetParentVersion: currentBrakesForMove.version,
        kind: "assembly",
      })
      .expect(200);
    const afterPromotion = await projectDetail();
    const promoted = afterPromotion.flatNodes.find(
      (node) => node.id === subassembly.id,
    )!;
    expect(promoted).toMatchObject({
      parent_id: currentBrakesForMove.id,
      kind: "assembly",
      full_number: subassembly.full_number,
    });
    expect(promoted.children.map((child) => child.id)).toEqual(
      expect.arrayContaining([part.id, nestedSubassembly.id]),
    );
    expect(
      afterPromotion.flatNodes.find((node) => node.id === part.id)!.costLines,
    ).toHaveLength(5);
    expect(
      await context.database.maybeOne(
        "SELECT id FROM evidence WHERE id = $1 AND node_id = $2",
        [evidence.body.evidence.id, part.id],
      ),
    ).not.toBeNull();

    const assemblyAfterPromotion = afterPromotion.flatNodes.find(
      (node) => node.id === assembly.id,
    )!;
    await mutation(
      context.adminAgent.post(`/api/nodes/${subassembly.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: promoted.version,
        targetParentId: assemblyAfterPromotion.id,
        expectedTargetParentVersion: assemblyAfterPromotion.version,
        kind: "subassembly",
      })
      .expect(200);
    const afterDemotion = await projectDetail();
    expect(
      afterDemotion.flatNodes.find((node) => node.id === subassembly.id),
    ).toMatchObject({
      parent_id: assembly.id,
      kind: "subassembly",
      full_number: subassembly.full_number,
    });

    const partBeforeMove = afterDemotion.flatNodes.find(
      (node) => node.id === part.id,
    )!;
    const nestedBeforePartMove = afterDemotion.flatNodes.find(
      (node) => node.id === nestedSubassembly.id,
    )!;
    const assemblyBeforePartMove = afterDemotion.flatNodes.find(
      (node) => node.id === assembly.id,
    )!;
    const partLevelChange = await mutation(
      context.adminAgent.post(`/api/nodes/${part.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: partBeforeMove.version,
        targetParentId: assemblyBeforePartMove.id,
        expectedTargetParentVersion: assemblyBeforePartMove.version,
        kind: "subassembly",
      })
      .expect(400);
    expect(partLevelChange.body.error.code).toBe(
      "node-move-kind-not-allowed",
    );

    await mutation(
      context.adminAgent.post(`/api/nodes/${part.id}/move`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: partBeforeMove.version,
        targetParentId: nestedBeforePartMove.id,
        expectedTargetParentVersion: nestedBeforePartMove.version,
        kind: "part",
      })
      .expect(200);
    const afterPartMove = await projectDetail();
    const movedPart = afterPartMove.flatNodes.find(
      (node) => node.id === part.id,
    )!;
    expect(movedPart).toMatchObject({
      parent_id: nestedSubassembly.id,
      kind: "part",
      full_number: part.full_number,
    });
    expect(movedPart.costLines).toHaveLength(5);
    expect(
      await context.database.maybeOne(
        "SELECT id FROM evidence WHERE id = $1 AND node_id = $2",
        [evidence.body.evidence.id, part.id],
      ),
    ).not.toBeNull();

    const beforeCascade = await projectDetail();
    const currentAssembly = beforeCascade.flatNodes.find(
      (node) => node.id === assembly.id,
    )!;
    await mutation(
      context.adminAgent.delete(`/api/nodes/${assembly.id}`),
      context.adminCsrfToken,
    )
      .query({
        expectedVersion: currentAssembly.version,
        cascade: true,
      })
      .expect(204);

    const finalDetail = await projectDetail();
    expect(
      finalDetail.flatNodes.some((node) => node.id === assembly.id),
    ).toBe(false);
    expect(finalDetail.breakdown.total).toBe("0");
    expect(
      await context.database.maybeOne(
        "SELECT id FROM evidence WHERE id = $1",
        [evidence.body.evidence.id],
      ),
    ).toBeNull();
    await expect(access(evidencePath)).rejects.toThrow();
    expect(
      await context.database.maybeOne(
        "SELECT storage_path FROM evidence_file_cleanup WHERE storage_path = $1",
        [evidenceRow.storage_path],
      ),
    ).toBeNull();

    const activity = await context.adminAgent
      .get(`/api/projects/${projectId}/activity`)
      .expect(200);
    const deletion = activity.body.entries.find(
      (entry: { action: string; entityId: string }) =>
        entry.action === "cost-node.deleted" &&
        entry.entityId === assembly.id,
    );
    expect(deletion.metadata).toMatchObject({
      cascade: true,
      queuedEvidenceFiles: 1,
      deletedNodeIds: expect.arrayContaining([
        assembly.id,
        subassembly.id,
        part.id,
      ]),
    });
  }, 120_000);

  it("persists left/right counterparts and rejects duplicate full identities on create and edit", async () => {
    const system = (await projectDetail()).flatNodes.find(
      (node) => node.kind === "system" && node.system_code === "AD",
    )!;
    const assemblyResponse = await mutation(
      context.adminAgent.post(`/api/nodes/${system.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: system.version,
        kind: "assembly",
        name: "Handedness wing",
        fullNumber: "E15-26-AD-990000-A",
        referenceId: "990000",
        revision: "A",
      })
      .expect(201);
    let parent = assemblyResponse.body.node as ApiNode;
    const created: ApiNode[] = [];
    for (const side of ["L", "R"]) {
      const response = await mutation(
        context.adminAgent.post(`/api/nodes/${parent.id}/children`),
        context.adminCsrfToken,
      )
        .send({
          expectedParentVersion: parent.version,
          kind: "part",
          name: `Endplate ${side}`,
          fullNumber: `E15-26-AD-990001-${side}-A`,
          referenceId: `990001-${side}`,
          revision: "A",
          procurementType: "made",
        })
        .expect(201);
      created.push(response.body.node);
      parent = (await projectDetail()).flatNodes.find(
        (node) => node.id === parent.id,
      )!;
    }
    expect(created[0]!.id).not.toBe(created[1]!.id);
    const reloaded = (await projectDetail()).flatNodes.filter((node) =>
      created.some((part) => part.id === node.id),
    );
    expect(reloaded.map((node) => node.full_number).sort()).toEqual([
      "E15-26-AD-990001-L-A",
      "E15-26-AD-990001-R-A",
    ]);
    for (const node of reloaded) expect(node.costLines).toHaveLength(0);
    await mutation(
      context.adminAgent.post(`/api/nodes/${parent.id}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: parent.version,
        kind: "part",
        name: "Duplicate left",
        fullNumber: "e15-26-ad-990001-l-a",
      })
      .expect(409);
    await mutation(
      context.adminAgent.patch(`/api/nodes/${created[1]!.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: created[1]!.version,
        fullNumber: created[0]!.full_number,
      })
      .expect(409);
    await mutation(
      context.adminAgent.patch(`/api/nodes/${created[1]!.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: created[1]!.version,
        quantity: "2",
        revision: "B",
        fullNumber: "E15-26-AD-990001-R-B",
      })
      .expect(200);
    const unchangedLeft = (await projectDetail()).flatNodes.find(
      (node) => node.id === created[0]!.id,
    )!;
    expect(unchangedLeft.full_number).toBe("E15-26-AD-990001-L-A");
    expect(unchangedLeft.quantity).toBe("1");
  });

  async function projectDetail(): Promise<{
    tree: ApiNode;
    flatNodes: ApiNode[];
    breakdown: ApiNode["breakdown"];
    project: { catalogue_release_id: string; version: number };
  }> {
    const response = await context.adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(200);
    return response.body;
  }

  async function fixedCatalogueItem(
    kind: CostKind,
  ): Promise<CatalogueItem> {
    return await context.database.one<CatalogueItem>(
      `
        SELECT id, kind, name, fixed_cost::text AS fixed_cost, unit
        FROM catalogue_items
        WHERE release_id = $1 AND kind = $2 AND fixed_cost IS NOT NULL
          AND ($2 <> 'material' OR unit IS NOT NULL)
        ORDER BY catalogue_id
        LIMIT 1
      `,
      [(await projectDetail()).project.catalogue_release_id, kind],
    );
  }

  async function multiplierItem(): Promise<CatalogueItem> {
    return await context.database.one<CatalogueItem>(
      `
        SELECT id, kind, name, fixed_cost::text AS fixed_cost
        FROM catalogue_items
        WHERE release_id = $1
          AND kind = 'multiplier'
          AND fixed_cost IS NOT NULL
        ORDER BY CASE WHEN name = 'None' THEN 0 ELSE 1 END, catalogue_id
        LIMIT 1
      `,
      [(await projectDetail()).project.catalogue_release_id],
    );
  }

  function lineBody(
    item: CatalogueItem,
    multiplier: CatalogueItem,
    quantity = "1",
  ) {
    return {
      kind: item.kind,
      catalogueItemId: item.id,
      description: item.name,
      useDescription: `Hierarchy authoring ${item.kind} verification`,
      unitCost: "999999",
      quantity,
      multiplierCatalogueItemId:
        item.kind === "tooling" ? null : multiplier.id,
      fractionIncluded: "1",
      productionVolumeFactor:
        item.kind === "tooling" ? "3000" : null,
      sizeInputs: {},
    };
  }
  });

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
