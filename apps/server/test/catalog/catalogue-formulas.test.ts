import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { evaluateCatalogFormula } from "@ucm/domain";
import { describe, expect, it } from "vitest";

import { profileCatalogue } from "../../src/catalog";

const CATALOGUE = fileURLToPath(
  new URL(
    "../../../../docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx",
    import.meta.url,
  ),
);

describe("26_R1 formula coverage", () => {
  it("safely compiles every observed cost expression except the one malformed source row", async () => {
    const profile = profileCatalogue(await readFile(CATALOGUE));
    const formulas: string[] = [];

    for (const sheetName of ["Materials", "Fasteners", "Tooling"] as const) {
      for (const row of profile.sheets[sheetName].rows) {
        const candidate = row.cells.find(
          ({ columnNumber }) => columnNumber === 12,
        )?.value;
        if (
          typeof candidate === "string" &&
          candidate.includes("[") &&
          candidate.toLowerCase() !== "formula"
        ) {
          formulas.push(candidate);
        }
      }
    }

    const failures = formulas
      .map((formula) => ({
        formula,
        result: evaluateCatalogFormula(formula, {
          size1: 1,
          size2: 1,
          size3: 1,
          size4: 1,
          c1: 1,
          c2: 1,
          c3: 1,
          c4: 1,
          area: 1,
          length: 1,
          density: 1,
        }),
      }))
      .filter(({ result }) => !result.ok);

    expect(formulas).toHaveLength(457);
    expect(failures).toEqual([
      {
        formula: "=([C1]*[Size1]*[Size2])+[C2])",
        result: expect.objectContaining({
          ok: false,
          error: "Unexpected token rightParen",
        }),
      },
    ]);
  });
});
