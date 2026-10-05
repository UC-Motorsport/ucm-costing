import { extendCostBreakdown } from "@ucm/domain"
import {
  Box,
  Copy,
  Eye,
  Link2,
  MoreHorizontal,
  Pencil,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EvidencePreview } from "@/features/evidence/evidence-preview"
import {
  type CostNode,
  type Evidence,
  universal,
} from "@/lib/api"
import { cn } from "@/lib/utils"

interface RecordInspectorProps {
  node: CostNode | null
  directBlockers: number
  scopeBlockers: number
  carBlockers: number
  costedParts: number
  partCount: number
  missingVisuals: number
  evidence: Evidence[]
  canWrite: boolean
  onEdit: () => void
}

export function RecordInspector({
  node,
  directBlockers,
  scopeBlockers,
  carBlockers,
  costedParts,
  partCount,
  missingVisuals,
  evidence,
  canWrite,
  onEdit,
}: RecordInspectorProps) {
  if (!node) {
    return (
      <aside className="hidden min-[1180px]:block">
        <div className="px-4 py-5 text-sm text-muted-foreground">
          Select a record to inspect it.
        </div>
      </aside>
    )
  }

  const identifier =
    node.full_number ?? node.reference_id ?? node.system_code
  const reference = identifier ?? "Unnumbered"
  const deepLink = new URL("/", window.location.origin)
  deepLink.searchParams.set("node", node.id)
  const visualEvidence = evidence.filter(
    (item) => item.kind === "drawing" || item.kind === "image",
  )
  const primaryVisual = visualEvidence[0] ?? null

  const rowBreakdown = extendCostBreakdown(node.breakdown, node.quantity)
  const fields = [
    ["Reference", reference],
    ["Type", node.kind],
    ["Quantity", node.quantity],
    ["Material (U$)", universal(rowBreakdown.material)],
    ["Process (U$)", universal(rowBreakdown.process)],
    ["Fastener (U$)", universal(rowBreakdown.fastener)],
    ["Tooling (U$)", universal(rowBreakdown.tooling)],
    ["Total (U$)", universal(rowBreakdown.total)],
  ]

  return (
    <aside className="hidden min-h-[calc(100vh-58px)] bg-background min-[1180px]:block">
      <div className="flex h-[58px] items-center justify-between border-b px-4">
        <h2 className="text-sm font-semibold">Record Inspector</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Open actions for ${node.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onEdit}>
              {canWrite ? <Pencil /> : <Eye />}
              {canWrite ? "Edit record" : "View record"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {identifier ? (
              <DropdownMenuItem
                onSelect={() => {
                  void copyText(
                    identifier,
                    "Record identifier copied",
                  )
                }}
              >
                <Copy />
                Copy identifier
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() => {
                void copyText(deepLink.toString(), "Record link copied")
              }}
            >
              <Link2 />
              Copy deep link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-4">
        <div className="flex min-h-[66px] items-center gap-3 border-b">
          <Box className="size-5 shrink-0" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {node.name}
          </div>
        </div>

        <section className="border-b py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">Evidence preview</h3>
            <span className="font-mono text-[10px] text-muted-foreground">
              {visualEvidence.length} attached
            </span>
          </div>
          {primaryVisual ? (
            <>
              <EvidencePreview item={primaryVisual} variant="inspector" />
              <div className="mt-2 truncate text-[11px] font-medium" title={primaryVisual.display_name}>
                {primaryVisual.display_name}
              </div>
              {primaryVisual.report_caption ? (
                <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                  {primaryVisual.report_caption}
                </p>
              ) : null}
            </>
          ) : (
            <div className="rounded-md border border-dashed px-3 py-5 text-center text-[11px] text-muted-foreground">
              No isometric image or technical drawing attached yet.
            </div>
          )}
        </section>

        <section className="border-b py-4">
          <h3 className="mb-3 text-xs font-semibold">Details</h3>
          <dl className="space-y-3.5">
            {fields.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-[11px]"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd
                  className={cn(
                    "truncate text-right tabular-nums",
                    label === "Type" && "capitalize",
                    label.includes("U$") || label === "Quantity"
                      ? "font-mono"
                      : "",
                  )}
                  title={value}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-b py-4">
          <h3 className="mb-3 text-xs font-semibold">Readiness</h3>
          <dl className="space-y-3.5 text-[11px]">
            <InspectorRow
              label="This item"
              value={String(directBlockers)}
              destructive={directBlockers > 0}
            />
            <InspectorRow
              label="Including contents"
              value={String(scopeBlockers)}
              destructive={scopeBlockers > 0}
            />
            <InspectorRow
              label="Parts costed"
              value={`${costedParts} / ${partCount}`}
            />
            <InspectorRow
              label="Visuals missing"
              value={String(missingVisuals)}
            />
            <InspectorRow
              label="Whole car"
              value={String(carBlockers)}
              destructive={carBlockers > 0}
            />
          </dl>
          <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
            Competition-ready export uses the whole-car count. Assembly owners
            can work from the selected-scope count above.
          </p>
        </section>

        <div className="py-5">
          <Button variant="outline" onClick={onEdit}>
            <Pencil />
            Edit record
          </Button>
        </div>
      </div>
    </aside>
  )
}

function InspectorRow({
  label,
  value,
  destructive = false,
}: {
  label: string
  value: string
  destructive?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums",
          destructive && "font-semibold text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  )
}

async function copyText(value: string, successMessage: string) {
  let copied = false

  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      copied = true
    }
  } catch {
    copied = false
  }

  if (!copied) copied = copyTextWithSelection(value)

  if (copied) {
    toast.success(successMessage)
    return
  }

  toast.error("Could not copy to the clipboard")
}

function copyTextWithSelection(value: string): boolean {
  const textArea = document.createElement("textarea")
  const previouslyFocused = document.activeElement
  textArea.value = value
  textArea.readOnly = true
  textArea.setAttribute("aria-hidden", "true")
  Object.assign(textArea.style, {
    position: "fixed",
    opacity: "0",
    pointerEvents: "none",
  })
  document.body.append(textArea)
  textArea.select()

  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textArea.remove()
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus()
    }
  }
}
