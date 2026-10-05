import { useEffect, useId, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { evidenceKindLabel } from "@/features/evidence/evidence-kind-label"
import { EvidencePreview } from "@/features/evidence/evidence-preview"
import { useUnsavedChangesRegistration } from "@/hooks/use-unsaved-changes"
import { ApiError, api, type Evidence } from "@/lib/api"

export interface EvidenceListProps {
  items: Evidence[]
  projectId: string
  canWrite?: boolean
  emptyMessage?: string
  onChanged?: () => void | Promise<void>
}

export function EvidenceList({
  items,
  projectId,
  canWrite = true,
  emptyMessage = "No evidence attached.",
  onChanged,
}: EvidenceListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="divide-y rounded-lg border">
      {items.map((item) => (
        <EvidenceItem
          key={item.id}
          item={item}
          projectId={projectId}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}

function EvidenceItem({
  item,
  projectId,
  canWrite,
  onChanged,
}: {
  item: Evidence
  projectId: string
  canWrite: boolean
  onChanged?: () => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  const fieldId = useId()
  const [editOpen, setEditOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [caption, setCaption] = useState(item.report_caption)
  const [visibility, setVisibility] = useState(item.visibility)
  const [replacement, setReplacement] = useState<File | null>(null)

  useEffect(() => {
    if (!editOpen) return
    setCaption(item.report_caption)
    setVisibility(item.visibility)
  }, [editOpen, item.report_caption, item.visibility])

  useEffect(() => {
    if (!replaceOpen) setReplacement(null)
  }, [replaceOpen])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["evidence", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["workspace"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["validation", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["reports", projectId],
      }),
    ])
    await onChanged?.()
  }

  const update = useMutation({
    mutationFn: () =>
      api.updateEvidence(item.id, {
        expectedVersion: item.version,
        reportCaption: caption,
        visibility,
      }),
    onSuccess: async () => {
      setEditOpen(false)
      toast.success("Evidence details updated")
      await refresh()
    },
    onError: async (error) => {
      await handleEvidenceMutationError(error, refresh)
    },
  })

  const replace = useMutation({
    mutationFn: () =>
      api.replaceEvidence(item.id, replacement!, item.version),
    onSuccess: async () => {
      setReplaceOpen(false)
      setReplacement(null)
      toast.success("Evidence file replaced for future reports")
      await refresh()
    },
    onError: async (error) => {
      await handleEvidenceMutationError(error, refresh)
    },
  })

  const remove = useMutation({
    mutationFn: () => api.deleteEvidence(item.id, item.version),
    onSuccess: async () => {
      setDeleteOpen(false)
      toast.success("Evidence removed from the editable workspace")
      await refresh()
    },
    onError: async (error) => {
      await handleEvidenceMutationError(error, refresh)
    },
  })

  const metadataDirty = editOpen && (caption !== item.report_caption || visibility !== item.visibility)
  useUnsavedChangesRegistration(
    `evidence-metadata:${item.id}`,
    metadataDirty,
    { label: `${item.display_name} evidence details` },
  )
  useUnsavedChangesRegistration(
    `evidence-replacement:${item.id}`,
    replaceOpen && Boolean(replacement),
    { label: `${item.display_name} replacement` },
  )

  const updated = new Date(item.updated_at)

  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <EvidencePreview item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {item.display_name}
          </span>
        </div>
        {item.report_caption && (
          <p className="mt-1 text-xs text-foreground">
            {item.report_caption}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {evidenceKindLabel(item.kind)} · {item.visibility === "report" ? "Included in report" : "Excluded from report"} · updated{" "}
          {Number.isNaN(updated.getTime())
            ? item.updated_at
            : updated.toLocaleString("en-NZ")}{" "}
          · SHA-256 {item.content_sha256.slice(0, 12)}…
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href={item.downloadUrl}
            aria-label={`Download ${item.display_name}`}
          >
            <Download />
          </a>
        </Button>
        {canWrite && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit details for ${item.display_name}`}
              onClick={() => setEditOpen(true)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Replace ${item.display_name}`}
              onClick={() => setReplaceOpen(true)}
            >
              <RefreshCw />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${item.display_name}`}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>

      <Dialog
        open={editOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen || !metadataDirty) setEditOpen(nextOpen)
        }}
      >
        <DialogContent showCloseButton={!metadataDirty}>
          <DialogHeader>
            <DialogTitle>Edit evidence details</DialogTitle>
            <DialogDescription>
              Changes apply to future report snapshots. Reports already
              generated retain their original caption, hash, and embedded
              file.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary"
                checked={visibility === "report"}
                disabled={update.isPending}
                onChange={(event) => setVisibility(event.target.checked ? "report" : "internal")} />
              Include in report
            </label>
            <p className="text-xs text-muted-foreground">
              Only evidence included in the report satisfies its visual requirements.
            </p>
            <Field
              data-invalid={
                visibility === "report" && !caption.trim()
              }
            >
              <FieldLabel htmlFor={`${fieldId}-caption`}>
                Report caption
              </FieldLabel>
              <Input
                id={`${fieldId}-caption`}
                value={caption}
                maxLength={500}
                onChange={(event) => setCaption(event.target.value)}
                placeholder="What this file proves"
                aria-invalid={
                  visibility === "report" && !caption.trim()
                }
              />
              {visibility === "report" && !caption.trim() && (
                <FieldError>
                  Report-visible evidence needs a caption.
                </FieldError>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => update.mutate()}
              disabled={
                update.isPending ||
                !metadataDirty ||
                (visibility === "report" && !caption.trim())
              }
            >
              {update.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              Save details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={replaceOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen || !replacement) setReplaceOpen(nextOpen)
        }}
      >
        <DialogContent showCloseButton={!replacement}>
          <DialogHeader>
            <DialogTitle>Replace evidence file?</DialogTitle>
            <DialogDescription>
              The new file is used only by future snapshots. Existing reports
              retain the previous bytes and SHA-256. Replacement is paused
              while a report is actively rendering.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-replacement`}>
              Replacement file
            </FieldLabel>
            <Input
              id={`${fieldId}-replacement`}
              type="file"
              accept={
                item.visibility === "report"
                  ? ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  : ".pdf,.png,.jpg,.jpeg,.webp,.txt"
              }
              onChange={(event) =>
                setReplacement(event.target.files?.[0] ?? null)
              }
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => replace.mutate()}
              disabled={!replacement || replace.isPending}
            >
              {replace.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              Replace for future reports
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {item.display_name}?</DialogTitle>
            <DialogDescription>
              This removes the evidence from the editable workspace and future
              reports. Existing report snapshots and PDFs remain unchanged.
              Deletion is paused while a report is actively rendering.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              Delete evidence
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

async function handleEvidenceMutationError(
  error: unknown,
  refresh: () => Promise<void>,
) {
  if (error instanceof ApiError) {
    if (error.code === "version-conflict") {
      toast.error(
        "This evidence changed elsewhere. The latest version has been reloaded.",
      )
      await refresh()
      return
    }
    if (error.code === "evidence-report-rendering-conflict") {
      toast.error(
        "A report is rendering. Wait for it to finish before replacing or deleting evidence.",
      )
      await refresh()
      return
    }
    toast.error(error.message)
    return
  }
  toast.error(error instanceof Error ? error.message : "Request failed")
}
