import {
  calculateCostLine,
  calculateNodeRollup,
  displayUniversalDollars,
} from "@ucm/domain";
import { describe, expect, it } from "vitest";

describe("hand-calculated hypothetical assembly costs", () => {
  it("preserves exact Universal $ totals from cost lines through the system rollup", () => {
    // Hand calculation for one machined bracket:
    // material:  U$12.50 x 0.8 x 1.0       = U$10.00
    // process:   U$2.75  x 4   x 1.2       = U$13.20
    // fasteners: U$0.45  x 6   x 1.5       = U$4.05
    // tooling:   U$1,200 x 1 x 0.25 / 500  = U$0.60
    // part total:                              U$27.85
    const bracketLines = [
      calculateCostLine({
        kind: "material",
        unitCost: "12.50",
        quantity: "0.8",
        multiplier: "1",
      }),
      calculateCostLine({
        kind: "process",
        unitCost: "2.75",
        quantity: "4",
        multiplier: "1.2",
      }),
      calculateCostLine({
        kind: "fastener",
        unitCost: "0.45",
        quantity: "6",
        multiplier: "1.5",
      }),
      calculateCostLine({
        kind: "tooling",
        unitCost: "1200",
        quantity: "1",
        fractionIncluded: "0.25",
        productionVolumeFactor: "500",
      }),
    ];
    expect(bracketLines.map(({ subtotal }) => subtotal)).toEqual([
      "10",
      "13.2",
      "4.05",
      "0.6",
    ]);
    const bracket = calculateNodeRollup(bracketLines);
    expect(bracket).toEqual({
      material: "10",
      process: "13.2",
      fastener: "4.05",
      tooling: "0.6",
      total: "27.85",
    });

    // One spacer is U$3.60 x 1.5 + U$1.25 x 2 = U$7.90.
    const spacer = calculateNodeRollup([
      calculateCostLine({
        kind: "material",
        unitCost: "3.60",
        quantity: "1.5",
        multiplier: "1",
      }),
      calculateCostLine({
        kind: "process",
        unitCost: "1.25",
        quantity: "2",
        multiplier: "1",
      }),
    ]);
    expect(spacer).toEqual({
      material: "5.4",
      process: "2.5",
      fastener: "0",
      tooling: "0",
      total: "7.9",
    });

    // The subassembly contains two brackets and three spacers, then adds
    // U$8.00 of assembly process and U$1.20 of assembly fasteners.
    const subassembly = calculateNodeRollup(
      [
        calculateCostLine({
          kind: "process",
          unitCost: "8",
          quantity: "1",
          multiplier: "1",
        }),
        calculateCostLine({
          kind: "fastener",
          unitCost: "0.30",
          quantity: "4",
          multiplier: "1",
        }),
      ],
      [
        { quantity: "2", breakdown: bracket },
        { quantity: "3", breakdown: spacer },
      ],
    );
    expect(subassembly).toEqual({
      material: "36.2",
      process: "41.9",
      fastener: "9.3",
      tooling: "1.2",
      total: "88.6",
    });

    const sensor = calculateNodeRollup([
      calculateCostLine({
        kind: "material",
        unitCost: "18.75",
        quantity: "1",
        multiplier: "1",
      }),
    ]);

    // The parent assembly contains two subassemblies and four sensors, and
    // adds U$5.00 x 1.1 = U$5.50 of its own final-assembly process.
    const assembly = calculateNodeRollup(
      [
        calculateCostLine({
          kind: "process",
          unitCost: "5",
          quantity: "1",
          multiplier: "1.1",
        }),
      ],
      [
        { quantity: "2", breakdown: subassembly },
        { quantity: "4", breakdown: sensor },
      ],
    );
    expect(assembly).toEqual({
      material: "147.4",
      process: "89.3",
      fastener: "18.6",
      tooling: "2.4",
      total: "257.7",
    });

    const system = calculateNodeRollup([], [
      { quantity: "2", breakdown: assembly },
    ]);
    expect(system).toEqual({
      material: "294.8",
      process: "178.6",
      fastener: "37.2",
      tooling: "4.8",
      total: "515.4",
    });
    expect(displayUniversalDollars(system.total)).toBe("515.40");
  });

  it("rounds only the final displayed Universal $ amount, half up", () => {
    expect(displayUniversalDollars("257.7049")).toBe("257.70");
    expect(displayUniversalDollars("257.705")).toBe("257.71");
  });
});
