import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileWarning, LoaderCircle, Plus } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Textarea } from "@/components/ui/textarea"
import { CairRecord } from "@/features/reports/cair-record"
import {
  EmptyState,
  LoadingRows,
  MutationError,
} from "@/features/reports/workflow-ui"
import { workflowMutationErrorMessage } from "@/features/reports/workflow-utils"
import { api } from "@/lib/api"

export function CairPanel({
  projectId,
  catalogueReleaseId,
  canWrite,
}: {
  projectId: string
  catalogueReleaseId: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const requests = useQuery({
    queryKey: ["cairs", projectId],
    queryFn: () => api.cairs(projectId),
  })
  const evidence = useQuery({
    queryKey: ["evidence", projectId],
    queryFn: () => api.evidence(projectId),
  })
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState("")
  const [rationale, setRationale] = useState("")
  const [proposedCost, setProposedCost] = useState("")
  const create = useMutation({
    mutationFn: () =>
      api.createCair(projectId, {
        requestedCatalogueDescription: description.trim(),
        rationale: rationale.trim(),
        proposedCost: proposedCost.trim() || null,
        provenance: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["cairs", projectId] })
      setDescription("")
      setRationale("")
      setProposedCost("")
      setOpen(false)
      toast.success("CAIR draft created")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const validCost = isNonNegativeDecimalOrBlank(proposedCost)

  return (
    <div className="space-y-4">
      <Alert>
        <FileWarning />
        <AlertTitle>External catalogue authority</AlertTitle>
        <AlertDescription>
          A CAIR draft or submitted request does not approve a private price.
          Report readiness clears only when an immutable official catalogue
          release contains or links the requested item.
        </AlertDescription>
      </Alert>
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)} disabled={!canWrite}>
          <Plus />
          New CAIR draft
        </Button>
      </div>
      {requests.isLoading ? (
        <LoadingRows label="Loading CAIRs…" />
      ) : requests.isError ? (
        <MutationError error={requests.error} />
      ) : (requests.data?.cairs.length ?? 0) === 0 ? (
        <EmptyState>No CAIR records yet.</EmptyState>
      ) : (
        <div className="divide-y rounded-lg border">
          {requests.data?.cairs.map((request) => (
            <CairRecord
              key={request.id}
              request={request}
              projectId={projectId}
              catalogueReleaseId={catalogueReleaseId}
              evidence={evidence.data?.evidence ?? []}
              evidenceLoading={evidence.isLoading}
              canWrite={canWrite}
            />
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create CAIR draft</DialogTitle>
            <DialogDescription>
              Record the requested official catalogue description and why the
              current verified release is insufficient.
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
                placeholder="0.00"
                aria-invalid={!validCost}
              />
              {!validCost && (
                <span className="text-xs text-destructive">
                  Enter zero or a positive decimal amount.
                </span>
              )}
            </label>
          </div>
          <MutationError error={create.error} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !description.trim() ||
                !rationale.trim() ||
                !validCost
              }
            >
              {create.isPending && <LoaderCircle className="animate-spin" />}
              Create draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function isNonNegativeDecimalOrBlank(value: string): boolean {
  if (!value.trim()) return true
  const number = Number(value)
  return Number.isFinite(number) && number >= 0
}
