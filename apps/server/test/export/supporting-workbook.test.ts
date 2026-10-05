import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";

import { parseCatalogueWorkbook } from "../../src/catalog/catalogue-workbook";
import {
  generateSupportingWorkbook,
  SupportingWorkbookValidationError,
  type SupportingWorkbookSnapshot,
} from "../../src/export/supporting-workbook";

const hash = "a".repeat(64);

function fixture(): SupportingWorkbookSnapshot {
  const materialLine = {
    id: "line-material",
    kind: "material" as const,
    description: "6061-T6 plate & profile",
    use_description: "Main bracket <left>",
    unit_cost: "2",
    quantity: "3",
    multiplier: "1.5",
    multiplier_name: "Complexity",
    multiplier_catalogue_item_id: "multiplier-item",
    fraction_included: "1",
    production_volume_factor: null,
    size_inputs_json: { width: "12", length: "30" },
    subtotal: "9",
    catalogue: {
      releaseId: "release-26-r1",
      revision: "26_R1",
      itemId: "catalogue-db-item",
      catalogueId: "M-001",
      sourceSheet: "Materials",
      sourceRow: 42,
    },
  };
  const zero = {
    material: "0",
    process: "0",
    fastener: "0",
    tooling: "0",
    total: "0",
  };
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    createdAt: "2026-07-30T08:00:00.000Z",
    mode: "competition-ready",
    sources: {
      rulePack: { version: "FSAE-A 2026 v1.2", sha256: hash },
      catalogue: {
        releaseId: "release-26-r1",
        revision: "26_R1",
        sha256: "b".repeat(64),
      },
    },
    project: {
      id: "project-1",
      name: "University of Canterbury Motorsport",
      season: 2026,
      entry_number: "26",
      vehicle_type: "electric",
      rule_pack_version: "FSAE-A 2026 v1.2",
      catalogue_revision: "26_R1",
    },
    breakdown: {
      material: "18",
      process: "0",
      fastener: "0",
      tooling: "0",
      total: "18",
    },
    tree: {
      id: "vehicle",
      parent_id: null,
      kind: "vehicle",
      system_code: null,
      full_number: null,
      reference_id: null,
      name: "UCM26",
      description: "Competition vehicle",
      revision: null,
      procurement_type: "made",
      quantity: "1",
      breakdown: {
        material: "18",
        process: "0",
        fastener: "0",
        tooling: "0",
        total: "18",
      },
      costLines: [],
      children: [
        {
          id: "system",
          parent_id: "vehicle",
          kind: "system",
          system_code: "CH",
          full_number: "CH",
          reference_id: null,
          name: "Chassis",
          description: "Chassis system",
          revision: null,
          procurement_type: "made",
          quantity: "1",
          breakdown: {
            material: "18",
            process: "0",
            fastener: "0",
            tooling: "0",
            total: "18",
          },
          costLines: [],
          children: [
            {
              id: "part",
              parent_id: "system",
              kind: "part",
              system_code: "CH",
              full_number: "CH-001",
              reference_id: "P-001",
              name: "Bracket",
              description: "Main mounting bracket",
              revision: "A",
              procurement_type: "made",
              quantity: "2",
              breakdown: {
                material: "9",
                process: "0",
                fastener: "0",
                tooling: "0",
                total: "9",
              },
              costLines: [materialLine],
              children: [],
            },
          ],
        },
      ],
    },
  };
}

describe("supporting workbook export", () => {
  it("writes deterministic formula-free Option-4 data that reconciles", () => {
    const first = generateSupportingWorkbook(fixture());
    const second = generateSupportingWorkbook(fixture());
    expect(first.issues).toEqual([]);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toEqual(second.bytes);

    const workbook = parseCatalogueWorkbook(first.bytes);
    expect(workbook.sheets.map(({ name }) => name)).toEqual([
      "Submission Manifest",
      "BOM",
      "Cost Data",
      "Reconciliation",
    ]);
    const costSheet = workbook.sheetsByName["Cost Data"]!;
    expect(
      costSheet.rows[1]!.cells.map(({ value }) => value),
    ).toContain("6061-T6 plate & profile");
    expect(
      costSheet.rows[1]!.cells.map(({ value }) => value),
    ).toContain(9);

    const archive = unzipSync(first.bytes);
    const worksheetXml = Object.entries(archive)
      .filter(([name]) => name.startsWith("xl/worksheets/"))
      .map(([, bytes]) => strFromU8(bytes))
      .join("");
    expect(worksheetXml).not.toContain("<f");
    expect(worksheetXml).toContain("&amp;");
    expect(worksheetXml).toContain("&lt;left&gt;");
  });

  it("fails closed when a ready snapshot's stored subtotal diverges", () => {
    const input = fixture();
    input.tree.children[0]!.children[0]!.costLines[0]!.subtotal = "9.01";
    expect(() => generateSupportingWorkbook(input)).toThrow(
      SupportingWorkbookValidationError,
    );
  });

  it("keeps incomplete provenance visible in a draft workbook", () => {
    const input = fixture();
    input.mode = "draft";
    input.tree.children[0]!.children[0]!.costLines[0]!.catalogue = null;
    const result = generateSupportingWorkbook(input);
    expect(result.issues.map(({ code }) => code)).toContain(
      "cost-line-provenance-missing",
    );
    expect(
      parseCatalogueWorkbook(result.bytes).sheets.map(({ name }) => name),
    ).toContain("Issues");
  });
});
