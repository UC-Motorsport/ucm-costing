import { describe, expect, it } from "vitest";

import type { CostBreakdown } from "./calculator";
import {
  AMENDMENT_ADDITION_FACTOR,
  AMENDMENT_REMOVAL_FACTOR,
  calculateCostAmendment,
  calculateCostAmendmentFromItems,
} from "./amendment";

const zeroBucket = { original: "0", additions: "0", removals: "0" };

describe("2026 cost amendment calculation", () => {
  it("applies the local 105%/95% equation independently by BoX", () => {
    const result = calculateCostAmendment({
      material: { original: "100", additions: "10", removals: "20" },
      process: { original: "20", additions: "2", removals: "1" },
      fastener: zeroBucket,
      tooling: zeroBucket,
    });

    expect(AMENDMENT_ADDITION_FACTOR).toBe("1.05");
    expect(AMENDMENT_REMOVAL_FACTOR).toBe("0.95");
    expect(result.buckets.material).toEqual({
      original: "100",
      additions: "10",
      removals: "20",
      rawRevised: "90",
      amendmentDelta: "-8.5",
      adjustedRevised: "91.5",
    });
    expect(result.buckets.process.amendmentDelta).toBe("1.15");
    expect(result.amendmentDelta).toEqual({
      material: "-8.5",
      process: "1.15",
      fastener: "0",
      tooling: "0",
      total: "-7.35",
    });
    expect(result.rawRevised.total).toBe("111");
    expect(result.adjustedRevised.total).toBe("112.65");
  });

  it("aggregates exact row values before applying factors or display rounding", () => {
    const original: CostBreakdown = {
      material: "1",
      process: "0",
      fastener: "0",
      tooling: "0",
      total: "1",
    };
    const result = calculateCostAmendmentFromItems(original, [
      { kind: "material", action: "add", subtotal: "0.004" },
      { kind: "material", action: "add", subtotal: "0.004" },
      { kind: "material", action: "remove", subtotal: "0.001" },
    ]);

    expect(result.additions.material).toBe("0.008");
    expect(result.buckets.material.amendmentDelta).toBe("0.00745");
    expect(result.buckets.material.adjustedRevised).toBe("1.00745");
  });

  it("rejects negative amounts instead of silently changing their meaning", () => {
    expect(() =>
      calculateCostAmendment({
        material: { original: "100", additions: "-1", removals: "0" },
        process: zeroBucket,
        fastener: zeroBucket,
        tooling: zeroBucket,
      }),
    ).toThrow("material additions must be non-negative");
  });
});
