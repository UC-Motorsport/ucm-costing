import { useId, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { catalogueSourceDescription } from "./catalogue-source"

import { stockSizeDimensions } from "./stock-size-dimensions"

export function StockSizePicker({ releaseId, value, onChange }: {
  releaseId: string
  value: string
  onChange: (id: string) => void
}) {
  const id = useId()
  const [search, setSearch] = useState("")
  const results = useQuery({
    queryKey: ["catalogue", releaseId, "stock-size", search, 100],
    queryFn: () => api.catalogue(releaseId, "stock-size", search, 100),
  })
  const exact = useQuery({
    queryKey: ["catalogue-item", releaseId, value],
    queryFn: () => api.catalogueItem(releaseId, value),
    enabled: Boolean(value),
  })
  return <section aria-label="Stock size selection" className="space-y-2 rounded-lg border p-3">
    <label htmlFor={id} className="text-sm font-medium">Stock profile</label>
    <p className="text-xs text-muted-foreground">Choose the stock dimensions, then select the material price below. Stock profiles do not add a separate charge.</p>
    <Input id={id} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search stock sizes" />
    {results.isError ? <QueryError error={results.error} onRetry={() => results.refetch()} compact /> : (
      <div className="max-h-36 overflow-y-auto divide-y rounded border" aria-label="Stock size results">
        {results.isLoading ? <p className="p-2 text-sm">Loading stock sizes…</p> : results.data?.items.length ? results.data.items.map((item) => (
          <button type="button" key={item.id} aria-pressed={value === item.id}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-muted aria-pressed:bg-primary/10"
            onClick={() => onChange(item.id)}>
            <span className="block font-medium">{item.name}</span>
            <span className="block text-xs text-muted-foreground">{stockSizeDimensions(item)}</span>
          </button>
        )) : <p className="p-2 text-sm">No matching stock sizes.</p>}
      </div>
    )}
    {exact.isError && <QueryError error={exact.error} onRetry={() => exact.refetch()} compact />}
    {exact.data && <div className="text-xs" aria-label="Selected stock size">
      <p className="font-medium">Selected: {exact.data.item.name}</p>
      <p>{stockSizeDimensions(exact.data.item)}</p>
      <p className="text-muted-foreground">{catalogueSourceDescription(exact.data.item)}</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>Clear stock size</Button>
    </div>}
  </section>
}
