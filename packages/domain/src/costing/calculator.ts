import Decimal from "decimal.js";

export const costKinds = [
  "material",
  "process",
  "fastener",
  "tooling",
] as const;

export type CostKind = (typeof costKinds)[number];

export interface CostBreakdown {
  material: string;
  process: string;
  fastener: string;
  tooling: string;
  total: string;
}

export interface CostLineInput {
  kind: CostKind;
  unitCost: Decimal.Value;
  quantity: Decimal.Value;
  multiplier?: Decimal.Value;
  fractionIncluded?: Decimal.Value;
  productionVolumeFactor?: Decimal.Value;
}

export interface CostLineResult {
  kind: CostKind;
  unitCost: string;
  quantity: string;
  multiplier: string;
  fractionIncluded: string;
  productionVolumeFactor: string | null;
  subtotal: string;
}

export interface ChildRollup {
  quantity: Decimal.Value;
  breakdown: CostBreakdown;
}

export interface ReconciliationInput {
  declared: CostBreakdown;
  systems: CostBreakdown[];
}

export interface ReconciliationResult {
  reconciled: boolean;
  declared: CostBreakdown;
  calculated: CostBreakdown;
  differences: CostBreakdown;
}

export function calculateCostLine(input: CostLineInput): CostLineResult {
  const unitCost = decimal(input.unitCost, "unit cost");
  const quantity = decimal(input.quantity, "quantity");
  const multiplier = decimal(input.multiplier ?? 1, "multiplier");
  const fractionIncluded = decimal(
    input.fractionIncluded ?? 1,
    "fraction included",
  );

  assertNonNegative(unitCost, "unit cost");
  assertNonNegative(quantity, "quantity");
  assertNonNegative(multiplier, "multiplier");
  assertNonNegative(fractionIncluded, "fraction included");

  let subtotal: Decimal;
  let productionVolumeFactor: Decimal | null = null;

  if (input.kind === "tooling") {
    if (input.productionVolumeFactor === undefined) {
      throw new Error("production volume factor is required for tooling");
    }
    productionVolumeFactor = decimal(
      input.productionVolumeFactor,
      "production volume factor",
    );
    if (productionVolumeFactor.lessThanOrEqualTo(0)) {
      throw new Error("production volume factor must be greater than zero");
    }
    subtotal = unitCost
      .times(quantity)
      .times(fractionIncluded)
      .dividedBy(productionVolumeFactor);
  } else {
    subtotal = unitCost.times(quantity).times(multiplier);
  }

  return {
    kind: input.kind,
    unitCost: canonical(unitCost),
    quantity: canonical(quantity),
    multiplier: canonical(multiplier),
    fractionIncluded: canonical(fractionIncluded),
    productionVolumeFactor: productionVolumeFactor
      ? canonical(productionVolumeFactor)
      : null,
    subtotal: canonical(subtotal),
  };
}

export function calculateNodeRollup(
  ownLines: CostLineResult[],
  children: ChildRollup[] = [],
): CostBreakdown {
  const buckets = emptyDecimalBreakdown();

  for (const line of ownLines) {
    buckets[line.kind] = buckets[line.kind].plus(line.subtotal);
  }

  for (const child of children) {
    const quantity = decimal(child.quantity, "child quantity");
    assertNonNegative(quantity, "child quantity");
    for (const kind of costKinds) {
      buckets[kind] = buckets[kind].plus(
        decimal(child.breakdown[kind], `${kind} child total`).times(quantity),
      );
    }
  }

  return serializeBreakdown(buckets);
}

export function sumBreakdowns(breakdowns: CostBreakdown[]): CostBreakdown {
  const buckets = emptyDecimalBreakdown();
  for (const breakdown of breakdowns) {
    for (const kind of costKinds) {
      buckets[kind] = buckets[kind].plus(
        decimal(breakdown[kind], `${kind} total`),
      );
    }
  }
  return serializeBreakdown(buckets);
}

/** Extend a per-instance breakdown by the quantity shown on a BOM row. */
export function extendCostBreakdown(
  breakdown: CostBreakdown,
  quantity: Decimal.Value,
): CostBreakdown {
  return calculateNodeRollup([], [{ breakdown, quantity }]);
}

export function reconcileReport(
  input: ReconciliationInput,
): ReconciliationResult {
  const calculated = sumBreakdowns(input.systems);
  const differences = emptyDecimalBreakdown();

  for (const kind of costKinds) {
    differences[kind] = decimal(
      input.declared[kind],
      `${kind} declared`,
    ).minus(calculated[kind]);
  }
  const declaredTotal = decimal(input.declared.total, "declared total");
  const calculatedTotal = decimal(calculated.total, "calculated total");
  differences.total = declaredTotal.minus(calculatedTotal);

  const serializedDifferences = serializeBreakdown(differences, false);
  return {
    reconciled: Object.values(serializedDifferences).every(
      (difference) => new Decimal(difference).abs().lessThan("0.005"),
    ),
    declared: input.declared,
    calculated,
    differences: serializedDifferences,
  };
}

export function displayUniversalDollars(value: Decimal.Value): string {
  const fixed = new Decimal(value)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const sign = whole!.startsWith("-") ? "-" : "";
  const digits = sign ? whole!.slice(1) : whole!;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function emptyDecimalBreakdown(): Record<keyof CostBreakdown, Decimal> {
  return {
    material: new Decimal(0),
    process: new Decimal(0),
    fastener: new Decimal(0),
    tooling: new Decimal(0),
    total: new Decimal(0),
  };
}

function serializeBreakdown(
  buckets: Record<keyof CostBreakdown, Decimal>,
  recomputeTotal = true,
): CostBreakdown {
  const total = recomputeTotal
    ? costKinds.reduce((sum, kind) => sum.plus(buckets[kind]), new Decimal(0))
    : buckets.total;
  return {
    material: canonical(buckets.material),
    process: canonical(buckets.process),
    fastener: canonical(buckets.fastener),
    tooling: canonical(buckets.tooling),
    total: canonical(total),
  };
}

function decimal(value: Decimal.Value, field: string): Decimal {
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) {
      throw new Error();
    }
    return result;
  } catch {
    throw new Error(`${field} must be a finite decimal`);
  }
}

function assertNonNegative(value: Decimal, field: string): void {
  if (value.isNegative()) {
    throw new Error(`${field} must be non-negative`);
  }
}

function canonical(value: Decimal): string {
  return value.toSignificantDigits(24).toString();
}
