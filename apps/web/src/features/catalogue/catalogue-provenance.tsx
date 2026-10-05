import { Badge } from "@/components/ui/badge"
import type { CatalogueProvenance } from "@/lib/api"
import { cn } from "@/lib/utils"

const provenanceLabels: Record<CatalogueProvenance, string> = {
  official: "Official",
  edited: "Edited catalogue",
  team: "Team row",
}

const provenanceClasses: Record<CatalogueProvenance, string> = {
  official: "border-slate-300 bg-slate-50 text-slate-700",
  edited: "border-amber-300 bg-amber-50 text-amber-900",
  team: "border-blue-300 bg-blue-50 text-blue-900",
}

export function CatalogueProvenanceBadge({
  provenance,
  revision = 0,
  className,
}: {
  provenance: CatalogueProvenance
  revision?: number
  className?: string
}) {
  const suffix = revision > 0 ? ` · rev ${revision}` : ""
  return (
    <Badge
      variant="outline"
      className={cn(provenanceClasses[provenance], className)}
    >
      {provenanceLabels[provenance]}
      {suffix}
    </Badge>
  )
}
