import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { FileSpreadsheet, LoaderCircle } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ArtifactList,
  MutationError,
} from "@/features/reports/workflow-ui"
import { workflowMutationErrorMessage } from "@/features/reports/workflow-utils"
import { api, type Artifact, type Report } from "@/lib/api"

export function SupportingWorkbookPanel({
  projectId,
  reports,
  artifacts,
  artifactsLoading,
  canWrite,
}: {
  projectId: string
  reports: Report[]
  artifacts: Artifact[]
  artifactsLoading: boolean
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [reportId, setReportId] = useState("")
  const workbooks = artifacts.filter(
    ({ kind }) => kind === "supporting-workbook",
  )

  useEffect(() => {
    if (!reports.some(({ id }) => id === reportId)) {
      setReportId(reports[0]?.id ?? "")
    }
  }, [reportId, reports])

  const generate = useMutation({
    mutationFn: () => api.createSupportingWorkbook(reportId),
    onSuccess: async ({ artifact }) => {
      await queryClient.invalidateQueries({
        queryKey: ["artifacts", projectId],
      })
      toast.success("Supporting workbook generated")
      if (artifact.downloadUrl) {
        toast.success("Workbook is ready to download")
      }
    },
    onError: (error) => toast.error(workflowMutationErrorMessage(error)),
  })

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Immutable report snapshot</span>
          <Select value={reportId} onValueChange={setReportId}>
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
        <Button
          onClick={() => generate.mutate()}
          disabled={!canWrite || !reportId || generate.isPending}
        >
          {generate.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <FileSpreadsheet />
          )}
          Generate XLSX
        </Button>
      </div>
      <MutationError error={generate.error} />
      <ArtifactList
        artifacts={workbooks}
        loading={artifactsLoading}
        empty="No supporting workbooks have been generated."
      />
    </div>
  )
}
