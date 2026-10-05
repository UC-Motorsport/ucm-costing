import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { detectAndPreviewCsv } from "../../src/import/index.js";

const MASTER_FIXTURE = fileURLToPath(
  new URL(
    "../fixtures/legacy-master.csv",
    import.meta.url,
  ),
);
const ASSEMBLY_INDEX_FIXTURE = fileURLToPath(
  new URL(
    "../fixtures/assembly-index.csv",
    import.meta.url,
  ),
);

describe("detectAndPreviewCsv", () => {
  it("preserves synthetic legacy records, provenance and diagnostic edge cases", async () => {
    const preview = detectAndPreviewCsv(await readFile(MASTER_FIXTURE), { sourceName: "misleading-name.csv" });
    expect(preview.template).toBe("legacy-master");
    if (preview.template !== "legacy-master") throw new Error("Expected legacy master");
    expect(preview.readOnly).toBe(true);
    expect(preview.encoding).toBe("windows-1252");
    expect(preview.headerRowNumber).toBe(3);
    expect(preview.records).toHaveLength(9);
    expect(preview.stats).toMatchObject({ apparentRecordCount: 9, assemblyRecordCount: 3, componentRecordCount: 6, duplicateCandidateCount: 1 });
    expect(preview.records.find(({ partNumber }) => partNumber === "02-R")).toMatchObject({ system: "DR", partBase: "02", variant: "R", sourceKey: "DR.01.01.02-R", sixDigitCode: "010102" });
    expect(preview.records.find(({ partNumber }) => partNumber === "02-R")?.provenance.overflowCells).toContainEqual({ columnNumber: 21, rawValue: "synthetic overflow" });
    expect(preview.records[2]?.description).toBe("Café test");
    expect(preview.records[2]?.legacyStatuses).toEqual({ costed: "1", costingUpdated: "2", drawing: "2", isoImage: "2", costingSheet: "2", compiled: "2" });
    expect(preview.records[2]).not.toHaveProperty("normalizedStatuses");
    for (const code of ["invalid-system-code", "duplicate-source-key", "missing-hierarchy-segment", "unexpected-legacy-status", "repeated-header-row"]) {
      expect(preview.issues).toContainEqual(expect.objectContaining({ code }));
    }
    expect(preview.records[4]).toMatchObject({ system: "DR", sourceKey: "DR.01.01.03" });
  });

  it("previews synthetic ownership claims and reports missing owners", async () => {
    const preview = detectAndPreviewCsv(await readFile(ASSEMBLY_INDEX_FIXTURE));
    expect(preview.template).toBe("assembly-index");
    if (preview.template !== "assembly-index") throw new Error("Expected assembly index");
    expect(preview.encoding).toBe("utf-8");
    expect(preview.headerRowNumber).toBe(2);
    expect(preview.claims).toHaveLength(3);
    expect(preview.stats).toMatchObject({ claimCount: 3, namedClaimCount: 2, ownedClaimCount: 1 });
    expect(preview.claims[0]).toMatchObject({ system: "DR", hla: "01", assemblyName: "Example drive", ownerName: "Example contributor", sourceKey: "DR.01" });
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: "missing-claim-owner", sourceKey: "DR.02" }));
  });

  it("excludes repeated headers and retains the recognized section system", () => {
    const preview = detectAndPreviewCsv(
      Buffer.from(
        [
          "SYS,HLA,SubA,Part No.,Rev,Assembly,Component,Description ,Bought/Made,QTY  total,QTY on car,Costed?,where did it come from (source),Costing Updated,Drawing,Iso image,Costing sheet,Checked By,Notes,Compiled",
          "Drivetrain - DR,,,,,,,,,,,,,,,,,,",
          "DT,01,00,00,,Front Motor Cooling,High Level Assembly,,,,,,,,,,,,,",
          "SYS,HLA,SubA,Part No.,Rev,Assembly,Component,Description ,Bought/Made,QTY  total,QTY on car,Costed?,where did it come from (source),Costing Updated,Drawing,Iso image,Costing sheet,Checked By,Notes,Compiled",
        ].join("\r\n"),
        "utf8",
      ),
    );

    expect(preview.template).toBe("legacy-master");
    if (preview.template !== "legacy-master") {
      throw new Error("Expected legacy-master preview");
    }

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      system: "DR",
      sourceKey: "DR.01.00.00",
      assemblyName: "Front Motor Cooling",
    });
    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "invalid-system-code",
        rowNumber: 3,
        candidateFix: "DR",
      }),
    );
    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        severity: "info",
        code: "repeated-header-row",
        rowNumber: 4,
      }),
    );
  });

  it("reports unsupported content instead of guessing a template", () => {
    const preview = detectAndPreviewCsv(
      Buffer.from("alpha,beta\r\none,two\r\n", "utf8"),
    );

    expect(preview.template).toBe("unknown");
    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unsupported-template",
      }),
    );
  });
});
