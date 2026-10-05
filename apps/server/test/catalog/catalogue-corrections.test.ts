import { describe, expect, it } from "vitest";

import { findCatalogueFormulaCorrection } from "../../src/services/catalogue-corrections";
import { CATALOGUE_RELEASE_ID } from "../../src/services/reference-data-identifiers";

describe("26_R1 catalogue formula corrections", () => {
  it.each(["15", "16", "17", "19"])(
    "provides the surface-area formula for tooling ID %s",
    (catalogueId) => {
      expect(
        findCatalogueFormulaCorrection({
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "tooling",
          catalogueId,
          sourceFormula: "m^2",
        }),
      ).toMatchObject({
        catalogueId,
        expectedSourceFormula: "m^2",
        effectiveFormula: "=[C1]*[Size1]",
        inputs: {
          size1: { label: "Tool surface area", unit: "m²" },
        },
      });
    },
  );

  it("does not apply outside the exact release, row, kind, and source value", () => {
    for (const input of [
      {
        releaseId: "another-release",
        kind: "tooling",
        catalogueId: "19",
        sourceFormula: "m^2",
      },
      {
        releaseId: CATALOGUE_RELEASE_ID,
        kind: "material",
        catalogueId: "19",
        sourceFormula: "m^2",
      },
      {
        releaseId: CATALOGUE_RELEASE_ID,
        kind: "tooling",
        catalogueId: "18",
        sourceFormula: "m^2",
      },
      {
        releaseId: CATALOGUE_RELEASE_ID,
        kind: "tooling",
        catalogueId: "19",
        sourceFormula: "=[C1]*[Size1]",
      },
    ]) {
      expect(findCatalogueFormulaCorrection(input)).toBeNull();
    }
  });
});
