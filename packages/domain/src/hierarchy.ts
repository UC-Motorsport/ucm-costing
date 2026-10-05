import type { NodeKind } from "./types";

/**
 * The only parent-child relationships permitted in the costing hierarchy.
 *
 * Keep this policy in the domain package so API validation and UI affordances
 * cannot drift apart.
 */
export const ALLOWED_CHILD_KINDS = {
  vehicle: ["system"],
  system: ["assembly"],
  assembly: ["subassembly", "part"],
  subassembly: ["subassembly", "part"],
  part: [],
} as const satisfies Readonly<Record<NodeKind, readonly NodeKind[]>>;

export type AllowedChildKind<ParentKind extends NodeKind> =
  (typeof ALLOWED_CHILD_KINDS)[ParentKind][number];

export function allowedChildKinds<ParentKind extends NodeKind>(
  parentKind: ParentKind,
): readonly AllowedChildKind<ParentKind>[] {
  return ALLOWED_CHILD_KINDS[parentKind];
}

export function canCreateChild<ParentKind extends NodeKind>(
  parentKind: ParentKind,
  childKind: NodeKind,
): childKind is AllowedChildKind<ParentKind> {
  return (ALLOWED_CHILD_KINDS[parentKind] as readonly NodeKind[]).includes(
    childKind,
  );
}

export const COST_LINE_OWNER_KINDS = [
  "assembly",
  "subassembly",
  "part",
] as const satisfies readonly NodeKind[];

export type CostLineOwnerKind = (typeof COST_LINE_OWNER_KINDS)[number];

export function canNodeOwnCostLines(
  nodeKind: NodeKind,
): nodeKind is CostLineOwnerKind {
  return (COST_LINE_OWNER_KINDS as readonly NodeKind[]).includes(nodeKind);
}

/** @deprecated Prefer canNodeOwnCostLines for a self-describing call site. */
export const canOwnCostLines = canNodeOwnCostLines;
