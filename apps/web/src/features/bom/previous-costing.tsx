import { type CostLine, universal } from "@/lib/api"
import { recordedMeasurements } from "./recorded-measurements"

export function PreviousCosting({ line }: { line: CostLine }) {
  let inputs: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(line.size_inputs_json)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputs = parsed
  } catch { /* Older rows can have no usable measurements. */ }
  const measurements = recordedMeasurements(inputs)
  return <section aria-label="Previous costing" className="rounded-lg border bg-muted/30 p-3 text-sm">
    <h3 className="font-medium">Previous costing</h3>
    <p className="mt-1 text-muted-foreground">{line.description} · {line.use_description}</p>
    <p className="mt-1">Quantity {line.quantity} · Unit cost U$ {universal(line.unit_cost)} · Subtotal U$ {universal(line.subtotal)}</p>
    <p className="mt-1 text-muted-foreground">Multiplier {line.multiplier}{line.kind === "tooling" ? ` · Fraction ${line.fraction_included} · PVF ${line.production_volume_factor}` : ""}</p>
    {measurements.map(({ key, label, value, unit }) => (
      <p key={key} className="mt-1 font-medium">{label}{unit ? ` (${unit})` : ""}: {value}{!unit && " (unit not recorded)"}</p>
    ))}
    {!measurements.length && <p className="mt-1 text-muted-foreground">Previous mass / dimensions were not recorded. Enter the required measurements to recalculate.</p>}
  </section>
}
