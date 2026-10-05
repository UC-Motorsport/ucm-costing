import Decimal from "decimal.js";

import {
  costKinds,
  type CostBreakdown,
  type CostKind,
} from "./calculator";

/**
 * Formula SAE-Australasia 2026 Local Addendum S.3.7 factors.
 *
 * These are rule constants, not user-configurable preferences. In particular,
 * the 125%/75% factors published for other Formula SAE events do not apply.
 */
export const AMENDMENT_ADDITION_FACTOR = "1.05";
export const AMENDMENT_REMOVAL_FACTOR = "0.95";

export interface AmendmentBucketInput {
  original: Decimal.Value;
  additions: Decimal.Value;
  removals: Decimal.Value;
}

export interface AmendmentBucketResult {
  original: string;
  additions: string;
  removals: string;
  /** Original + additions - removals, before the S.3.7 adjustment. */
  rawRevised: string;
  /** 1.05 × additions - 0.95 × removals. */
  amendmentDelta: string;
  /** Original + amendmentDelta. */
  adjustedRevised: string;
}

export type AmendmentBoXInput = Record<CostKind, AmendmentBucketInput>;
export type AmendmentBoXResult = Record<CostKind, AmendmentBucketResult>;

export interface CostAmendmentResult {
  buckets: AmendmentBoXResult;
  original: CostBreakdown;
  additions: CostBreakdown;
  removals: CostBreakdown;
  rawRevised: CostBreakdown;
  amendmentDelta: CostBreakdown;
  adjustedRevised: CostBreakdown;
}

export interface AmendmentItemInput {
  kind: CostKind;
  action: "add" | "remove";
  subtotal: Decimal.Value;
}

/**
 * Calculates the rule-published amendment equation independently for each
 * Material, Process, Fastener, and Tooling bucket. Values remain exact decimal
 * strings; callers round only when formatting a display or document cell.
 */
export function calculateCostAmendment(
  input: AmendmentBoXInput,
): CostAmendmentResult {
  const buckets = {} as AmendmentBoXResult;

  for (const kind of costKinds) {
    const values = input[kind];
    if (!values) {
      throw new Error(`${kind} amendment bucket is required`);
    }
    const original = nonNegative(values.original, `${kind} original`);
    const additions = nonNegative(values.additions, `${kind} additions`);
    const removals = nonNegative(values.removals, `${kind} removals`);
    const rawRevised = original.plus(additions).minus(removals);
    const amendmentDelta = additions
      .times(AMENDMENT_ADDITION_FACTOR)
      .minus(removals.times(AMENDMENT_REMOVAL_FACTOR));
    const adjustedRevised = original.plus(amendmentDelta);

    buckets[kind] = {
      original: canonical(original),
      additions: canonical(additions),
      removals: canonical(removals),
      rawRevised: canonical(rawRevised),
      amendmentDelta: canonical(amendmentDelta),
      adjustedRevised: canonical(adjustedRevised),
    };
  }

  return {
    buckets,
    original: breakdown(buckets, "original"),
    additions: breakdown(buckets, "additions"),
    removals: breakdown(buckets, "removals"),
    rawRevised: breakdown(buckets, "rawRevised"),
    amendmentDelta: breakdown(buckets, "amendmentDelta"),
    adjustedRevised: breakdown(buckets, "adjustedRevised"),
  };
}

/**
 * Groups amendment rows into their BoX buckets before applying the rule
 * factors. This prevents per-row display rounding from changing the result.
 */
export function calculateCostAmendmentFromItems(
  original: CostBreakdown,
  items: readonly AmendmentItemInput[],
): CostAmendmentResult {
  const additions = zeroBuckets();
  const removals = zeroBuckets();

  for (const [index, item] of items.entries()) {
    if (!costKinds.includes(item.kind)) {
      throw new Error(`amendment item ${index} has an invalid cost kind`);
    }
    const subtotal = nonNegative(
      item.subtotal,
      `amendment item ${index} subtotal`,
    );
    const target = item.action === "add" ? additions : removals;
    if (item.action !== "add" && item.action !== "remove") {
      throw new Error(`amendment item ${index} has an invalid action`);
    }
    target[item.kind] = target[item.kind].plus(subtotal);
  }

  return calculateCostAmendment(
    Object.fromEntries(
      costKinds.map((kind) => [
        kind,
        {
          original: original[kind],
          additions: additions[kind],
          removals: removals[kind],
        },
      ]),
    ) as AmendmentBoXInput,
  );
}

function breakdown(
  buckets: AmendmentBoXResult,
  field: keyof AmendmentBucketResult,
): CostBreakdown {
  const values = Object.fromEntries(
    costKinds.map((kind) => [kind, buckets[kind][field]]),
  ) as Record<CostKind, string>;
  const total = costKinds.reduce(
    (sum, kind) => sum.plus(values[kind]),
    new Decimal(0),
  );
  return { ...values, total: canonical(total) };
}

function zeroBuckets(): Record<CostKind, Decimal> {
  return {
    material: new Decimal(0),
    process: new Decimal(0),
    fastener: new Decimal(0),
    tooling: new Decimal(0),
  };
}

function nonNegative(value: Decimal.Value, field: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new Error(`${field} must be a finite decimal`);
  }
  if (!parsed.isFinite()) {
    throw new Error(`${field} must be a finite decimal`);
  }
  if (parsed.isNegative()) {
    throw new Error(`${field} must be non-negative`);
  }
  return parsed;
}

function canonical(value: Decimal): string {
  return value.toSignificantDigits(24).toString();
}
