import type { CatalogueItem } from "@/lib/api"

export function catalogueSourceDescription(item: CatalogueItem): string {
  if (item.provenance === "team") {
    return `${item.catalogueId} · Team catalogue`
  }
  const revision = item.revision > 0 ? ` · effective rev ${item.revision}` : ""
  return `#${item.catalogueId} · ${item.sourceSheet} row ${item.sourceRow}${revision}`
}
