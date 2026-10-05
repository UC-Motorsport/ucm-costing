import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { getAppPaths } from "../../src/config";
import {
  appendValidationPages,
  buildUcm25ReportPlan,
  COST_DATA_ROW_HEIGHT,
  FIRST_PART_COST_START_Y,
  type ReportEvidence,
} from "../../src/report/ucm25-plan";
import { verifyUcm25CompatiblePdf } from "../../src/report/pdf-verifier";
import { renderUcm25CompatibleReport } from "../../src/report/ucm25-renderer";
import type {
  ProjectDetail,
  ProjectNode,
} from "../../src/services/project-types";

const zero = {
  material: "0",
  process: "0",
  fastener: "0",
  tooling: "0",
  total: "0",
};

function node(
  id: string,
  kind: ProjectNode["kind"],
  parentId: string | null,
  children: ProjectNode[] = [],
): ProjectNode {
  return {
    id,
    project_id: "project",
    parent_id: parentId,
    kind,
    system_code: kind === "vehicle" ? null : "CH",
    raw_hla: null,
    raw_subassembly: null,
    raw_part_number: null,
    reference_id: null,
    full_number: id.toUpperCase(),
    name: id,
    description: `${id} description`,
    revision: "A",
    procurement_type: "made",
    quantity: "1",
    internal_note: "",
    source_import_batch_id: null,
    source_import_row: null,
    sort_order: 0,
    version: 0,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    costLines: [],
    breakdown: zero,
    children,
  };
}

function fixture(): ProjectDetail {
  const part = node("part", "part", "assembly");
  const assembly = node("assembly", "assembly", "system", [part]);
  const system = node("system", "system", "vehicle", [assembly]);
  const vehicle = node("vehicle", "vehicle", null, [system]);
  return {
    project: {
      id: "project",
      name: "University of Canterbury Motorsport",
      season: 2026,
      vehicle_type: "electric",
      entry_number: "26",
      status: "draft",
      rule_source_document_id: "rules",
      rule_pack_version: "v1.2",
      rule_pack_sha256: "a".repeat(64),
      catalogue_release_id: "catalogue",
      catalogue_revision: "26_R1",
      cost_model: "competition-universal-dollar",
      project_summary: "A substantive project summary.",
      numbering_convention: "A substantive numbering convention.",
      bulk_method_summary: "A substantive bulk method summary.",
      report_setup_confirmed: 1,
      report_setup_confirmation: null,
      is_historical: false,
      archived_at: null,
      created_by: "user",
      updated_by: "user",
      version: 1,
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
      focusSystems: ["CH"],
    },
    tree: vehicle,
    flatNodes: [vehicle, system, assembly, part],
    breakdown: zero,
  };
}

function visual(id: string, nodeId: string): ReportEvidence {
  return {
    id,
    nodeId,
    kind: "drawing",
    displayName: `${id}.png`,
    contentSha256: "b".repeat(64),
    mimeType: "image/png",
    reportCaption: `${id} project drawing`,
    verifiedBytes: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47,
    ]),
  };
}

function imageVisual(id: string, nodeId: string): ReportEvidence {
  return { ...visual(id, nodeId), kind: "image" };
}

function historicalLayoutEvidence(bytes: Uint8Array): ReportEvidence {
  return {
    id: "historical-layout",
    nodeId: null,
    kind: "other",
    displayName: "ucm25-historical-layout.json",
    contentSha256: "c".repeat(64),
    mimeType: "application/json",
    reportCaption: "Historical layout",
    verifiedBytes: bytes,
  };
}

const acceptedUcm25Sha256 =
  "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37";

function historicalLayout(overrides?: {
  sourceHash?: string;
  sourceBytes?: number;
}): Uint8Array {
  const pages = Array.from({ length: 1_078 }, (_, index) => ({
    pageNumber: index + 1,
    class: "cover",
    ownerOccurrence: null,
    costKinds: [],
    costTableLayouts: [],
    assemblyRowCount: 0,
    imageFrame: null,
    renderMode: "generated",
  }));
  pages[0] = {
    ...pages[0]!,
    class: "technical-or-external-evidence",
    renderMode: "source",
    sourceEvidence: {
      displayName: "historical-evidence-chunk-001.pdf",
      sourcePageIndex: 0,
      contentSha256: overrides?.sourceHash ?? "d".repeat(64),
      byteSize: overrides?.sourceBytes ?? 4,
    },
  } as (typeof pages)[number];
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      sourcePdfSha256: acceptedUcm25Sha256,
      pageCount: 1_078,
      bom: [],
      pages,
    }),
  );
}

function historicalSourceChunk(): ReportEvidence {
  return {
    id: "historical-source-chunk",
    nodeId: null,
    kind: "other",
    displayName: "historical-evidence-chunk-001.pdf",
    contentSha256: "d".repeat(64),
    mimeType: "application/pdf",
    reportCaption: "Historical source pages",
    verifiedBytes: Uint8Array.from([1, 2, 3, 4]),
  };
}

async function nonA4StandardFontPdf(): Promise<Uint8Array> {
  const source = await PDFDocument.create();
  const page = source.addPage([720, 540]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawText("Verified supplier evidence", {
    x: 40,
    y: 460,
    size: 24,
    font,
  });
  return await source.save({ useObjectStreams: false });
}

describe("UCM25-compatible report plan", () => {
  it("retains the accepted UCM25 row geometry and 467-record BOM pagination", async () => {
    expect(COST_DATA_ROW_HEIGHT).toBe(15);
    expect(FIRST_PART_COST_START_Y).toBe(200);
    const assemblies = Array.from({ length: 467 }, (_, index) =>
      node(`assembly-${index}`, "assembly", "system"),
    );
    const system = node("system", "system", "vehicle", assemblies);
    const vehicle = node("vehicle", "vehicle", null, [system]);
    const detail = fixture();
    detail.tree = vehicle;
    detail.flatNodes = [vehicle, system, ...assemblies];
    const plan = await buildUcm25ReportPlan(detail, []);
    expect(plan.pages.filter(({ type }) => type === "bom")).toHaveLength(12);
  });

  it("uses project evidence or an honest empty frame and never plans demo geometry", async () => {
    const plan = await buildUcm25ReportPlan(fixture(), [
      imageVisual("vehicle-visual", "vehicle"),
      imageVisual("part-image", "part"),
      visual("part-drawing", "part"),
    ]);

    expect(plan.pages.slice(0, 4).map(({ type }) => type)).toEqual([
      "cover",
      "project-summary",
      "vehicle-drawing",
      "cost-summary",
    ]);
    const vehiclePage = plan.pages[2];
    expect(vehiclePage?.type).toBe("vehicle-drawing");
    if (vehiclePage?.type === "vehicle-drawing") {
      expect(vehiclePage.evidence?.id).toBe("vehicle-visual");
    }
    const technical = plan.pages.filter(
      (page) => page.type === "project-drawing",
    );
    expect(technical).toHaveLength(1);
    expect(
      technical.map((page) =>
        page.type === "project-drawing"
          ? page.evidence?.id ?? null
          : null,
      ),
    ).toEqual(["part-drawing"]);
    const partPage = plan.pages.find(
      (page) => page.type === "part" && !page.continued,
    );
    expect(partPage?.type === "part" ? partPage.evidence?.id : null).toBe(
      "part-image",
    );
    expect(
      plan.pages.some(
        ({ type }) => String(type).includes("demo"),
      ),
    ).toBe(false);
  });

  it("omits empty technical pages whether a drawing is missing or explicitly not required", async () => {
    const detail = fixture();
    const missing = await buildUcm25ReportPlan(detail, []);
    expect(missing.pages.some((page) => page.type === "project-drawing")).toBe(false);
    detail.flatNodes.find((node) => node.kind === "part")!.drawing_required = false;
    const waived = await buildUcm25ReportPlan(detail, []);
    expect(waived.pages.length).toBe(missing.pages.length);
    const attached = await buildUcm25ReportPlan(detail, [visual("uploaded", "part")]);
    expect(attached.pages.filter((page) => page.type === "project-drawing")).toHaveLength(1);
  });

  it("ignores the historical-layout filename for an ordinary project", async () => {
    const plan = await buildUcm25ReportPlan(fixture(), [
      historicalLayoutEvidence(new TextEncoder().encode("{}")),
    ]);

    expect(plan.pages[0]?.type).toBe("cover");
    expect(plan.pages).toHaveLength(
      (await buildUcm25ReportPlan(fixture(), [])).pages.length + 1,
    );
  });

  it("still validates the historical layout for an explicit 2025 workspace", async () => {
    const detail = fixture();
    detail.project.season = 2025;
    detail.project.is_historical = true;

    await expect(
      buildUcm25ReportPlan(detail, [
        historicalLayoutEvidence(new TextEncoder().encode("{}")),
      ]),
    ).rejects.toThrow("report-historical-layout-invalid");
  });

  it("requires every historical source chunk to match its signed layout hash and size", async () => {
    const detail = fixture();
    detail.project.season = 2025;
    detail.project.is_historical = true;
    const valid = await buildUcm25ReportPlan(detail, [
      historicalLayoutEvidence(historicalLayout()),
      historicalSourceChunk(),
    ]);
    expect(valid.pages[0]?.type).toBe("evidence");

    await expect(
      buildUcm25ReportPlan(detail, [
        historicalLayoutEvidence(
          historicalLayout({ sourceHash: "e".repeat(64) }),
        ),
        historicalSourceChunk(),
      ]),
    ).rejects.toThrow("report-historical-source-evidence-missing");
  });

  it("uses submitted BOM descriptions and page pointers without replacing editable source fields", async () => {
    const detail = fixture();
    detail.project.season = 2025;
    detail.project.is_historical = true;
    const assembly = detail.flatNodes.find((item) => item.id === "assembly")!;
    assembly.internal_note = JSON.stringify({
      sourcePdfSha256: acceptedUcm25Sha256,
      sourceBomOccurrence: 1,
    });
    assembly.name = "Editable source assembly name";

    const layout = JSON.parse(
      new TextDecoder().decode(historicalLayout()),
    ) as {
      bom: Array<Record<string, unknown>>;
      pages: Array<Record<string, unknown>>;
    };
    layout.bom = [
      {
        occurrence: 1,
        line_number: 1,
        bom_page: 5,
        system_code: "CH",
        expected_detail_page: 42,
        assembly_description: "Submitted assembly name",
        part_description: "",
      },
    ];
    layout.pages[4] = {
      pageNumber: 5,
      class: "bom",
      ownerOccurrence: null,
      costKinds: [],
      costTableLayouts: [],
      assemblyRowCount: 0,
      imageFrame: null,
      renderMode: "generated",
    };

    const plan = await buildUcm25ReportPlan(detail, [
      historicalLayoutEvidence(
        new TextEncoder().encode(JSON.stringify(layout)),
      ),
      historicalSourceChunk(),
    ]);
    const bom = plan.pages[4];
    expect(bom?.type).toBe("bom");
    if (bom?.type !== "bom") throw new Error("expected BOM page");
    expect(bom.pageNumberByNode.get(assembly.id)).toBe(42);
    expect(bom.rows[0]).toMatchObject({
      type: "node",
      historicalAssemblyDescription: "Submitted assembly name",
    });
    expect(assembly.name).toBe("Editable source assembly name");
  });

  it("keeps submitted quantities and assembly children after source quantity reconciliation", async () => {
    const detail = fixture();
    detail.project.season = 2025;
    detail.project.is_historical = true;
    const assembly = detail.flatNodes.find((item) => item.id === "assembly")!;
    const part = detail.flatNodes.find((item) => item.id === "part")!;
    assembly.internal_note = JSON.stringify({ sourcePdfSha256: acceptedUcm25Sha256, sourceBomOccurrence: 1 });
    part.quantity = "1";
    part.internal_note = JSON.stringify({
      sourcePdfSha256: acceptedUcm25Sha256, sourceBomOccurrence: 2,
      sourceQuantityCorrection: { kind: "source-assembly-quantity-correction" },
      historicalBomQuantity: "2", historicalParentOccurrence: 1, historicalNodeKind: "part",
    });
    const nested = node("planet", "subassembly", assembly.id);
    nested.quantity = "3";
    nested.sort_order = 3;
    nested.internal_note = JSON.stringify({
      sourcePdfSha256: acceptedUcm25Sha256, sourceBomOccurrence: 3,
      sourceQuantityCorrection: { kind: "source-assembly-parent-correction" },
      historicalBomQuantity: "3", historicalParentOccurrence: null, historicalNodeKind: "assembly",
    });
    assembly.children.push(nested);
    detail.flatNodes.push(nested);
    const before = JSON.stringify(detail);
    const layout = JSON.parse(new TextDecoder().decode(historicalLayout()));
    layout.bom = [1, 2, 3].map((occurrence) => ({
      occurrence, line_number: occurrence, bom_page: 5, system_code: "CH",
      expected_detail_page: 6, assembly_description: "", part_description: "",
    }));
    layout.pages[4] = { ...layout.pages[4], class: "bom" };
    layout.pages[5] = { ...layout.pages[5], class: "node-detail", ownerOccurrence: 1, assemblyRowCount: 10 };
    const evidence = [historicalLayoutEvidence(new TextEncoder().encode(JSON.stringify(layout))), historicalSourceChunk()];
    const plan = await buildUcm25ReportPlan(detail, evidence);
    const bom = plan.pages[4];
    if (bom?.type !== "bom") throw new Error("expected BOM");
    const displayed = bom.rows.filter((row) => row.type === "node").map((row) => row.node);
    expect(displayed.find((item) => item.id === part.id)?.quantity).toBe("2");
    expect(displayed.find((item) => item.id === nested.id)).toMatchObject({ parent_id: "system", kind: "assembly", quantity: "3" });
    const assemblyPage = plan.pages[5];
    if (assemblyPage?.type !== "assembly") throw new Error("expected assembly page");
    expect(assemblyPage.children.map((item) => item.id)).toEqual(["part"]);
    expect(assemblyPage.children[0]?.quantity).toBe("2");
    expect(JSON.stringify(detail)).toBe(before);

    // Ordinary exports must use the actual corrected quantities and hierarchy.
    detail.project.season = 2026;
    detail.project.is_historical = false;
    const ordinary = await buildUcm25ReportPlan(detail, []);
    const ordinaryRows = ordinary.pages.flatMap((page) => page.type === "bom" ? page.rows : []);
    expect(ordinaryRows.find((row) => row.type === "node" && row.node.id === part.id)).toMatchObject({ node: { quantity: "1" } });
    expect(ordinaryRows.find((row) => row.type === "node" && row.node.id === nested.id)).toMatchObject({ node: { parent_id: "assembly", kind: "subassembly" } });

    detail.project.season = 2025;
    detail.project.is_historical = true;
    part.internal_note = JSON.stringify({ ...JSON.parse(part.internal_note), historicalParentOccurrence: 2 });
    await expect(buildUcm25ReportPlan(detail, evidence)).rejects.toThrow("report-historical-quantity-provenance-invalid");
  });

  it("appends every frozen finding to non-final reports", async () => {
    const base = await buildUcm25ReportPlan(fixture(), []);
    const issues = Array.from({ length: 11 }, (_, index) => ({
      id: `issue-${index}`,
      severity: index === 0 ? ("blocker" as const) : ("warning" as const),
      code: `issue-${index}`,
      title: `Finding ${index}`,
      detail: `Detail ${index}`,
      nodeId: null,
      ruleReference: null,
    }));

    const deadline = appendValidationPages(base, issues, "deadline");
    const validationPages = deadline.pages.filter(
      (page) => page.type === "validation",
    );
    expect(validationPages).toHaveLength(2);
    expect(
      validationPages.flatMap((page) =>
        page.type === "validation" ? page.issues : [],
      ),
    ).toEqual(issues);
    expect(
      appendValidationPages(base, issues, "competition-ready").pages,
    ).toEqual(base.pages);
    expect(
      appendValidationPages(base, issues, "export").pages,
    ).toEqual(base.pages);
  });

  it.each([true, false])("renders a neutral full export with image required=%s and incomplete identity", async (imageRequired) => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "ucm-full-report-export-"),
    );
    const destination = path.join(temporaryRoot, "cost-report.pdf");
    const detail = fixture();
    const part = detail.flatNodes.find(({ kind }) => kind === "part")!;
    part.full_number = null;
    part.revision = null;
    part.image_required = imageRequired;
    const base = await buildUcm25ReportPlan(detail, []);
    try {
      const pageCount = await renderUcm25CompatibleReport({
        destination,
        detail,
        validation: {
          projectId: "project",
          checkedAt: "2026-07-30T00:00:00.000Z",
          mode: "export",
          blockers: 1,
          warnings: 0,
          notices: 0,
          readyForCompetitionReport: false,
          issues: [
            {
              id: "identity-missing",
              severity: "blocker",
              code: "identity-missing",
              title: "Controlled identity is incomplete",
              detail: "Assign the controlled identity before submission.",
              nodeId: part.id,
              ruleReference: "Local Addendum S.3",
            },
          ],
        },
        mode: "export",
        evidence: [],
        paths: getAppPaths(),
        createdAt: "2026-07-30T00:00:00.000Z",
      });
      const pdf = await PDFDocument.load(await readFile(destination));
      expect(pageCount).toBe(base.pages.length);
      expect(pdf.getPageCount()).toBe(base.pages.length);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("renders the deadline fallback and its findings into a valid PDF", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "ucm-deadline-report-"),
    );
    const destination = path.join(temporaryRoot, "deadline.pdf");
    const issue = {
      id: "identity-missing",
      severity: "blocker" as const,
      code: "identity-missing",
      title: "Controlled identity is incomplete",
      detail: "Assign the controlled part number before final submission.",
      nodeId: null,
      ruleReference: "Local Addendum S.3",
    };
    try {
      const pageCount = await renderUcm25CompatibleReport({
        destination,
        detail: fixture(),
        validation: {
          projectId: "project",
          checkedAt: "2026-07-30T00:00:00.000Z",
          mode: "deadline",
          blockers: 1,
          warnings: 0,
          notices: 0,
          readyForCompetitionReport: false,
          issues: [issue],
        },
        mode: "deadline",
        evidence: [],
        paths: getAppPaths(),
        createdAt: "2026-07-30T00:00:00.000Z",
      });
      const pdf = await PDFDocument.load(await readFile(destination));
      expect(pdf.getPageCount()).toBe(pageCount);
      expect(pageCount).toBeGreaterThan(
        (await buildUcm25ReportPlan(fixture(), [])).pages.length,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("normalizes PDF evidence and passes the production PDF contract", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "ucm-production-pdf-contract-"),
    );
    const destination = path.join(temporaryRoot, "production-report.pdf");
    const evidenceBytes = await nonA4StandardFontPdf();
    const evidence: ReportEvidence = {
      id: "supplier-pdf",
      nodeId: null,
      kind: "datasheet",
      displayName: "supplier-letter-size.pdf",
      contentSha256: "d".repeat(64),
      mimeType: "application/pdf",
      reportCaption: "Supplier evidence rendered into the report",
      verifiedBytes: evidenceBytes,
    };
    const technicalDrawing: ReportEvidence = {
      ...evidence,
      id: "technical-pdf",
      nodeId: "part",
      kind: "drawing",
      displayName: "part-technical-drawing.pdf",
      reportCaption: "Part technical drawing",
    };
    const detail = fixture();
    try {
      await renderUcm25CompatibleReport({
        destination,
        detail,
        validation: {
          projectId: "project",
          checkedAt: "2026-07-30T00:00:00.000Z",
          mode: "competition-ready",
          blockers: 0,
          warnings: 0,
          notices: 0,
          readyForCompetitionReport: true,
          issues: [],
        },
        mode: "competition-ready",
        evidence: [evidence, technicalDrawing],
        paths: getAppPaths(),
        createdAt: "2026-07-30T00:00:00.000Z",
      });

      const verification = await verifyUcm25CompatiblePdf(
        await readFile(destination),
        destination,
      );
      expect(verification.geometry.invalidPages).toBe(0);
      expect(verification.fonts.nonEmbeddedStandardFonts).toEqual([]);
      expect(verification.fonts.embeddedFontPrograms).toBeGreaterThan(0);
      expect(verification.fonts.hasSubsettedCarlito).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
