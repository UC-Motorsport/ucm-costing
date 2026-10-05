import { measureName } from "../catalogue/catalogue-measure"

export function recordedMeasurements(inputs: Record<string, unknown>) {
  return Object.entries(inputs).flatMap(([key, value]) => {
    if (!/^(size[1-4]|area|length|density)$/i.test(key) ||
      !(typeof value === "string" || typeof value === "number") || !String(value).trim()) return []
    const unitValue = inputs[`${key}Unit`] ?? inputs[`${key}unit`] ?? inputs[key.replace(/^size/i, "unit")]
    const unit = typeof unitValue === "string" ? unitValue.trim() : ""
    const name = unit ? measureName(unit) : "Amount"
    const fallback = key.replace(/(\d)/, " $1").replace(/^./, first => first.toUpperCase())
    const label = key.toLowerCase() === "density" ? "Density" : name === "Weight" ? "Mass" : name === "Amount" ? fallback : name
    return [{ key, label, value: String(value), unit }]
  })
}
