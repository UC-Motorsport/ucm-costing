import { describe, expect, it } from "vitest";

import {
  calculateCostLine,
  extendCostBreakdown,
  calculateNodeRollup,
  displayUniversalDollars,
  reconcileReport,
} from "./calculator";

describe("cost calculation", () => {
  it("reproduces the UCM25 fixture tooling amortization", () => {
    const result = calculateCostLine({
      kind: "tooling",
      unitCost: "16500",
      quantity: "0.125",
      fractionIncluded: "1",
      productionVolumeFactor: "3000",
    });
    expect(result.subtotal).toBe("0.6875");
  });

  it("does not assume a 3000 production-volume factor for new tooling", () => {
    expect(() =>
      calculateCostLine({
        kind: "tooling",
        unitCost: "16500",
        quantity: "0.125",
        fractionIncluded: "1",
      }),
    ).toThrow("production volume factor is required for tooling");
  });

  it("applies a process multiplier and quantity exactly", () => {
    const result = calculateCostLine({
      kind: "process",
      unitCost: "0.75",
      quantity: "8",
      multiplier: "1.2",
    });
    expect(result.subtotal).toBe("7.2");
  });

  it("rolls the four BoX buckets up through child quantities", () => {
    const material = calculateCostLine({
      kind: "material",
      unitCost: "8.42",
      quantity: "0.12",
    });
    const result = calculateNodeRollup(
      [material],
      [
        {
          quantity: "2",
          breakdown: {
            material: "1",
            process: "2",
            fastener: "0.5",
            tooling: "0.25",
            total: "3.75",
          },
        },
      ],
    );
    expect(result).toEqual({
      material: "3.0104",
      process: "4",
      fastener: "1",
      tooling: "0.5",
      total: "8.5104",
    });
  });

  it("detects the supplied 2025 summary/BOM reconciliation defect", () => {
    const reconciliation = reconcileReport({
      declared: {
        material: "35608.60",
        process: "0",
        fastener: "0",
        tooling: "0",
        total: "35608.60",
      },
      systems: [
        {
          material: "35614.70",
          process: "0",
          fastener: "0",
          tooling: "0",
          total: "35614.70",
        },
      ],
    });
    expect(reconciliation.reconciled).toBe(false);
    expect(reconciliation.differences.total).toBe("-6.1");
  });

  it("formats competition values as deterministic grouped decimals", () => {
    expect(displayUniversalDollars("35614.7")).toBe("35,614.70");
    expect(displayUniversalDollars("-6.1")).toBe("-6.10");
  });
});

it("extends every category by row quantity without altering the per-instance rollup", () => {
  const unit = {
    material: "1755",
    process: "8.38",
    fastener: "0.21",
    tooling: "0",
    total: "1763.59",
  };
  expect(extendCostBreakdown(unit, "4")).toEqual({
    material: "7020",
    process: "33.52",
    fastener: "0.84",
    tooling: "0",
    total: "7054.36",
  });
  expect(unit.total).toBe("1763.59");
  expect(
    calculateNodeRollup([], [{ quantity: "4", breakdown: unit }]).total,
  ).toBe("7054.36");
  expect(extendCostBreakdown(unit, "1")).toEqual(unit);
  expect(extendCostBreakdown(unit, "0.5").total).toBe("881.795");
});
