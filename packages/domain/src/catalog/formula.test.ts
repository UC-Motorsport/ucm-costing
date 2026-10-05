import { describe, expect, it } from "vitest";

import {
  evaluateCatalogFormula,
  normalizeCatalogFormula,
} from "./formula";

describe("catalog formula evaluator", () => {
  it("normalizes catalogue placeholders and a missing leading equals sign", () => {
    expect(
      normalizeCatalogFormula(" [C1] * [Size1] + [c2] * [size2] "),
    ).toBe("c1 * size1 + c2 * size2");
  });

  it("evaluates a representative coefficient formula", () => {
    const result = evaluateCatalogFormula(
      "=[C1]*[Size1]+[C2]*[Size2]",
      {
        c1: "2.5",
        size1: "4",
        c2: "1.25",
        size2: "8",
      },
    );
    expect(result).toMatchObject({ ok: true, value: "20" });
  });

  it("supports the catalogue exponential spellings without general functions", () => {
    const upper = evaluateCatalogFormula("EXP([C1]*[Size1])", {
      c1: 0,
      size1: 500,
    });
    const legacy = evaluateCatalogFormula("e^([C1]*[Size1])", {
      c1: 0,
      size1: 500,
    });
    expect(upper).toMatchObject({ ok: true, value: "1" });
    expect(legacy).toMatchObject({ ok: true, value: "1" });
  });

  it("supports observed stock-derived variables, square root, and implicit placeholder multiplication", () => {
    const stock = evaluateCatalogFormula(
      "=3.3*[Area]*[Length]*[Density]",
      {
        area: 2,
        length: 3,
        density: 4,
      },
    );
    expect(stock).toMatchObject({ ok: true, value: "79.2" });

    const fastener = evaluateCatalogFormula(
      "=([C1]/105154)*(([Size1]^2)*[Size2]*SQRT([size2]))",
      {
        c1: 105154,
        size1: 2,
        size2: 4,
      },
    );
    expect(fastener).toMatchObject({ ok: true, value: "32" });

    const tooling = evaluateCatalogFormula("[C1][Size1]+[C2][Size2]", {
      c1: 2,
      size1: 3,
      c2: 4,
      size2: 5,
    });
    expect(tooling).toMatchObject({ ok: true, value: "26" });
  });

  it("rejects unknown symbols instead of evaluating JavaScript", () => {
    const result = evaluateCatalogFormula("constructor(1)", {});
    expect(result).toMatchObject({
      ok: false,
      error: 'Unknown formula variable "constructor"',
    });
  });

  it("rejects division by zero and missing variables", () => {
    expect(evaluateCatalogFormula("[C1] / 0", { c1: 4 })).toMatchObject({
      ok: false,
      error: "Division by zero",
    });
    expect(evaluateCatalogFormula("[C1] * [Size1]", { c1: 4 })).toMatchObject({
      ok: false,
      error: "Missing value for size1",
    });
  });

  it("surfaces malformed catalogue syntax for import review", () => {
    expect(evaluateCatalogFormula("([C1]*[Size1]))", {
      c1: 1,
      size1: 2,
    })).toMatchObject({
      ok: false,
      error: "Unexpected token rightParen",
    });
  });
});
