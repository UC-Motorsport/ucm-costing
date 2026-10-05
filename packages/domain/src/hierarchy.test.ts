import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHILD_KINDS,
  COST_LINE_OWNER_KINDS,
  allowedChildKinds,
  canCreateChild,
  canNodeOwnCostLines,
} from "./hierarchy";
import { nodeKindSchema, type NodeKind } from "./types";

const expectedChildren = {
  vehicle: ["system"],
  system: ["assembly"],
  assembly: ["subassembly", "part"],
  subassembly: ["subassembly", "part"],
  part: [],
} as const satisfies Readonly<Record<NodeKind, readonly NodeKind[]>>;

const hierarchyCases = nodeKindSchema.options.flatMap((parentKind) =>
  nodeKindSchema.options.map(
    (childKind) =>
      [
        parentKind,
        childKind,
        expectedChildren[parentKind].some(
          (expectedKind: NodeKind) => expectedKind === childKind,
        ),
      ] as const,
  ),
);

describe("costing hierarchy policy", () => {
  it("covers every possible parent-child kind pair", () => {
    expect(hierarchyCases).toHaveLength(
      nodeKindSchema.options.length * nodeKindSchema.options.length,
    );
  });

  it.each(hierarchyCases)(
    "allows %s -> %s: %s",
    (parentKind, childKind, expected) => {
      expect(canCreateChild(parentKind, childKind)).toBe(expected);
    },
  );

  it.each(nodeKindSchema.options)(
    "returns the complete allowed child list for %s",
    (parentKind) => {
      expect(allowedChildKinds(parentKind)).toEqual(
        expectedChildren[parentKind],
      );
      expect(ALLOWED_CHILD_KINDS[parentKind]).toEqual(
        expectedChildren[parentKind],
      );
    },
  );
});

describe("cost-line ownership policy", () => {
  it.each([
    ["vehicle", false],
    ["system", false],
    ["assembly", true],
    ["subassembly", true],
    ["part", true],
  ] as const)("allows %s to own cost lines: %s", (nodeKind, expected) => {
    expect(canNodeOwnCostLines(nodeKind)).toBe(expected);
  });

  it("exposes the complete eligible-kind list", () => {
    expect(COST_LINE_OWNER_KINDS).toEqual([
      "assembly",
      "subassembly",
      "part",
    ]);
  });
});
