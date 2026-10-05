import type { CatalogueItem } from "@/lib/api"

export function stockSizeDimensions(item: CatalogueItem): string {
  return ["size1", "size2", "size3", "size4", "sizea", "sizeb"].flatMap((key) => {
    const value = item.metadata[key]
    if (value === null || value === undefined || value === "") return []
    const unit = item.metadata[`${key}unit`] ?? ""
    const label = key === "sizea" ? "Stock A" : key === "sizeb" ? "Stock B" : key.replace("size", "Size ")
    return [`${label}: ${value} ${unit}`.trim()]
  }).join(" · ")
}
