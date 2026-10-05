import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CATALOGUE_SHEET_NAMES,
  CatalogueWorkbookError,
  MAX_CATALOGUE_COMPRESSED_BYTES,
  MAX_CATALOGUE_UNCOMPRESSED_BYTES,
  parseCatalogueWorkbook,
  profileCatalogue,
  type CatalogueProfile,
  type CatalogueSheetName,
  type CatalogueWorkbookErrorCode,
  type ParsedCatalogueCell,
} from "../../src/catalog/index.js";

const OFFICIAL_FIXTURE = fileURLToPath(
  new URL(
    "../../../../docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx",
    import.meta.url,
  ),
);
const EXPECTED_ROW_COUNTS: Record<CatalogueSheetName, number> = {
  Home: 1_000,
  Materials: 1_094,
  Processes: 1_001,
  "Process Multipliers": 1_000,
  Fasteners: 1_000,
  Tooling: 1_003,
  "Stock Sizes": 1_030,
};

let official: CatalogueProfile;

function cell(
  profile: CatalogueProfile,
  sheetName: CatalogueSheetName,
  reference: string,
): ParsedCatalogueCell {
  const match = profile.sheets[sheetName].rows
    .flatMap(({ cells }) => cells)
    .find((candidate) => candidate.reference === reference);
  if (match === undefined) {
    throw new Error(`Missing test cell ${sheetName}!${reference}`);
  }
  return match;
}

function expectErrorCode(
  action: () => unknown,
  code: CatalogueWorkbookErrorCode,
): void {
  try {
    action();
    throw new Error(`Expected CatalogueWorkbookError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueWorkbookError);
    expect((error as CatalogueWorkbookError).code).toBe(code);
  }
}

beforeAll(async () => {
  official = profileCatalogue(await readFile(OFFICIAL_FIXTURE));
});

describe("Formula SAE-A catalogue workbook parser", () => {
  it("maps the exact seven sheets and representative source row counts", () => {
    for (const profile of [official]) {
      expect(profile.workbook.sheets.map(({ name }) => name)).toEqual(
        CATALOGUE_SHEET_NAMES,
      );
      expect(Object.keys(profile.sheets)).toEqual(CATALOGUE_SHEET_NAMES);
      expect(profile.rowCounts).toEqual(EXPECTED_ROW_COUNTS);
      expect(profile.workbook.sheetsByName.Materials).toBe(
        profile.sheets.Materials,
      );
      expect(profile.workbook.compressedBytes).toBeLessThanOrEqual(
        MAX_CATALOGUE_COMPRESSED_BYTES,
      );
      expect(profile.workbook.uncompressedBytes).toBeLessThanOrEqual(
        MAX_CATALOGUE_UNCOMPRESSED_BYTES,
      );
    }
  });

  it("preserves cell provenance, raw storage, and formulas without evaluation", () => {
    expect(cell(official, "Home", "B2")).toMatchObject({
      reference: "B2",
      rowNumber: 2,
      columnNumber: 2,
      columnName: "B",
      cellType: "s",
      rawValue: "0",
      value: "FSAE-A COST CATALOGUE",
      rawFormula: null,
    });

    expect(cell(official, "Materials", "B3")).toMatchObject({
      reference: "B3",
      rowNumber: 3,
      columnNumber: 2,
      rawValue: "2",
      value: 2,
      rawFormula: "B2+1",
      formulaAttributes: {},
    });
    expect(cell(official, "Materials", "C176").value).toBe(
      "Master Cylinder, Tripmatic & Speed 18771",
    );
    expect(cell(official, "Process Multipliers", "B4")).toMatchObject({
      rawValue: "3",
      value: 3,
      rawFormula: "",
      formulaAttributes: { t: "shared", si: "0" },
    });

    expect(cell(official, "Home", "B7")).toMatchObject({ rawValue: "2296", value: "24_R1" });
  });

  it("also exposes the generic named-sheet parser", async () => {
    const workbook = parseCatalogueWorkbook(await readFile(OFFICIAL_FIXTURE));
    expect(workbook.sheets).toHaveLength(7);
    expect(workbook.sheetsByName["Stock Sizes"]?.rows).toHaveLength(1_030);
    expect(workbook.sharedStrings).toHaveLength(3_068);
  });

  it("rejects non-XLSX input and compressed files above 20 MB", () => {
    expectErrorCode(
      () => parseCatalogueWorkbook(Buffer.from("not an xlsx", "utf8")),
      "invalid-zip",
    );
    expectErrorCode(
      () =>
        parseCatalogueWorkbook(
          Buffer.alloc(MAX_CATALOGUE_COMPRESSED_BYTES + 1),
        ),
      "compressed-size-limit",
    );
  });

  it("rejects a small compressed ZIP that expands past the total ceiling", () => {
    const oversizedArchive = zipSync(
      {
        "oversized.xml": new Uint8Array(
          MAX_CATALOGUE_UNCOMPRESSED_BYTES + 1,
        ),
      },
      { level: 9 },
    );

    expect(oversizedArchive.byteLength).toBeLessThan(
      MAX_CATALOGUE_COMPRESSED_BYTES,
    );
    expectErrorCode(
      () => parseCatalogueWorkbook(oversizedArchive),
      "uncompressed-size-limit",
    );
  });
});
