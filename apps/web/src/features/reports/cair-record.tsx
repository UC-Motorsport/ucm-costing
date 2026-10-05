import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Ban,
  CheckCircle2,
  Download,
  FileLock2,
  LoaderCircle,
  Paperclip,
  Pencil,
  Send,
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
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { MutationError } from "@/features/reports/workflow-ui"
import { workflowMutationErrorMessage } from "@/features/reports/workflow-utils"
import {
  api,
  universal,
  type CairRequestDetail,
  type CatalogueItem,
  type Evidence,
} from "@/lib/api"

type CairAction = "submit" | "resolve" | "reject" | "cancel"
type CatalogueKind =
  | "material"
  | "process"
  | "fastener"
  | "tooling"
  | "multiplier"

const catalogueKinds: Array<{
  value: CatalogueKind
  label: string
}> = [
  { value: "material", label: "Material" },
  { value: "process", label: "Process" },
  { value: "fastener", label: "Fastener" },
  { value: "tooling", label: "Tooling" },
  { value: "multiplier", label: "Multiplier" },
]

export function CairRecord({
  request,
  projectId,
  catalogueReleaseId,
  evidence,
  evidenceLoading,
  canWrite,
}: {
  request: CairRequestDetail
  projectId: string
  catalogueReleaseId: string
  evidence: Evidence[]
  evidenceLoading: boolean
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [editOpen, setEditOpen] = useState(false)
  const [description, setDescription] = useState(
    request.requested_catalogue_description,
  )
  const [rationale, setRationale] = useState(request.rationale)
  const [proposedCost, setProposedCost] = useState(
    request.proposed_cost ?? "",
  )
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("")
  const [action, setAction] = useState<CairAction | null>(null)
  const [externalReference, setExternalReference] = useState(
    request.external_reference ?? "",
  )
  const [decisionNote, setDecisionNote] = useState("")
  const [catalogueKind, setCatalogueKind] =
    useState<CatalogueKind>("material")
  const [catalogueSearch, setCatalogueSearch] = useState("")
  const [resolvedItemId, setResolvedItemId] = useState("")

  useEffect(() => {
    if (!editOpen) return
    setDescription(request.requested_catalogue_description)
    setRationale(request.rationale)
    setProposedCost(request.proposed_cost ?? "")
  }, [editOpen, request])

  const catalogue = useQuery({
    queryKey: [
      "catalogue",
      catalogueReleaseId,
      catalogueKind,
      catalogueSearch,
    ],
    queryFn: () =>
      api.catalogue(
        catalogueReleaseId,
        catalogueKind,
        catalogueSearch.trim(),
      ),
    enabled: action === "resolve",
  })

  useEffect(() => {
    if (
      resolvedItemId &&
      !catalogue.data?.items.some(({ id }) => id === resolvedItemId)
    ) {
      setResolvedItemId("")
    }
  }, [catalogue.data?.items, resolvedItemId])

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cairs", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["validation", projectId] }),
      queryClient.invalidateQueries({
        queryKey: ["workspace-activity"],
      }),
    ])
  }

  const edit = useMutation({
    mutationFn: () =>
      api.updateCair(request.id, {
        expectedVersion: request.version,
        costLineId: request.cost_line_id,
        requestedCatalogueDescription: description.trim(),
        rationale: rationale.trim(),
        proposedCost: proposedCost.trim() || null,
        provenance: request.provenance_json,
      }),
    onSuccess: async () => {
      await invalidate()
      setEditOpen(false)
      toast.success("CAIR draft updated")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const attach = useMutation({
    mutationFn: () =>
      api.attachCairEvidence(
        request.id,
        selectedEvidenceId,
        request.version,
      ),
    onSuccess: async () => {
      await invalidate()
      setSelectedEvidenceId("")
      toast.success("Evidence attached to CAIR")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const detach = useMutation({
    mutationFn: (evidenceId: string) =>
      api.detachCairEvidence(request.id, evidenceId, request.version),
    onSuccess: async () => {
      await invalidate()
      toast.success("Evidence detached from CAIR")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const transition = useMutation({
    mutationFn: (nextAction: CairAction) => {
      if (nextAction === "submit") {
        return api.transitionCair(request.id, {
          expectedVersion: request.version,
          next: "submitted",
          externalReference: externalReference.trim(),
        })
      }
      if (nextAction === "resolve") {
        return api.transitionCair(request.id, {
          expectedVersion: request.version,
          next: "catalogue-resolved",
          resolvedCatalogueReleaseId: catalogueReleaseId,
          resolvedCatalogueItemId: resolvedItemId,
        })
      }
      if (nextAction === "reject") {
        return api.transitionCair(request.id, {
          expectedVersion: request.version,
          next: "rejected",
          externalReference: externalReference.trim(),
          decisionNote: decisionNote.trim(),
        })
      }
      return api.transitionCair(request.id, {
        expectedVersion: request.version,
        next: "cancelled",
      })
    },
    onSuccess: async (_, nextAction) => {
      await invalidate()
      setAction(null)
      setDecisionNote("")
      setResolvedItemId("")
      toast.success(cairActionSuccess(nextAction))
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  const attachments = request.attachments ?? []
  const attachedIds = new Set(
    attachments.map(({ evidence_id }) => evidence_id),
  )
  const availableEvidence = evidence.filter(
    ({ id }) => !attachedIds.has(id),
  )
  const validCost = isNonNegativeDecimalOrBlank(proposedCost)
  const actionReady =
    action === "cancel" ||
    (action === "submit" && Boolean(externalReference.trim())) ||
    (action === "resolve" && Boolean(resolvedItemId)) ||
    (action === "reject" &&
      Boolean(externalReference.trim()) &&
      Boolean(decisionNote.trim()))

  const openAction = (nextAction: CairAction) => {
    setExternalReference(request.external_reference ?? "")
    setDecisionNote("")
    setResolvedItemId("")
    setAction(nextAction)
  }

  return (
    <article className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">
            {request.requested_catalogue_description}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Updated {new Date(request.updated_at).toLocaleString("en-NZ")} ·
            version {request.version}
          </div>
        </div>
        <Badge variant="outline" className="capitalize">
          {request.status.replace("-", " ")}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{request.rationale}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {request.proposed_cost && (
          <span className="font-medium">
            Proposed U$ {universal(request.proposed_cost)}
          </span>
        )}
        {request.external_reference && (
          <span>External reference: {request.external_reference}</span>
        )}
        {request.resolved_catalogue_item_id && (
          <span className="font-mono">
            Official item {request.resolved_catalogue_item_id}
          </span>
        )}
      </div>
      {request.decision_note && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs">
          Decision: {request.decision_note}
        </p>
      )}

      <section className="space-y-2" aria-label="CAIR evidence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            Evidence ({attachments.length})
          </h3>
          {request.status === "submitted" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <FileLock2 className="size-3.5" />
              Provenance frozen at submission
            </span>
          )}
        </div>
        {attachments.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No evidence attached.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {attachments.map((attachment) => (
              <div
                key={attachment.evidence_id}
                className="flex flex-wrap items-start gap-3 p-3"
              >
                <Paperclip className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {attachment.display_name}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {attachment.kind} · {formatByteSize(attachment.byte_size)} ·
                    attached by {attachment.attached_by_display_name}{" "}
                    {new Date(attachment.attached_at).toLocaleString("en-NZ")}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    SHA-256{" "}
                    {attachment.frozen_content_sha256 ??
                      attachment.content_sha256}
                  </div>
                  {attachment.frozen_at && (
                    <div className="mt-1 text-[11px] text-emerald-800">
                      Frozen version {attachment.frozen_evidence_version} ·{" "}
                      {formatByteSize(attachment.frozen_byte_size)} ·{" "}
                      {new Date(attachment.frozen_at).toLocaleString("en-NZ")}
                    </div>
                  )}
                </div>
                <Button size="sm" variant="outline" asChild>
                  <a href={attachment.download_url}>
                    <Download />
                    Download
                  </a>
                </Button>
                {request.status === "draft" && canWrite && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Detach ${attachment.display_name}`}
                    onClick={() => detach.mutate(attachment.evidence_id)}
                    disabled={detach.isPending}
                  >
                    {detach.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {request.status === "draft" && canWrite && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={selectedEvidenceId}
              onValueChange={setSelectedEvidenceId}
              disabled={evidenceLoading || availableEvidence.length === 0}
            >
              <SelectTrigger
                className="min-w-0 flex-1"
                aria-label="Existing evidence"
              >
                <SelectValue
                  placeholder={
                    evidenceLoading
                      ? "Loading evidence…"
                      : availableEvidence.length === 0
                        ? "No unattached evidence available"
                        : "Select existing evidence"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableEvidence.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => attach.mutate()}
              disabled={!selectedEvidenceId || attach.isPending}
            >
              {attach.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Paperclip />
              )}
              Attach existing evidence
            </Button>
          </div>
        )}
      </section>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {request.status === "draft" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditOpen(true)}
              >
                <Pencil />
                Edit draft
              </Button>
              <Button size="sm" onClick={() => openAction("submit")}>
                <Send />
                Submit CAIR
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openAction("cancel")}
              >
                <Ban />
                Cancel CAIR
              </Button>
            </>
          )}
          {request.status === "submitted" && (
            <>
              <Button size="sm" onClick={() => openAction("resolve")}>
                <CheckCircle2 />
                Resolve from official catalogue
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openAction("reject")}
              >
                Reject request
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openAction("cancel")}
              >
                <Ban />
                Cancel CAIR
              </Button>
            </>
          )}
        </div>
      )}
      <MutationError
        error={attach.error ?? detach.error}
      />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit CAIR draft</DialogTitle>
            <DialogDescription>
              Draft fields remain editable until submission freezes the request
              and its evidence provenance.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">
                Requested catalogue description
              </span>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={1_000}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Rationale</span>
              <Textarea
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                rows={5}
                maxLength={10_000}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">
                Proposed Universal $ cost (optional)
              </span>
              <Input
                inputMode="decimal"
                value={proposedCost}
                onChange={(event) => setProposedCost(event.target.value)}
                aria-invalid={!validCost}
              />
              {!validCost && (
                <span className="text-xs text-destructive">
                  Enter zero or a positive decimal amount.
                </span>
              )}
            </label>
          </div>
          <MutationError error={edit.error} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={edit.isPending}
            >
              Keep current draft
            </Button>
            <Button
              onClick={() => edit.mutate()}
              disabled={
                edit.isPending ||
                !description.trim() ||
                !rationale.trim() ||
                !validCost
              }
            >
              {edit.isPending && <LoaderCircle className="animate-spin" />}
              Save draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !transition.isPending) setAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? cairActionTitle(action) : ""}</DialogTitle>
            <DialogDescription>
              {action ? cairActionDescription(action) : ""}
            </DialogDescription>
          </DialogHeader>
          {(action === "submit" || action === "reject") && (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">External reference</span>
              <Input
                value={externalReference}
                onChange={(event) => setExternalReference(event.target.value)}
                maxLength={2_000}
              />
            </label>
          )}
          {action === "reject" && (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Decision note</span>
              <Textarea
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                rows={4}
                maxLength={10_000}
              />
            </label>
          )}
          {action === "resolve" && (
            <CatalogueResolutionFields
              kind={catalogueKind}
              onKindChange={(kind) => {
                setCatalogueKind(kind)
                setResolvedItemId("")
              }}
              search={catalogueSearch}
              onSearchChange={setCatalogueSearch}
              items={catalogue.data?.items ?? []}
              loading={catalogue.isLoading}
              itemId={resolvedItemId}
              onItemChange={setResolvedItemId}
            />
          )}
          <MutationError error={transition.error ?? catalogue.error} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAction(null)}
              disabled={transition.isPending}
            >
              Go back
            </Button>
            <Button
              variant={action === "cancel" || action === "reject" ? "destructive" : "default"}
              onClick={() => action && transition.mutate(action)}
              disabled={!actionReady || transition.isPending}
            >
              {transition.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              {action ? cairActionButton(action) : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}

function CatalogueResolutionFields({
  kind,
  onKindChange,
  search,
  onSearchChange,
  items,
  loading,
  itemId,
  onItemChange,
}: {
  kind: CatalogueKind
  onKindChange: (kind: CatalogueKind) => void
  search: string
  onSearchChange: (value: string) => void
  items: CatalogueItem[]
  loading: boolean
  itemId: string
  onItemChange: (itemId: string) => void
}) {
  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Catalogue cost box</span>
        <Select
          value={kind}
          onValueChange={(value) => onKindChange(value as CatalogueKind)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalogueKinds.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Search official catalogue</span>
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Name or catalogue ID"
        />
      </label>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Official catalogue item</span>
        <Select
          value={itemId}
          onValueChange={onItemChange}
          disabled={loading || items.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                loading
                  ? "Loading official catalogue…"
                  : items.length === 0
                    ? "No matching official items"
                    : "Select the resolving item"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.catalogueId} · {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
}

function isNonNegativeDecimalOrBlank(value: string): boolean {
  if (!value.trim()) return true
  const number = Number(value)
  return Number.isFinite(number) && number >= 0
}

function formatByteSize(value: string | null): string {
  if (value === null) return "size unavailable"
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return "size unavailable"
  if (bytes < 1_024) return `${bytes} B`
  return `${(bytes / 1_024).toFixed(1)} KB`
}

function cairActionTitle(action: CairAction): string {
  if (action === "submit") return "Submit CAIR"
  if (action === "resolve") return "Resolve from official catalogue"
  if (action === "reject") return "Reject CAIR"
  return "Cancel CAIR"
}

function cairActionDescription(action: CairAction): string {
  if (action === "submit") {
    return "Submission freezes every attached file hash, byte size, evidence version, and metadata record. Enter the external request reference returned by the catalogue authority."
  }
  if (action === "resolve") {
    return "Only an item in the immutable governing catalogue release can resolve this request for report readiness."
  }
  if (action === "reject") {
    return "Record the external authority reference and decision note. A rejected request does not clear report readiness."
  }
  return "Cancellation is terminal. The request remains in the audit history and cannot be returned to draft."
}

function cairActionButton(action: CairAction): string {
  if (action === "submit") return "Submit and freeze evidence"
  if (action === "resolve") return "Record official resolution"
  if (action === "reject") return "Record rejection"
  return "Confirm cancellation"
}

function cairActionSuccess(action: CairAction): string {
  if (action === "submit") return "CAIR submitted and evidence frozen"
  if (action === "resolve") return "Official catalogue resolution recorded"
  if (action === "reject") return "CAIR rejection recorded"
  return "CAIR cancelled"
}
