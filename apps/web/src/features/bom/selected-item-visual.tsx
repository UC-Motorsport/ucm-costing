import { FileText, ImageIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { EvidencePreview } from "@/features/evidence/evidence-preview"
import { type CostNode, type Evidence } from "@/lib/api"
import { cn } from "@/lib/utils"

export function SelectedItemVisual({
  node,
  evidence,
  loading = false,
  onChooseFile,
  className,
}: {
  node: CostNode
  evidence: Evidence[]
  loading?: boolean
  onChooseFile?: (kind: "image" | "drawing") => void
  className?: string
}) {
  const image = evidence.find((item) => item.kind === "image") ?? null
  const drawings = evidence.filter((item) => item.kind === "drawing")
  const datasheet = evidence.find((item) => item.kind === "datasheet") ?? null
  const slots: VisualEvidenceSlot[] = [
    {
      kind: "image",
      label: "Isometric image",
      item: image,
      emptyMessage: node.image_required === false
        ? "Isometric image not required for this item."
        : "No isometric image attached yet.",
    },
    ...(drawings.length > 0
      ? drawings.map(
          (item, index): VisualEvidenceSlot => ({
            kind: "drawing",
            label:
              drawings.length === 1
                ? "Technical drawing"
                : `Technical drawing ${index + 1} of ${drawings.length}`,
            item,
            emptyMessage: "",
          }),
        )
      : [
          {
            kind: "drawing",
            label: "Technical drawing",
            item: null,
            emptyMessage:
              node.drawing_required === false
                ? "Drawing not required for this item."
                : "No technical drawing attached yet.",
          } satisfies VisualEvidenceSlot,
        ]),
  ]

  if (datasheet) {
    slots.push({
      kind: "datasheet",
      label: "Datasheet",
      item: datasheet,
      emptyMessage: "",
    })
  }

  return (
    <section
      aria-label={`Visual context for ${node.name}`}
      className={cn("bg-muted/15 px-4 py-4 sm:px-6 sm:py-5", className)}
    >
      <div className="mx-auto w-full max-w-5xl">
        <h2 className="mb-3 text-sm font-semibold">Visual evidence</h2>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr))]">
          {loading ? (
            <>
              <VisualEvidenceSkeleton label="Isometric image" />
              <VisualEvidenceSkeleton label="Technical drawing" />
            </>
          ) : (
            slots.map((slot) => (
              <VisualEvidenceCard
                key={slot.item?.id ?? slot.kind}
                slot={slot}
                nodeName={node.name}
                onChooseFile={onChooseFile}
              />
            ))
          )}
        </div>
        {onChooseFile && drawings.length > 0 && (
          <button
            type="button"
            className="mt-3 text-xs font-medium text-primary underline underline-offset-4"
            onClick={() => onChooseFile("drawing")}
          >
            Add more technical drawings
          </button>
        )}
      </div>
    </section>
  )
}

interface VisualEvidenceSlot {
  kind: "image" | "drawing" | "datasheet"
  label: string
  item: Evidence | null
  emptyMessage: string
}

function VisualEvidenceCard({
  slot,
  nodeName,
  onChooseFile,
}: {
  slot: VisualEvidenceSlot
  nodeName: string
  onChooseFile?: (kind: "image" | "drawing") => void
}) {
  const EmptyIcon = slot.kind === "image" ? ImageIcon : FileText

  return (
    <article className="flex min-w-0 flex-col">
      <h3 className="mb-2 text-xs font-semibold">{slot.label}</h3>
      {slot.item ? (
        <>
          <EvidencePreview
            item={slot.item}
            variant="gallery"
            ariaLabel={`Enlarge ${slot.label.toLowerCase()} for ${nodeName}`}
          />
          <div className="mt-2 text-center">
            <div
              className="truncate text-[11px] font-medium"
              title={slot.item.display_name}
            >
              {slot.item.display_name}
            </div>
            {slot.item.visibility === "internal" && (
              <p className="mt-1 text-xs text-amber-700">Excluded from report</p>
            )}
            {slot.item.report_caption ? (
              <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                {slot.item.report_caption}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <button
          type="button"
          className="group grid h-40 place-items-center rounded-md border border-dashed px-3 text-center text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:border-border disabled:hover:bg-transparent disabled:hover:text-muted-foreground sm:h-44"
          aria-label={`Upload ${slot.label.toLowerCase()} for ${nodeName}`}
          disabled={!onChooseFile || slot.kind === "datasheet"}
          onClick={() => {
            if (slot.kind !== "datasheet") onChooseFile?.(slot.kind)
          }}
        >
          <div>
            <EmptyIcon className="mx-auto mb-2 size-5 transition-colors group-hover:text-foreground" />
            <span className="block">{slot.emptyMessage}</span>
            {onChooseFile && slot.kind !== "datasheet" ? (
              <span className="mt-1 block font-medium text-foreground">
                Click to choose a file
              </span>
            ) : null}
          </div>
        </button>
      )}
    </article>
  )
}

function VisualEvidenceSkeleton({ label }: { label: string }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold">{label}</div>
      <Skeleton className="h-40 w-full sm:h-44" />
    </div>
  )
}
