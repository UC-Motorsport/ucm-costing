import { recordedMeasurements } from "./recorded-measurements"
import { useId, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ArrowLeft, ChevronRight, LoaderCircle, Search } from "lucide-react"
import { toast } from "sonner"

import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  api,
  universal,
  type CostNode,
  type HistoricalCostSource,
} from "@/lib/api"

export function Import2025CostLineDialog({
  node,
  onSaved,
}: {
  node: CostNode
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Search data-icon="inline-start" />
        Import 2025
      </Button>
      {open && (
        <ImportContent
          key={node.id}
          node={node}
          onSaved={onSaved}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  )
}

function ImportContent({
  node,
  onSaved,
  onClose,
}: {
  node: CostNode
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const searchId = useId()
  const [search, setSearch] = useState("")
  const [source, setSource] = useState<HistoricalCostSource | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const sources = useQuery({
    queryKey: ["historical-cost-sources", node.id, search],
    queryFn: () => api.searchHistoricalCostSources(node.id, search),
    enabled: !source,
  })
  const costs = useQuery({
    queryKey: ["historical-source-costs", node.id, source?.id],
    queryFn: () => api.historicalSourceCosts(node.id, source!.id),
    enabled: Boolean(source),
  })
  const rows = costs.data?.items ?? []
  const selected = rows.filter((row) => selectedIds.has(row.id))
  const total = selected.reduce((sum, row) => sum + Number(row.subtotal), 0)
  const importRows = useMutation({
    mutationFn: () =>
      api.importHistoricalCostLines(
        node.id,
        source!.id,
        selected.map((row) => row.id),
      ),
    onSuccess: async (result) => {
      toast.success(
        `${result.results.length} cost ${result.results.length === 1 ? "row" : "rows"} imported from 2025`,
        {
          description: result.warnings.length
            ? "Review the imported rows’ catalogue links before submission."
            : undefined,
        },
      )
      onClose()
      await onSaved()
    },
    onError: (error) => toast.error(error.message),
  })
  const busy = importRows.isPending
  const allSelected = rows.length > 0 && selected.length === rows.length
  const query = source ? costs : sources

  return (
    <DialogContent
      className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden sm:max-w-3xl"
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault()
      }}
      showCloseButton={!busy}
    >
      <DialogHeader>
        <DialogTitle>Import 2025 costs</DialogTitle>
        <DialogDescription>
          {source
            ? `Choose the cost rows to add to ${node.name}.`
            : `Find a 2025 part or assembly to reuse its costs in ${node.name}.`}
        </DialogDescription>
      </DialogHeader>

      {!source ? (
        <>
          <div className="space-y-2">
            <label htmlFor={searchId} className="text-sm font-medium">
              Search 2025 parts and assemblies
            </label>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id={searchId}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or controlled number"
                className="pl-9"
                autoComplete="off"
              />
            </div>
          </div>
          <div
            className="min-h-0 overflow-y-auto rounded-lg border"
            aria-label="2025 parts and assemblies"
          >
            {sources.isLoading ? (
              <LoadingRows />
            ) : sources.isError ? null : !sources.data?.sourceProject ? (
              <Empty>No 2025 historical workspace is available.</Empty>
            ) : sources.data.items.length === 0 ? (
              <Empty>
                No matching parts or assemblies with costs. Try another name or
                controlled number.
              </Empty>
            ) : (
              sources.data.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                  onClick={() => {
                    setSource(item)
                    setSelectedIds(new Set())
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      <Badge variant="secondary">{item.kind}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {item.fullNumber || "No controlled number"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {item.rowCount} {item.rowCount === 1 ? "row" : "rows"}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))
            )}
          </div>
          {sources.data?.hasMore && (
            <p className="text-xs text-muted-foreground">
              Showing the first 50 matches. Refine your search to find more.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Assembly costs include rows from their child items.
          </p>
        </>
      ) : (
        <>
          <div className="space-y-3">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2"
              disabled={busy}
              onClick={() => {
                setSource(null)
                setSelectedIds(new Set())
              }}
            >
              <ArrowLeft />
              Change source
            </Button>
            <div className="rounded-lg border bg-muted/25 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{source.name}</span>
                <Badge variant="outline">2025 · {source.kind}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.fullNumber}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Copies selected cost inputs into {node.name}. Child quantities
                and the assembly structure are not copied.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={allSelected}
                ref={(element) => {
                  if (element)
                    element.indeterminate = selected.length > 0 && !allSelected
                }}
                disabled={
                  busy || costs.isFetching || costs.isError || !rows.length
                }
                onChange={(event) =>
                  setSelectedIds(
                    new Set(
                      event.target.checked ? rows.map((row) => row.id) : [],
                    ),
                  )
                }
              />
              Select all
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || selected.length === 0}
              onClick={() => setSelectedIds(new Set())}
            >
              Clear selection
            </Button>
          </div>
          <div
            className="min-h-0 overflow-y-auto rounded-lg border"
            aria-label="2025 source cost rows"
          >
            {costs.isLoading ? (
              <LoadingRows />
            ) : costs.isError ? null : rows.length === 0 ? (
              <Empty>This item has no cost rows.</Empty>
            ) : (
              rows.map((row) => (
                <label
                  key={row.id}
                  className="flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40 has-checked:bg-primary/5"
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={selectedIds.has(row.id)}
                    disabled={busy}
                    aria-label={`Select ${row.description} from ${row.sourceNodeName}`}
                    onChange={(event) =>
                      setSelectedIds((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(row.id)
                        else next.delete(row.id)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {row.description}
                      </span>
                      <Badge variant="secondary">{row.kind}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {row.sourceNodeName}
                      {row.sourceNodeNumber ? ` · ${row.sourceNodeNumber}` : ""}
                    </span>
                    {row.useDescription && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {row.useDescription}
                      </span>
                    )}
                    <span className="mt-2 block text-sm font-medium">
                      {recordedMeasurements(row.sizeInputs ?? {}).map(({ key, label, value, unit }) => (
                        <span key={key} className="mr-3 inline-block">{label}: {value}{unit ? ` ${unit}` : " (unit not recorded)"}</span>
                      ))}
                      <span className="inline-block">Quantity: {row.quantity}</span>
                    </span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      U$ {universal(row.unitCost)} × {row.quantity}
                      {row.kind === "tooling"
                        ? ` × ${row.fractionIncluded} ÷ ${row.productionVolumeFactor ?? "—"}`
                        : ` × ${row.multiplier}`}
                      {row.unit ? ` · ${row.unit}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">
                    U$ {universal(row.subtotal)}
                  </span>
                </label>
              ))
            )}
          </div>
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-4 py-3"
            aria-live="polite"
          >
            <span className="text-sm">
              {selected.length} of {rows.length} rows selected
            </span>
            <span className="font-mono text-base font-semibold tabular-nums">
              U$ {universal(total)}
            </span>
          </div>
          {selected.some(
            (row) => !row.catalogueItemId && row.kind !== "tooling",
          ) && (
            <p className="text-xs text-muted-foreground">
              Some selected rows have no catalogue link. Their stored values
              will import for you to review.
            </p>
          )}
          {selected.length > 1000 && (
            <p role="alert" className="text-sm text-destructive">
              Select up to 1,000 rows per import.
            </p>
          )}
        </>
      )}
      {query.isError && (
        <QueryError
          error={query.error}
          title="Could not load 2025 costs"
          onRetry={() => query.refetch()}
          isRetrying={query.isFetching}
          compact
        />
      )}
      <DialogFooter className="border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        {source && (
          <Button
            type="button"
            onClick={() => importRows.mutate()}
            disabled={
              !selected.length ||
              selected.length > 1000 ||
              busy ||
              costs.isFetching ||
              costs.isError
            }
          >
            {busy && <LoaderCircle className="animate-spin" />}
            Import {selected.length || "selected"}{" "}
            {selected.length === 1 ? "row" : "rows"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-3">
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>
  )
}
