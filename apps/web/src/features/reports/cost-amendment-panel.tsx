import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, LoaderCircle, Plus } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  EmptyState,
  LoadingRows,
  MutationError,
} from "@/features/reports/workflow-ui"
import { CostAmendmentRecord } from "@/features/reports/cost-amendment-record"
import { workflowMutationErrorMessage } from "@/features/reports/workflow-utils"
import {
  api,
  type Artifact,
  type Report,
} from "@/lib/api"

export function CostAmendmentPanel({
  projectId,
  reports,
  artifacts,
  canWrite,
}: {
  projectId: string
  reports: Report[]
  artifacts: Artifact[]
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const amendments = useQuery({
    queryKey: ["cost-amendments", projectId],
    queryFn: () => api.costAmendments(projectId),
  })
  const [open, setOpen] = useState(false)
  const [eventReference, setEventReference] = useState("")
  const [baseReportId, setBaseReportId] = useState("")

  useEffect(() => {
    if (!reports.some(({ id }) => id === baseReportId)) {
      setBaseReportId(reports[0]?.id ?? "")
    }
  }, [baseReportId, reports])

  const create = useMutation({
    mutationFn: () =>
      api.createCostAmendment(projectId, {
        eventReference: eventReference.trim(),
        baseReportSnapshotId: baseReportId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["cost-amendments", projectId],
      })
      setEventReference("")
      setOpen(false)
      toast.success("Cost amendment draft created")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  const previews = artifacts.filter(
    ({ kind, metadata_json }) =>
      kind === "cost-amendment" &&
      metadata_json.previewOnly === true,
  )

  return (
    <div className="space-y-4">
      <Alert className="border-amber-300 bg-amber-50 text-amber-950">
        <AlertTriangle className="text-amber-700" />
        <AlertTitle>Final cost amendment is blocked</AlertTitle>
        <AlertDescription>
          The verified source set does not contain the official 2026 CAR
          template or complete classification references. The server permits
          a watermarked preview only and rejects final lock with structured
          blockers.
        </AlertDescription>
      </Alert>
      <div className="flex justify-end">
        <Button
          onClick={() => setOpen(true)}
          disabled={!canWrite || reports.length === 0}
        >
          <Plus />
          New amendment draft
        </Button>
      </div>
      {amendments.isLoading ? (
        <LoadingRows label="Loading cost amendments…" />
      ) : amendments.isError ? (
        <MutationError error={amendments.error} />
      ) : (amendments.data?.amendments.length ?? 0) === 0 ? (
        <EmptyState>No cost amendment records yet.</EmptyState>
      ) : (
        <div className="divide-y rounded-lg border">
          {amendments.data?.amendments.map((amendment) => {
            const previewArtifact = previews.reduce<Artifact | null>(
              (latest, artifact) =>
                artifact.metadata_json.amendmentId === amendment.id &&
                (!latest ||
                  new Date(artifact.created_at).getTime() >
                    new Date(latest.created_at).getTime())
                  ? artifact
                  : latest,
              null,
            )
            return (
              <CostAmendmentRecord
                key={amendment.id}
                amendment={amendment}
                projectId={projectId}
                previewArtifact={previewArtifact}
                canWrite={canWrite}
              />
            )
          })}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create cost amendment draft</DialogTitle>
            <DialogDescription>
              Anchor the draft to one complete immutable report snapshot. This
              creates a record; it does not create or submit a final CAR.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Event reference</span>
              <Input
                value={eventReference}
                onChange={(event) => setEventReference(event.target.value)}
                maxLength={500}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Base report snapshot</span>
              <Select value={baseReportId} onValueChange={setBaseReportId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No complete report available" />
                </SelectTrigger>
                <SelectContent>
                  {reports.map((report) => (
                    <SelectItem key={report.id} value={report.id}>
                      {report.mode.replace("-", " ")} ·{" "}
                      {new Date(report.created_at).toLocaleString("en-NZ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                create.isPending || !eventReference.trim() || !baseReportId
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
