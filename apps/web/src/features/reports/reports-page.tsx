import { useMemo, useState, type ReactNode } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Columns3,
  Download,
  FileDown,
  LoaderCircle,
  Search,
  TableProperties,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { QueryError } from "@/components/query-error"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  api,
  universal,
  type CostBreakdown,
  type CostNode,
  type ProjectDetail,
  type ProjectSummary,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const costKinds = ["material", "process", "fastener", "tooling"] as const
const reportSystemNames: Record<string, string> = {
  BR: "Brake System",
  DR: "Engine/Tractive Path and Drivetrain",
  CH: "Chassis",
  AD: "Aerodynamics",
  EL: "Electrical System",
  MS: "Miscellaneous, Fit, and Finish",
  ST: "Steering System",
  SU: "Suspension",
  WT: "Wheels & Tires",
  AV: "Autonomous Systems",
}

type ChangeStatus = "added" | "removed" | "changed" | "unchanged"

interface OutputRow {
  key: string
  lineNumber: number
  node: CostNode
  systemName: string
  direct: CostBreakdown
  extendedCost: number
}

interface ComparisonRow {
  key: string
  current: OutputRow | null
  previous: OutputRow | null
  status: ChangeStatus
}

export function ReportsPage({
  detail,
  canWrite,
}: {
  detail: ProjectDetail
  canWrite: boolean
}) {
  const [compare, setCompare] = useState(false)
  const [changesOnly, setChangesOnly] = useState(false)
  const [search, setSearch] = useState("")

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  })
  const historicalProject = useMemo(
    () => nearestHistoricalProject(projects.data?.projects ?? [], detail.project),
    [detail.project, projects.data?.projects],
  )
  const historicalDetail = useQuery({
    queryKey: ["workspace", historicalProject?.id],
    queryFn: () => api.project(historicalProject!.id),
    enabled: Boolean(historicalProject),
  })

  const currentRows = useMemo(() => outputRows(detail), [detail])
  const previousRows = useMemo(
    () => historicalDetail.data ? outputRows(historicalDetail.data) : [],
    [historicalDetail.data],
  )
  const comparisonRows = useMemo(
    () => compareRows(currentRows, previousRows, historicalDetail.isSuccess),
    [currentRows, historicalDetail.isSuccess, previousRows],
  )
  const modeRows = useMemo(
    () => compare ? comparisonRows : compareRows(currentRows, [], false),
    [compare, comparisonRows, currentRows],
  )
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return modeRows.filter((row) => {
      if (compare && changesOnly && row.status === "unchanged") return false
      if (!query) return true
      const node = row.current?.node ?? row.previous?.node
      return node
        ? [
            node.full_number,
            node.reference_id,
            node.raw_hla,
            node.raw_subassembly,
            node.raw_part_number,
            node.name,
            node.description,
            node.system_code,
          ].some((value) => value?.toLocaleLowerCase().includes(query))
        : false
    })
  }, [changesOnly, compare, modeRows, search])

  const create = useMutation({
    mutationFn: () => api.createReport(detail.project.id, "export"),
    onSuccess: ({ report }) => {
      if (!report.downloadUrl) {
        toast.error("The report was created, but its download is unavailable")
        return
      }
      downloadFile(report.downloadUrl)
      toast.success("Full report exported")
    },
    onError: showReportMutationError,
  })

  const currentTotal = reportTotal(detail)
  const previousTotal = historicalDetail.data
    ? reportTotal(historicalDetail.data)
    : null
  const totalDelta = previousTotal === null ? null : currentTotal - previousTotal
  const changedCount = comparisonRows.filter(
    (row) => row.status !== "unchanged",
  ).length

  return (
    <section className="space-y-5" aria-labelledby="report-output-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Report output
          </div>
          <h2 id="report-output-heading" className="mt-1 text-2xl font-semibold">
            Master bill of materials
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Preview the exact master-table columns before export, or compare the
            live workspace with the most recent historical final.
          </p>
        </div>
        <Button
          size="lg"
          onClick={() => create.mutate()}
          disabled={create.isPending || !canWrite}
        >
          {create.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Download />
          )}
          {create.isPending ? "Exporting…" : "Export full report"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <SummaryMetric
            label={`${detail.project.season} live total`}
            value={`U$ ${universal(currentTotal)}`}
            detail={`${currentRows.length} output rows`}
          />
          <SummaryMetric
            label={historicalProject
              ? `${historicalProject.season} final total`
              : "Historical final"}
            value={previousTotal === null ? "—" : `U$ ${universal(previousTotal)}`}
            detail={historicalProject
              ? historicalDetail.isLoading
                ? "Loading comparison…"
                : `${previousRows.length || "No"} reference rows`
              : "Import a historical workspace to compare"}
          />
          <SummaryMetric
            label="Change from final"
            value={totalDelta === null ? "—" : signedMoney(totalDelta)}
            detail={totalDelta === null
              ? "Turn on comparison to calculate"
              : `${changedCount} changed, added, or removed rows`}
            trend={totalDelta}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="flex h-8 items-center rounded-md bg-muted p-[3px]">
            <button
              type="button"
              className={cn(
                "flex h-[26px] items-center gap-1.5 rounded px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                !compare
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={!compare}
              onClick={() => {
                setCompare(false)
                setChangesOnly(false)
              }}
            >
              <TableProperties className="size-3.5" />
              {detail.project.season} output
            </button>
            <button
              type="button"
              className={cn(
                "flex h-[26px] items-center gap-1.5 rounded px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                compare
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={compare}
              disabled={!historicalProject}
              title={historicalProject
                ? `Compare with ${historicalProject.season} final`
                : "Import a historical workspace to enable comparison"}
              onClick={() => setCompare(true)}
            >
              <Columns3 className="size-3.5" />
              {historicalProject
                ? `Compare with ${historicalProject.season} final`
                : "No historical final"}
            </button>
          </div>

          <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search number or description"
              aria-label="Search report output"
              className="pl-9"
            />
          </div>

          {compare && (
            <Button
              variant={changesOnly ? "secondary" : "outline"}
              aria-pressed={changesOnly}
              onClick={() => setChangesOnly((current) => !current)}
            >
              {changesOnly && <Check />}
              Changes only
              <Badge variant="outline" className="ml-1 rounded">
                {changedCount}
              </Badge>
            </Button>
          )}

          <Badge variant="outline" className="ml-auto h-6 rounded-md px-2">
            Live preview
          </Badge>
        </div>

        {historicalDetail.isError && compare ? (
          <div className="p-5">
            <QueryError
              error={historicalDetail.error}
              title="Could not load the historical final"
              onRetry={() => historicalDetail.refetch()}
              isRetrying={historicalDetail.isFetching}
            />
          </div>
        ) : (
          <ReportOutputTable
            rows={visibleRows}
            compare={compare}
            loadingComparison={compare && historicalDetail.isLoading}
            currentSeason={detail.project.season}
            previousSeason={historicalProject?.season ?? null}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <span>
            Showing {visibleRows.length} of {modeRows.length} rows
            {compare && historicalProject
              ? ` · matched by controlled part identity against ${historicalProject.season}`
              : ""}
          </span>
          <span>Cost-table page references are assigned during PDF pagination.</span>
        </div>
      </div>
    </section>
  )
}

function SummaryMetric({
  label,
  value,
  detail,
  trend,
}: {
  label: string
  value: string
  detail: string
  trend?: number | null
}) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-lg font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        {typeof trend === "number" && Math.abs(trend) >= 0.005 && (
          trend > 0 ? (
            <ArrowUpRight className="size-4 text-destructive" aria-label="Increase" />
          ) : (
            <ArrowDownRight className="size-4 text-emerald-700" aria-label="Decrease" />
          )
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function ReportOutputTable({
  rows,
  compare,
  loadingComparison,
  currentSeason,
  previousSeason,
}: {
  rows: ComparisonRow[]
  compare: boolean
  loadingComparison: boolean
  currentSeason: number
  previousSeason: number | null
}) {
  const totalColumns = compare ? 18 : 17

  return (
    <Table
      className={cn(
        "table-fixed border-separate border-spacing-0 text-[11px]",
        compare ? "min-w-[1640px]" : "min-w-[1560px]",
      )}
      containerClassName="max-h-[calc(100vh-290px)] min-h-[340px] overscroll-contain"
      containerProps={{
        role: "region",
        "aria-label": "Master bill of materials output table",
        tabIndex: 0,
      }}
    >
      <TableHeader className="sticky top-0 z-20 bg-background shadow-[0_1px_0_var(--border)]">
        <TableRow className="hover:bg-transparent">
          {compare && <OutputHead className="w-[78px]">Change</OutputHead>}
          <OutputHead className="w-[48px] text-right">Line No.</OutputHead>
          <OutputHead className="w-[142px]">Vehicle System</OutputHead>
          <OutputHead className="w-[70px] text-center">Assembly No.</OutputHead>
          <OutputHead className="w-[52px] text-center">Level</OutputHead>
          <OutputHead className="w-[62px] text-center">Part No.</OutputHead>
          <OutputHead className="w-[60px] text-center">Revision</OutputHead>
          <OutputHead className="w-[166px]">Assembly/ Part Number</OutputHead>
          <OutputHead className="w-[170px]">Assembly Description</OutputHead>
          <OutputHead className="w-[170px]">Part Description</OutputHead>
          <OutputHead className="w-[74px] text-right">Material</OutputHead>
          <OutputHead className="w-[74px] text-right">Process</OutputHead>
          <OutputHead className="w-[74px] text-right">Fastener</OutputHead>
          <OutputHead className="w-[74px] text-right">Tooling</OutputHead>
          <OutputHead className="w-[78px] text-right">Total</OutputHead>
          <OutputHead className="w-[72px] text-center">QTY per Assembly/ System</OutputHead>
          <OutputHead className="w-[96px] text-right">Extended Cost</OutputHead>
          <OutputHead className="w-[70px] text-center">Cost Table Page</OutputHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loadingComparison ? (
          <TableRow>
            <TableCell colSpan={totalColumns} className="h-48 text-center">
              <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                Loading {previousSeason} final table…
              </p>
            </TableCell>
          </TableRow>
        ) : rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={totalColumns} className="h-48 text-center">
              <FileDown className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No matching output rows</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Clear the search or changes-only filter.
              </p>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <OutputTableRow
              key={row.key}
              row={row}
              compare={compare}
              currentSeason={currentSeason}
              previousSeason={previousSeason}
            />
          ))
        )}
      </TableBody>
    </Table>
  )
}

function OutputHead({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <TableHead
      className={cn(
        "h-14 border-r bg-background px-2 align-middle text-[10px] leading-[1.15] font-semibold whitespace-normal uppercase last:border-r-0",
        className,
      )}
    >
      {children}
    </TableHead>
  )
}

function OutputTableRow({
  row,
  compare,
  currentSeason,
  previousSeason,
}: {
  row: ComparisonRow
  compare: boolean
  currentSeason: number
  previousSeason: number | null
}) {
  const output = row.current ?? row.previous!
  const node = output.node
  const isRemoved = row.status === "removed"
  const current = row.current
  const previous = row.previous

  return (
    <TableRow
      className={cn(
        "h-[46px] hover:bg-muted/30",
        row.status === "added" && "bg-sky-50/70 hover:bg-sky-50",
        row.status === "removed" && "bg-rose-50/70 text-muted-foreground hover:bg-rose-50",
        row.status === "changed" && "bg-amber-50/60 hover:bg-amber-50",
      )}
    >
      {compare && (
        <TableCell className="border-r px-2">
          <ChangeBadge status={row.status} />
        </TableCell>
      )}
      <TableCell className="border-r px-2 text-right font-mono tabular-nums">
        {current?.lineNumber ?? "—"}
      </TableCell>
      <OutputTextCell value={output.systemName} />
      <OutputTextCell value={node.raw_hla} align="center" mono />
      <OutputTextCell value={node.raw_subassembly} align="center" mono />
      <OutputTextCell value={node.raw_part_number} align="center" mono />
      <OutputTextCell value={node.revision} align="center" mono />
      <OutputTextCell
        value={node.full_number ?? node.reference_id}
        mono
        title={node.full_number ?? node.reference_id ?? undefined}
      />
      <OutputTextCell
        value={node.kind === "assembly" || node.kind === "subassembly" ? node.name : ""}
        title={node.kind === "assembly" || node.kind === "subassembly" ? node.name : undefined}
      />
      <OutputTextCell
        value={node.kind === "part" ? node.name : ""}
        title={node.kind === "part" ? node.name : undefined}
      />
      {costKinds.map((kind) => (
        <OutputMoneyCell
          key={kind}
          current={current ? Number(current.direct[kind]) : null}
          previous={previous ? Number(previous.direct[kind]) : null}
          compare={compare}
          isRemoved={isRemoved}
          currentSeason={currentSeason}
          previousSeason={previousSeason}
        />
      ))}
      <OutputMoneyCell
        current={current ? Number(current.direct.total) : null}
        previous={previous ? Number(previous.direct.total) : null}
        compare={compare}
        isRemoved={isRemoved}
        currentSeason={currentSeason}
        previousSeason={previousSeason}
        emphasized
      />
      <OutputComparisonCell
        current={current?.node.quantity ?? null}
        previous={previous?.node.quantity ?? null}
        compare={compare}
        align="center"
      />
      <OutputMoneyCell
        current={current?.extendedCost ?? null}
        previous={previous?.extendedCost ?? null}
        compare={compare}
        isRemoved={isRemoved}
        currentSeason={currentSeason}
        previousSeason={previousSeason}
        emphasized
      />
      <TableCell className="border-r px-2 text-center text-muted-foreground last:border-r-0">
        —
      </TableCell>
    </TableRow>
  )
}

function OutputTextCell({
  value,
  align = "left",
  mono = false,
  title,
}: {
  value: string | null
  align?: "left" | "center"
  mono?: boolean
  title?: string
}) {
  return (
    <TableCell
      className={cn(
        "truncate border-r px-2",
        align === "center" && "text-center",
        mono && "font-mono tabular-nums",
      )}
      title={title ?? value ?? undefined}
    >
      {value || "—"}
    </TableCell>
  )
}

function OutputComparisonCell({
  current,
  previous,
  compare,
  align = "right",
}: {
  current: string | null
  previous: string | null
  compare: boolean
  align?: "right" | "center"
}) {
  const changed = compare && current !== previous
  return (
    <TableCell
      className={cn(
        "border-r px-2 font-mono tabular-nums",
        align === "center" ? "text-center" : "text-right",
      )}
    >
      <div>{current ?? "—"}</div>
      {changed && previous !== null && (
        <div className="mt-0.5 text-[9px] leading-none text-muted-foreground">
          was {previous}
        </div>
      )}
    </TableCell>
  )
}

function OutputMoneyCell({
  current,
  previous,
  compare,
  isRemoved,
  currentSeason,
  previousSeason,
  emphasized = false,
}: {
  current: number | null
  previous: number | null
  compare: boolean
  isRemoved: boolean
  currentSeason: number
  previousSeason: number | null
  emphasized?: boolean
}) {
  const delta = current !== null && previous !== null ? current - previous : null
  const changed = delta !== null && Math.abs(delta) >= 0.005
  const shown = current ?? previous
  const title = compare
    ? `${currentSeason}: ${current === null ? "not present" : `U$ ${universal(current)}`}; ${previousSeason}: ${previous === null ? "not present" : `U$ ${universal(previous)}`}`
    : undefined

  return (
    <TableCell
      className={cn(
        "border-r px-2 text-right font-mono tabular-nums",
        emphasized && "font-semibold",
      )}
      title={title}
    >
      <div className={cn(isRemoved && "line-through")}>{universal(shown ?? 0)}</div>
      {compare && changed && (
        <div
          className={cn(
            "mt-0.5 text-[9px] leading-none font-medium",
            delta! > 0 ? "text-destructive" : "text-emerald-700",
          )}
        >
          {signedMoney(delta!, false)}
        </div>
      )}
    </TableCell>
  )
}

function ChangeBadge({ status }: { status: ChangeStatus }) {
  const styles: Record<ChangeStatus, string> = {
    added: "border-sky-200 bg-sky-100 text-sky-800",
    removed: "border-rose-200 bg-rose-100 text-rose-800",
    changed: "border-amber-200 bg-amber-100 text-amber-900",
    unchanged: "border-border bg-background text-muted-foreground",
  }
  return (
    <span
      className={cn(
        "inline-flex rounded border px-1.5 py-0.5 text-[9px] leading-none font-semibold tracking-wide uppercase",
        styles[status],
      )}
    >
      {status}
    </span>
  )
}

function nearestHistoricalProject(
  projects: ProjectSummary[],
  current: ProjectSummary,
): ProjectSummary | null {
  return projects
    .filter((project) => project.is_historical && project.season < current.season)
    .sort((left, right) => right.season - left.season)[0] ?? null
}

function outputRows(detail: ProjectDetail): OutputRow[] {
  const systemNames = new Map(
    detail.flatNodes
      .filter((node) => node.kind === "system" && node.system_code)
      .map((node) => [node.system_code!, node.name]),
  )
  return detail.flatNodes
    .filter((node) =>
      node.kind === "assembly" || node.kind === "subassembly" || node.kind === "part",
    )
    .map((node, index) => {
      const direct = reportDirectBreakdown(node)
      const metadata = historicalMetadata(node)
      return {
        key: rowIdentity(node),
        lineNumber: index + 1,
        node,
        systemName: node.system_code
          ? reportSystemNames[node.system_code] ??
            systemNames.get(node.system_code) ??
            node.system_code
          : "",
        direct,
        extendedCost: metadata?.historicalBomExtendedCost !== undefined
          ? Number(metadata.historicalBomExtendedCost)
          : Number(direct.total) * Number(node.quantity),
      }
    })
}

function compareRows(
  current: OutputRow[],
  previous: OutputRow[],
  baselineAvailable: boolean,
): ComparisonRow[] {
  if (!baselineAvailable) {
    return current.map((row) => ({
      key: row.key,
      current: row,
      previous: null,
      status: "unchanged",
    }))
  }

  const previousByKey = new Map(previous.map((row) => [row.key, row]))
  const rows: ComparisonRow[] = current.map((row) => {
    const baseline = previousByKey.get(row.key) ?? null
    if (baseline) previousByKey.delete(row.key)
    return {
      key: row.key,
      current: row,
      previous: baseline,
      status: baseline ? (rowsEqual(row, baseline) ? "unchanged" : "changed") : "added",
    }
  })
  for (const baseline of previousByKey.values()) {
    rows.push({
      key: `removed:${baseline.key}`,
      current: null,
      previous: baseline,
      status: "removed",
    })
  }
  return rows
}

function rowIdentity(node: CostNode): string {
  const controlled = [
    node.system_code,
    node.raw_hla,
    node.raw_subassembly,
    node.raw_part_number,
  ]
  if (controlled.slice(1).some((value) => value !== null && value !== "")) {
    return controlled.map((value) => value ?? "").join("|").toLocaleLowerCase()
  }
  if (node.reference_id) return `reference:${node.reference_id.toLocaleLowerCase()}`
  if (node.full_number) {
    const seasonNeutral = node.full_number.replace(
      /(^[^-]+)-\d{2}-/,
      "$1-##-",
    )
    return `number:${seasonNeutral.toLocaleLowerCase()}`
  }
  return `name:${node.system_code ?? ""}:${node.kind}:${node.name.toLocaleLowerCase()}`
}

function rowsEqual(current: OutputRow, previous: OutputRow): boolean {
  return current.node.name === previous.node.name &&
    current.node.quantity === previous.node.quantity &&
    Math.abs(current.extendedCost - previous.extendedCost) < 0.005 &&
    costKinds.every(
      (kind) => Math.abs(Number(current.direct[kind]) - Number(previous.direct[kind])) < 0.005,
    ) &&
    Math.abs(Number(current.direct.total) - Number(previous.direct.total)) < 0.005
}

function reportDirectBreakdown(node: CostNode): CostBreakdown {
  const historical = historicalMetadata(node)?.historicalBomBreakdown
  if (historical) return historical

  const values = {
    material: 0,
    process: 0,
    fastener: 0,
    tooling: 0,
    total: 0,
  }
  for (const line of node.costLines) {
    const value = Number(line.subtotal)
    values[line.kind] += value
    values.total += value
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ) as unknown as CostBreakdown
}

function historicalMetadata(node: CostNode): {
  historicalBomBreakdown?: CostBreakdown
  historicalBomExtendedCost?: string
  historicalBomHeaderTotal?: string
} | null {
  if (!node.internal_note) return null
  try {
    const value = JSON.parse(node.internal_note) as Record<string, unknown>
    return {
      historicalBomBreakdown: isBreakdown(value.historicalBomBreakdown)
        ? value.historicalBomBreakdown
        : undefined,
      historicalBomExtendedCost:
        typeof value.historicalBomExtendedCost === "string"
          ? value.historicalBomExtendedCost
          : undefined,
      historicalBomHeaderTotal:
        typeof value.historicalBomHeaderTotal === "string"
          ? value.historicalBomHeaderTotal
          : undefined,
    }
  } catch {
    return null
  }
}

function isBreakdown(value: unknown): value is CostBreakdown {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return [...costKinds, "total"].every(
    (key) => typeof candidate[key] === "string",
  )
}

function reportTotal(detail: ProjectDetail): number {
  const historical = historicalMetadata(detail.tree)?.historicalBomHeaderTotal
  return Number(historical ?? detail.breakdown.total)
}

function signedMoney(value: number, includeCurrency = true): string {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${prefix}${includeCurrency ? "U$ " : ""}${universal(Math.abs(value))}`
}

function downloadFile(url: string): void {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = ""
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function showReportMutationError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Request failed")
}
