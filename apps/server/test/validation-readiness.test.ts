import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  DbExecutor,
} from "../src/db/database";
import {
  drawingIdentity,
} from "../src/report/ucm25-renderer";
import {
  assertReportGenerationAllowed,
  ReportValidationError,
} from "../src/services/report-service";
import type {
  CostLineRow,
  ProjectDetail,
  ProjectNode,
} from "../src/services/project-types";
import {
  validateProject,
  type ValidationResult,
} from "../src/services/validation-service";

const zero = {
  material: "0",
  process: "0",
  fastener: "0",
  tooling: "0",
  total: "0",
};

const electricTags = [
  "cells",
  "bms",
  "motors",
  "motor-controllers",
  "main-controller",
  "lv-battery",
] as const;
const combustionTags = ["engine", "ecu", "injectors"] as const;

describe("competition-ready validation", () => {
  it("waives only the image, and restores its blocker when required again", async () => {
    const detail = validDetail("electric");
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    part.image_required = false;
    part.image_requirement_reason = "Standard bought component";
    const waived = await runValidation(detail, electricTags, ["drawing"]);
    expect(waived.issues.some((issue) => issue.nodeId === part.id && issue.code === "part-visual-missing")).toBe(false);
    const noDrawing = await runValidation(detail, electricTags, []);
    const issue = noDrawing.issues.find((item) => item.nodeId === part.id && item.code === "part-visual-missing");
    expect(issue?.title).toContain("technical drawing");
    expect(issue?.title).not.toContain("isometric image");
    part.image_required = true;
    const restored = await runValidation(detail, electricTags, ["drawing"]);
    expect(restored.issues.find((item) => item.nodeId === part.id && item.code === "part-visual-missing")?.title).toContain("isometric image");
  });

  it("describes internal images as excluded and clears the warning once report-visible", async () => {
    const detail = validDetail("electric");
    const internal = await runValidation(detail, electricTags, ["image", "drawing"], "internal");
    const issues = internal.issues.filter(({code}) => code === "part-visual-missing");
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.title).toContain("isometric image excluded from report");
      expect(issue.title).not.toContain("missing");
    }
    const visible = await runValidation(detail, electricTags);
    expect(visible.issues.filter(({code}) => code === "part-visual-missing")).toHaveLength(0);
  });

  it("clears only an explicitly waived drawing and restores its blocker when required again", async () => {
    const detail = validDetail("electric");
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    part.drawing_required = false;
    const result = await runValidation(detail, electricTags, ["image"]);
    expect(result.issues.filter(({ code }) => code === "part-visual-missing")).toHaveLength(1);
    expect(result.issues.some((issue) => issue.nodeId === part.id && issue.code === "part-visual-missing")).toBe(false);
    const missingImage = await runValidation(detail, electricTags, []);
    expect(missingImage.issues.find((issue) => issue.nodeId === part.id && issue.code === "part-visual-missing")?.title).toContain("isometric image");
    part.drawing_required = true;
    const restored = await runValidation(detail, electricTags, ["image"]);
    expect(restored.issues.filter(({ code }) => code === "part-visual-missing")).toHaveLength(2);
  });

  it("requires both an isometric image and technical drawing for every costed item", async () => {
    const detail = validDetail("electric");

    const withoutDrawings = await runValidation(
      detail,
      electricTags,
      ["image"],
    );
    const drawingIssues = withoutDrawings.issues.filter(
      ({ code }) => code === "part-visual-missing",
    );
    expect(drawingIssues).toHaveLength(2);
    expect(
      drawingIssues.every(({ title }) => title.includes("technical drawing")),
    ).toBe(true);

    const withoutIsometrics = await runValidation(
      detail,
      electricTags,
      ["drawing"],
    );
    const isometricIssues = withoutIsometrics.issues.filter(
      ({ code }) => code === "part-visual-missing",
    );
    expect(isometricIssues).toHaveLength(2);
    expect(
      isometricIssues.every(({ title }) => title.includes("isometric image")),
    ).toBe(true);

    expect(
      await runValidation(detail, electricTags),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });

  it("blocks an absent controlled part number and preserves exact valid identity", async () => {
    const detail = validDetail("electric");
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    part.full_number = null;

    const validation = await runValidation(detail, electricTags);

    expectBlocked(validation, ["part-number-missing"]);
    expect(drawingIdentity(part, "draft")).toEqual({
      partNumber: "MISSING - DRAFT",
      revision: "A",
    });
    expect(drawingIdentity(part, "export")).toEqual({
      partNumber: "MISSING",
      revision: "A",
    });
    expect(() => drawingIdentity(part, "competition-ready")).toThrow(
      `competition-ready-report-identity-missing:${part.id}:full-number`,
    );

    part.full_number = "E13-26-CH-000002-A";
    expect(drawingIdentity(part, "competition-ready")).toEqual({
      partNumber: "E13-26-CH-000002-A",
      revision: "A",
    });
    expect(
      await runValidation(detail, electricTags),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });

  it("blocks unknown procurement classification and permits an explicit made/bought value", async () => {
    const detail = validDetail("electric");
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    part.procurement_type = "unknown";

    expectBlocked(
      await runValidation(detail, electricTags),
      ["made-bought-unset"],
    );

    part.procurement_type = "bought";
    expect(
      await runValidation(detail, electricTags),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });

  it("requires the official 2026 DR drawing focus while preserving extra team focus systems", async () => {
    const detail = validDetail("electric");
    detail.project.focusSystems = ["CH"];

    expectBlocked(
      await runValidation(detail, electricTags),
      ["required-focus-system-missing"],
    );

    detail.project.focusSystems = ["DR", "CH"];
    expect(
      await runValidation(detail, electricTags),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });

  it("blocks absent vehicle, assembly, and part revisions instead of assuming revision A", async () => {
    const detail = validDetail("electric");
    const assembly = detail.flatNodes.find(
      ({ kind }) => kind === "assembly",
    )!;
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    detail.tree.revision = null;
    assembly.revision = null;
    part.revision = null;

    expectBlocked(
      await runValidation(detail, electricTags),
      [
        "vehicle-revision-missing",
        "assembly-revision-missing",
        "part-revision-missing",
      ],
    );
    expect(drawingIdentity(part, "draft")).toEqual({
      partNumber: "E13-26-CH-000002-A",
      revision: "MISSING",
    });
    expect(drawingIdentity(part, "export")).toEqual({
      partNumber: "E13-26-CH-000002-A",
      revision: "MISSING",
    });
    expect(() => drawingIdentity(part, "competition-ready")).toThrow(
      `competition-ready-report-identity-missing:${part.id}:revision`,
    );
  });

  it("requires engine, ECU, and injector datasheets for combustion projects", async () => {
    const detail = validDetail("combustion");

    expectBlocked(await runValidation(detail, []), [
      "critical-datasheet-engine",
      "critical-datasheet-ecu",
      "critical-datasheet-injectors",
    ]);

    expect(
      await runValidation(detail, combustionTags),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });

  it("applies both electric and combustion datasheet sets to dual projects", async () => {
    const detail = validDetail("dual");
    const onlyElectric = await runValidation(detail, electricTags);

    expectBlocked(onlyElectric, [
      "critical-datasheet-engine",
      "critical-datasheet-ecu",
      "critical-datasheet-injectors",
    ]);

    const onlyCombustion = await runValidation(
      detail,
      combustionTags,
    );
    expectBlocked(onlyCombustion, [
      "critical-datasheet-cells",
      "critical-datasheet-bms",
      "critical-datasheet-motors",
      "critical-datasheet-motor-controllers",
      "critical-datasheet-main-controller",
      "critical-datasheet-lv-battery",
    ]);

    expect(
      await runValidation(detail, [
        ...electricTags,
        ...combustionTags,
      ]),
    ).toMatchObject({
      blockers: 0,
      readyForCompetitionReport: true,
    });
  });
});

function expectBlocked(
  validation: ValidationResult,
  expectedCodes: readonly string[],
): void {
  expect(validation.readyForCompetitionReport).toBe(false);
  expect(validation.blockers).toBeGreaterThanOrEqual(
    expectedCodes.length,
  );
  expect(validation.issues.map(({ code }) => code)).toEqual(
    expect.arrayContaining([...expectedCodes]),
  );
  expect(() =>
    assertReportGenerationAllowed(
      "competition-ready",
      validation,
    ),
  ).toThrow(ReportValidationError);
  expect(() =>
    assertReportGenerationAllowed("draft", validation),
  ).not.toThrow();
  expect(() =>
    assertReportGenerationAllowed("deadline", validation),
  ).not.toThrow();
  expect(() =>
    assertReportGenerationAllowed("export", validation),
  ).not.toThrow();
}

async function runValidation(
  detail: ProjectDetail,
  datasheetTags: readonly string[],
  itemEvidenceKinds: readonly ("image" | "drawing")[] = [
    "image",
    "drawing",
  ],
  imageVisibility: "report" | "internal" = "report",
): Promise<ValidationResult> {
  const reportableNodes = detail.flatNodes.filter(
    ({ kind }) =>
      kind === "assembly" ||
      kind === "subassembly" ||
      kind === "part",
  );
  const rows = [
    evidence("vehicle-visual", detail.tree.id, "drawing", "vehicle"),
    ...reportableNodes.flatMap((node) =>
      itemEvidenceKinds.map((kind) =>
        evidence(
          `${node.kind}-${kind}`,
          node.id,
          kind,
          `${node.kind} ${kind}`,
        ),
      ),
    ),
    ...datasheetTags.map((tag, index) =>
      evidence(
        `datasheet-${index}`,
        null,
        "datasheet",
        `[${tag}] authoritative component datasheet`,
      ),
    ),
  ];
  for (const row of rows) { if (row.kind === "image") row.visibility = imageVisibility; }
  const database = {
    async query(text: string) {
      if (text.includes("FROM evidence")) {
        return queryResult(rows);
      }
      if (text.includes("FROM cair_requests")) {
        return queryResult([]);
      }
      if (text.includes("FROM cost_lines")) {
        return queryResult([]);
      }
      throw new Error(`Unexpected validation query: ${text}`);
    },
    async one() {
      throw new Error("Unexpected one()");
    },
    async maybeOne() {
      throw new Error("Unexpected maybeOne()");
    },
  } as unknown as DbExecutor;

  return await validateProject(
    database,
    detail,
    "competition-ready",
  );
}

function evidence(
  id: string,
  nodeId: string | null,
  kind: string,
  caption: string,
) {
  return {
    id,
    node_id: nodeId,
    kind,
    display_name: `${id}.pdf`,
    content_sha256: "a".repeat(64),
    storage_path: `uploads/${id}.pdf`,
    mime_type: "application/pdf",
    report_caption: caption,
    visibility: "report",
  };
}

function queryResult(rows: unknown[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function validDetail(
  vehicleType: "electric" | "combustion" | "dual",
): ProjectDetail {
  const part = node({
    id: "00000000-0000-4000-8000-000000000004",
    kind: "part",
    parentId: "00000000-0000-4000-8000-000000000003",
    fullNumber: "E13-26-CH-000002-A",
    costLines: [costLine()],
  });
  const assembly = node({
    id: "00000000-0000-4000-8000-000000000003",
    kind: "assembly",
    parentId: "00000000-0000-4000-8000-000000000002",
    fullNumber: "E13-26-CH-000001-A",
    children: [part],
  });
  const system = node({
    id: "00000000-0000-4000-8000-000000000002",
    kind: "system",
    parentId: "00000000-0000-4000-8000-000000000001",
    fullNumber: null,
    revision: null,
    children: [assembly],
  });
  const vehicle = node({
    id: "00000000-0000-4000-8000-000000000001",
    kind: "vehicle",
    parentId: null,
    fullNumber: "E13-26-VEHICLE",
    children: [system],
  });
  return {
    project: {
      id: "00000000-0000-4000-8000-000000000010",
      name: "UCM26 production vehicle",
      season: 2026,
      vehicle_type: vehicleType,
      entry_number: "E13",
      status: "review",
      rule_source_document_id: "rules",
      rule_pack_version: "v1.2",
      rule_pack_sha256: "b".repeat(64),
      catalogue_release_id: "catalogue",
      catalogue_revision: "26_R1",
      cost_model: "competition-universal-dollar",
      project_summary:
        "The team balanced verified performance requirements against repeatable bulk manufacturing cost.",
      numbering_convention:
        "Every controlled vehicle record uses its stored entry, season, system, reference, and revision identifier.",
      bulk_method_summary:
        "Verified bulk-production methods and their applications are recorded for every manufactured component.",
      report_setup_confirmed: 1,
      report_setup_confirmation: {
        id: "confirmation",
        contentHash: "c".repeat(64),
        confirmedAt: "2026-07-30T00:00:00.000Z",
        confirmedBy: {
          id: "user",
          displayName: "Cost Lead",
          email: "cost@example.test",
        },
        projectVersion: 1,
      },
      archived_at: null,
      created_by: "user",
      updated_by: "user",
      version: 1,
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
      focusSystems: ["DR", "CH"],
    },
    tree: vehicle,
    flatNodes: [vehicle, system, assembly, part],
    breakdown: {
      material: "10",
      process: "0",
      fastener: "0",
      tooling: "0",
      total: "10",
    },
  };
}

function node(input: {
  id: string;
  kind: ProjectNode["kind"];
  parentId: string | null;
  fullNumber: string | null;
  revision?: string | null;
  children?: ProjectNode[];
  costLines?: CostLineRow[];
}): ProjectNode {
  return {
    id: input.id,
    project_id: "00000000-0000-4000-8000-000000000010",
    parent_id: input.parentId,
    kind: input.kind,
    system_code:
      input.kind === "vehicle" ? null : "CH",
    raw_hla: null,
    raw_subassembly: null,
    raw_part_number: null,
    reference_id: null,
    full_number: input.fullNumber,
    name: `${input.kind} record`,
    description: `Controlled ${input.kind} description`,
    revision:
      input.revision === undefined ? "A" : input.revision,
    procurement_type: "made",
    quantity: "1",
    internal_note: "",
    source_import_batch_id: null,
    source_import_row: null,
    sort_order: 0,
    version: 0,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    costLines: input.costLines ?? [],
    breakdown:
      input.kind === "part"
        ? {
            material: "10",
            process: "0",
            fastener: "0",
            tooling: "0",
            total: "10",
          }
        : zero,
    children: input.children ?? [],
  };
}

function costLine(): CostLineRow {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    node_id: "00000000-0000-4000-8000-000000000004",
    kind: "material",
    catalogue_item_id: "catalogue-material",
    description: "Authoritative catalogue material",
    use_description: "Production component",
    unit_cost: "10",
    quantity: "1",
    multiplier: "1",
    multiplier_name: "No adjustment",
    multiplier_catalogue_item_id: "catalogue-multiplier",
    fraction_included: "1",
    production_volume_factor: null,
    size_inputs_json: "{}",
    calculation_json: "{}",
    subtotal: "10",
    sort_order: 0,
    version: 0,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
  };
}
