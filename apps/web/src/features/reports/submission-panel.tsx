import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  Download,
  FileArchive,
  LoaderCircle,
  PackageCheck,
  Send,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  artifactName,
  workflowMutationErrorMessage,
} from "@/features/reports/workflow-utils"
import {
  api,
  type Artifact,
  type Report,
  type Submission,
} from "@/lib/api"

export function SubmissionPanel({
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
  const submissions = useQuery({
    queryKey: ["submissions", projectId],
    queryFn: () => api.submissions(projectId),
  })
  const readyReports = reports.filter(
    ({ mode, validation }) =>
      mode === "competition-ready" &&
      validation.readyForCompetitionReport,
  )
  const workbooks = artifacts.filter(
    ({ kind, status }) =>
      kind === "supporting-workbook" && status === "complete",
  )
  const [reportId, setReportId] = useState("")
  const [workbookId, setWorkbookId] = useState("")

  useEffect(() => {
    if (!readyReports.some(({ id }) => id === reportId)) {
      setReportId(readyReports[0]?.id ?? "")
    }
  }, [readyReports, reportId])

  const matchingWorkbooks = useMemo(
    () =>
      workbooks.filter(
        ({ report_snapshot_id }) => report_snapshot_id === reportId,
      ),
    [reportId, workbooks],
  )

  useEffect(() => {
    if (!matchingWorkbooks.some(({ id }) => id === workbookId)) {
      setWorkbookId(matchingWorkbooks[0]?.id ?? "")
    }
  }, [matchingWorkbooks, workbookId])

  const prepare = useMutation({
    mutationFn: () =>
      api.prepareSubmission(projectId, {
        reportSnapshotId: reportId,
        supportingArtifactId: workbookId,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["submissions", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["artifacts", projectId],
        }),
      ])
      toast.success(
        "Submission package prepared; no external submission occurred",
      )
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  return (
    <div className="space-y-4">
      <Alert>
        <PackageCheck />
        <AlertTitle>Manual external submission</AlertTitle>
        <AlertDescription>
          This application prepares and verifies local files only. Record
          “manually submitted” only after the organizer has returned a receipt
          or external reference.
        </AlertDescription>
      </Alert>
      <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-2">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Competition-ready report</span>
          <Select value={reportId} onValueChange={setReportId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No eligible report" />
            </SelectTrigger>
            <SelectContent>
              {readyReports.map((report) => (
                <SelectItem key={report.id} value={report.id}>
                  {new Date(report.created_at).toLocaleString("en-NZ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Matching supporting workbook</span>
          <Select value={workbookId} onValueChange={setWorkbookId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Generate a matching workbook first" />
            </SelectTrigger>
            <SelectContent>
              {matchingWorkbooks.map((artifact) => (
                <SelectItem key={artifact.id} value={artifact.id}>
                  {artifactName(artifact)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="md:col-span-2">
          <Button
            onClick={() => prepare.mutate()}
            disabled={
              !canWrite ||
              !reportId ||
              !workbookId ||
              prepare.isPending
            }
          >
            {prepare.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <FileArchive />
            )}
            Prepare package
          </Button>
        </div>
        <MutationError error={prepare.error} />
      </div>
      {submissions.isLoading ? (
        <LoadingRows label="Loading submission records…" />
      ) : submissions.isError ? (
        <MutationError error={submissions.error} />
      ) : (submissions.data?.submissions.length ?? 0) === 0 ? (
        <EmptyState>No submission packages have been prepared.</EmptyState>
      ) : (
        <div className="space-y-3">
          {submissions.data?.submissions.map((submission) => (
            <SubmissionRecord
              key={submission.id}
              submission={submission}
              packageArtifact={
                artifacts.find(
                  ({ id }) => id === submission.package_artifact_id,
                ) ?? null
              }
              canWrite={canWrite}
              onChanged={() =>
                queryClient.invalidateQueries({
                  queryKey: ["submissions", projectId],
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SubmissionRecord({
  submission,
  packageArtifact,
  canWrite,
  onChanged,
}: {
  submission: Submission
  packageArtifact: Artifact | null
  canWrite: boolean
  onChanged: () => Promise<unknown>
}) {
  const [externalReference, setExternalReference] = useState(
    submission.external_reference ?? "",
  )
  const exported = useMutation({
    mutationFn: () =>
      api.markSubmissionExported(submission.id, submission.version),
    onSuccess: async () => {
      await onChanged()
      toast.success("Package export recorded")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })
  const manuallySubmitted = useMutation({
    mutationFn: () =>
      api.recordManualSubmission(
        submission.id,
        submission.version,
        externalReference.trim(),
      ),
    onSuccess: async () => {
      await onChanged()
      toast.success("External submission receipt recorded")
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">
            Package prepared{" "}
            {new Date(submission.prepared_at).toLocaleString("en-NZ")}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {submission.id}
          </div>
        </div>
        <Badge variant="outline" className="capitalize">
          {submission.status.replace("-", " ")}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {packageArtifact?.downloadUrl && (
          <Button size="sm" variant="outline" asChild>
            <a href={packageArtifact.downloadUrl}>
              <Download />
              Download package
            </a>
          </Button>
        )}
        {submission.status === "prepared" && (
          <Button
            size="sm"
            onClick={() => exported.mutate()}
            disabled={!canWrite || exported.isPending}
          >
            {exported.isPending && <LoaderCircle className="animate-spin" />}
            Record package exported
          </Button>
        )}
      </div>
      {submission.status === "exported" && (
        <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">
              Organizer receipt or external reference
            </span>
            <Input
              value={externalReference}
              onChange={(event) => setExternalReference(event.target.value)}
              maxLength={2_000}
            />
          </label>
          <Button
            onClick={() => manuallySubmitted.mutate()}
            disabled={
              !canWrite ||
              !externalReference.trim() ||
              manuallySubmitted.isPending
            }
          >
            {manuallySubmitted.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Send />
            )}
            Record manual submission
          </Button>
        </div>
      )}
      {submission.status === "manually-submitted" && (
        <Alert className="mt-4 border-emerald-300 bg-emerald-50 text-emerald-950">
          <Check className="text-emerald-700" />
          <AlertTitle>External receipt recorded</AlertTitle>
          <AlertDescription>
            <p>{submission.external_reference}</p>
            {submission.submitted_at && (
              <p className="mt-1 text-xs">
                Server-recorded{" "}
                {new Date(submission.submitted_at).toLocaleString("en-NZ")}
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <MutationError error={exported.error ?? manuallySubmitted.error} />
    </div>
  )
}
