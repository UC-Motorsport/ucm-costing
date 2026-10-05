import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileWarning,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

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
import { CostAmendmentItemDialog } from "@/features/reports/cost-amendment-item-dialog"
import {
  EmptyState,
  LoadingRows,
  MutationError,
  WorkflowIssues,
} from "@/features/reports/workflow-ui"
import {
  issuesFromError,
  workflowMutationErrorMessage,
} from "@/features/reports/workflow-utils"
import {
  api,
  universal,
  type Artifact,
  type CostAmendment,
  type CostAmendmentDetail,
  type CostAmendmentItem,
  type WorkflowIssue,
} from "@/lib/api"

type ItemEditor = CostAmendmentItem | "new" | null

export function CostAmendmentRecord({
  amendment,
  projectId,
  previewArtifact,
  canWrite,
}: {
  amendment: CostAmendment
  projectId: string
  previewArtifact: Artifact | null
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editor, setEditor] = useState<ItemEditor>(null)
  const [deleteItem, setDeleteItem] =
    useState<CostAmendmentItem | null>(null)
  const [eligibilityIssues, setEligibilityIssues] = useState<
    WorkflowIssue[] | null
  >(null)
  const detail = useQuery({
    queryKey: ["cost-amendment", amendment.id],
    queryFn: () => api.costAmendment(amendment.id),
    enabled: expanded,
  })

  const invalidateWorkflow = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["cost-amendments", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["cost-amendment", amendment.id],
      }),
      queryClient.invalidateQueries({ queryKey: ["validation", projectId] }),
      queryClient.invalidateQueries({
        queryKey: ["workspace-activity"],
      }),
    ])
  }

  const preview = useMutation({
    mutationFn: () => api.createCostAmendmentPreview(amendment.id),
    onSuccess: async () => {
      await Promise.all([
        invalidateWorkflow(),
        queryClient.invalidateQueries({
          queryKey: ["artifacts", projectId],
        }),
      ])
      toast.success("Watermarked cost amendment preview generated")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const checkLock = useMutation({
    mutationFn: () => api.checkCostAmendmentLock(amendment.id),
    onSuccess: () => setEligibilityIssues([]),
    onError: (error) => setEligibilityIssues(issuesFromError(error)),
  })
  const remove = useMutation({
    mutationFn: (item: CostAmendmentItem) => {
      if (!detail.data) throw new Error("Load amendment items before deleting")
      return api.deleteCostAmendmentItem(
        amendment.id,
        item.id,
        detail.data.amendment.version,
      )
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(
        ["cost-amendment", amendment.id],
        updated,
      )
      await invalidateWorkflow()
      setDeleteItem(null)
      toast.success("Amendment item deleted and totals recalculated")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  const onItemSaved = async (updated: CostAmendmentDetail) => {
    queryClient.setQueryData(["cost-amendment", amendment.id], updated)
    await invalidateWorkflow()
    setEditor(null)
    toast.success(
      editor === "new"
        ? "Amendment item added and totals recalculated"
        : "Amendment item updated and totals recalculated",
    )
  }

  const visibleAmendment = detail.data?.amendment ?? amendment

  return (
    <article className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{amendment.event_reference}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Additions U$ {universal(visibleAmendment.total_additions)} ·
            removals U$ {universal(visibleAmendment.total_removals)} · net U${" "}
            {universal(visibleAmendment.net_change)} · updated{" "}
            {new Date(visibleAmendment.updated_at).toLocaleString("en-NZ")}
          </div>
        </div>
        <Badge variant="outline" className="capitalize">
          {visibleAmendment.status}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          {expanded ? "Hide amendment items" : "View amendment items"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => preview.mutate()}
          disabled={!canWrite || preview.isPending}
        >
          {preview.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <FileWarning />
          )}
          Generate preview
        </Button>
        {previewArtifact?.downloadUrl && (
          <Button size="sm" variant="outline" asChild>
            <a href={previewArtifact.downloadUrl}>
              <Download />
              Download preview
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => checkLock.mutate()}
          disabled={!canWrite || checkLock.isPending}
        >
          Check final eligibility
        </Button>
      </div>
      {eligibilityIssues && eligibilityIssues.length === 0 && (
        <p className="text-xs text-emerald-800">
          The server found no item-level eligibility blockers.
        </p>
      )}
      {eligibilityIssues && eligibilityIssues.length > 0 && (
        <WorkflowIssues issues={eligibilityIssues} />
      )}
      <MutationError error={preview.error} />

      {expanded && (
        <section className="space-y-3 border-t pt-3" aria-label="Amendment items">
          {detail.isLoading ? (
            <LoadingRows label="Loading immutable amendment detail…" />
          ) : detail.isError ? (
            <MutationError error={detail.error} />
          ) : detail.data ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  Base report catalogue{" "}
                  {detail.data.baseReport.catalogueRevision} ·{" "}
                  {detail.data.baseReport.parts.length} immutable part
                  {detail.data.baseReport.parts.length === 1 ? "" : "s"}
                </div>
                {canWrite && detail.data.amendment.status === "draft" && (
                  <Button size="sm" onClick={() => setEditor("new")}>
                    <Plus />
                    Add amendment item
                  </Button>
                )}
              </div>
              {detail.data.items.length === 0 ? (
                <EmptyState>
                  No amendment items. Add an item from the immutable base report
                  and official catalogue.
                </EmptyState>
              ) : (
                <div className="divide-y rounded-md border">
                  {detail.data.items.map((item) => (
                    <AmendmentItemRow
                      key={item.id}
                      item={item}
                      editable={
                        canWrite && detail.data.amendment.status === "draft"
                      }
                      onEdit={() => setEditor(item)}
                      onDelete={() => setDeleteItem(item)}
                    />
                  ))}
                </div>
              )}
              {detail.data.blockers.length > 0 && (
                <WorkflowIssues issues={detail.data.blockers} />
              )}
            </>
          ) : null}
        </section>
      )}

      {detail.data && editor !== null && (
        <CostAmendmentItemDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null)
          }}
          detail={detail.data}
          item={editor === "new" ? undefined : editor}
          onSaved={onItemSaved}
        />
      )}
      <Dialog
        open={deleteItem !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleteItem(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete amendment item?</DialogTitle>
            <DialogDescription>
              The server will recalculate additions, removals, and net change.
              The deletion remains in the append-only audit history.
            </DialogDescription>
          </DialogHeader>
          {deleteItem && (
            <p className="rounded-md bg-muted p-3 text-sm">
              {deleteItem.description} · U${" "}
              {universal(deleteItem.subtotal)}
            </p>
          )}
          <MutationError error={remove.error} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteItem(null)}
              disabled={remove.isPending}
            >
              Keep item
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteItem && remove.mutate(deleteItem)}
              disabled={!deleteItem || remove.isPending}
            >
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete and recalculate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}

function AmendmentItemRow({
  item,
  editable,
  onEdit,
  onDelete,
}: {
  item: CostAmendmentItem
  editable: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 p-3">
      <Badge variant={item.action === "add" ? "outline" : "secondary"}>
        {item.action === "add" ? "Addition" : "Removal"}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{item.description}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {item.classification.replace("-", " ")} · {item.cost_box} ·{" "}
          {item.source_json.partNumber} · catalogue #
          {item.source_json.catalogueId}
        </div>
        <div className="mt-1 text-xs">
          {item.quantity} × U$ {universal(item.unit_cost)} = U${" "}
          {universal(item.subtotal)} · vehicle quantity{" "}
          {item.original_quantity} → {item.revised_quantity}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {item.source_json.derivedFrom ??
            "immutable-base-report-and-official-catalogue"}
        </div>
      </div>
      {editable && (
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Edit ${item.description}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${item.description}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  )
}
