import type { Evidence } from "@/lib/api"

const labels: Record<Evidence["kind"], string> = {
  drawing: "Technical drawing",
  image: "Isometric image",
  datasheet: "Component datasheet",
  manufacturing: "Manufacturing proof",
  "bulk-deviation": "Bulk-method deviation",
  other: "Other evidence",
}

export function evidenceKindLabel(kind: Evidence["kind"]): string {
  return labels[kind]
}
