import { useState } from "react"
import { Download, FileText, Maximize2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { evidenceKindLabel } from "@/features/evidence/evidence-kind-label"
import type { Evidence } from "@/lib/api"
import { cn } from "@/lib/utils"

export function EvidencePreview({
  item,
  variant = "thumbnail",
  className,
  ariaLabel,
}: {
  item: Evidence
  variant?: "thumbnail" | "inspector" | "hero" | "gallery"
  className?: string
  ariaLabel?: string
}) {
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null)
  const thumbnailUrl =
    item.thumbnailUrl ?? `/api/evidence/${item.id}/thumbnail?v=${item.version}`

  if (!isPreviewableEvidence(item)) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted/45 text-muted-foreground">
        <FileText className="size-4" />
      </span>
    )
  }

  const image = item.mime_type.startsWith("image/")
  const large = variant !== "thumbnail"

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "group relative shrink-0 overflow-hidden rounded-md border bg-muted/30 text-left outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-primary",
            variant === "thumbnail"
              ? "size-16"
              : variant === "hero"
                ? "h-44 w-full sm:h-64"
                : variant === "gallery"
                  ? "h-40 w-full sm:h-44"
                  : "aspect-[4/3] w-full",
            className,
          )}
          data-preview-variant={variant}
          aria-label={ariaLabel ?? `Preview ${item.display_name}`}
        >
          {image || failedThumbnail !== thumbnailUrl ? (
            <img
              src={image ? item.viewUrl : thumbnailUrl}
              onError={
                image ? undefined : () => setFailedThumbnail(thumbnailUrl)
              }
              alt=""
              loading={
                variant === "hero" || variant === "gallery" ? "eager" : "lazy"
              }
              className={cn(
                "size-full",
                large || !image
                  ? "bg-background object-contain p-2"
                  : "object-cover",
              )}
            />
          ) : (
            <span className="flex size-full flex-col items-center justify-center gap-1 bg-muted/45 text-muted-foreground">
              <FileText className={large ? "size-8" : "size-5"} />
              <span className="font-mono text-[9px] font-semibold uppercase tracking-wide">
                PDF
              </span>
              {large && (
                <span className="text-xs">
                  Preview unavailable · Click to open PDF
                </span>
              )}
            </span>
          )}
          <span className="absolute right-1 bottom-1 grid size-6 place-items-center rounded bg-background/90 text-foreground opacity-100 shadow-sm transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
            <Maximize2 className="size-3.5" />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4 pr-12 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2">
            <DialogTitle className="truncate">{item.display_name}</DialogTitle>
            <DialogDescription>
              {item.report_caption ||
                `${evidenceKindLabel(item.kind)} evidence`}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" className="self-start" asChild>
            <a
              href={item.downloadUrl}
              download={item.display_name}
              aria-label={`Download ${item.display_name}`}
            >
              <Download />
              Download
            </a>
          </Button>
        </DialogHeader>
        <div className="flex min-h-[55vh] items-center justify-center bg-muted/25 p-3 sm:min-h-[72vh] sm:p-5">
          {image ? (
            <img
              src={item.viewUrl}
              alt={item.report_caption || item.display_name}
              className="max-h-[75vh] max-w-full rounded border bg-background object-contain shadow-sm"
            />
          ) : (
            <iframe
              src={`${item.viewUrl}#toolbar=1&navpanes=0`}
              title={`Preview ${item.display_name}`}
              className="h-[72vh] w-full rounded border bg-background"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function isPreviewableEvidence(item: Evidence): boolean {
  return (
    item.mime_type === "application/pdf" || item.mime_type.startsWith("image/")
  )
}
