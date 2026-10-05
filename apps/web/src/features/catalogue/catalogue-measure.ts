import type { CatalogueItem } from "@/lib/api"

const MASS_UNITS = new Set(["kg", "g", "mg", "lb", "lbs", "oz"])
const AREA_UNITS = new Set(["m2", "cm2", "mm2", "in2", "ft2"])
const LENGTH_UNITS = new Set(["m", "cm", "mm", "in", "ft"])
const VOLUME_UNITS = new Set(["m3", "cm3", "mm3", "l", "ml"])
const TIME_UNITS = new Set(["s", "sec", "min", "hr", "h", "hour"])
const COUNT_UNITS = new Set(["each", "ea", "unit", "piece", "pc"])

export function fixedRateAmountLabel(item: CatalogueItem | null): string {
  if (!item || item.fixedCost === null || item.effectiveFormula || !item.unit?.trim()) {
    return "Quantity"
  }
  return `${measureName(item.unit)} (${item.unit})`
}

export function fixedRateAmountDescription(
  item: CatalogueItem | null,
): string | null {
  if (!item || item.fixedCost === null || item.effectiveFormula || !item.unit?.trim()) {
    return null
  }
  return `The catalogue rate is per ${item.unit}; enter the ${measureName(item.unit).toLowerCase()} used.`
}

export function measureName(unit: string): string {
  const normalized = normalizeUnit(unit)
  if (MASS_UNITS.has(normalized)) return "Weight"
  if (AREA_UNITS.has(normalized)) return "Area"
  if (LENGTH_UNITS.has(normalized)) return "Length"
  if (VOLUME_UNITS.has(normalized)) return "Volume"
  if (TIME_UNITS.has(normalized)) return "Time"
  if (COUNT_UNITS.has(normalized)) return "Quantity"
  return "Amount"
}

export function formatFixedRateAmount(
  value: string,
  unit: string | null,
  usesUnitAmount: boolean,
): string {
  return usesUnitAmount && unit?.trim() ? `${value} ${unit}` : value
}

function normalizeUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replaceAll("²", "2")
    .replaceAll("³", "3")
    .replaceAll("^", "")
    .replaceAll(" ", "")
}
