import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { CairPanel } from "@/features/reports/cair-panel"
import { CostAmendmentPanel } from "@/features/reports/cost-amendment-panel"
import { SubmissionPanel } from "@/features/reports/submission-panel"
import { SupportingWorkbookPanel } from "@/features/reports/supporting-workbook-panel"
import { api, type Report } from "@/lib/api"

export function ReportWorkflowOperations({
  projectId,
  catalogueReleaseId,
  reports,
  canWrite,
}: {
  projectId: string
  catalogueReleaseId: string
  reports: Report[]
  canWrite: boolean
}) {
  const artifacts = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: () => api.artifacts(projectId),
  })
  const completeReports = reports.filter(
    ({ status }) => status === "complete",
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report operations</CardTitle>
        <p className="text-sm text-muted-foreground">
          Build supporting artifacts and record external workflows against
          immutable report snapshots. Preparing or downloading a package does
          not submit anything to an organizer.
        </p>
      </CardHeader>
      <CardContent>
        {!canWrite && (
          <Alert className="mb-4">
            <AlertTriangle />
            <AlertTitle>Read-only workspace access</AlertTitle>
            <AlertDescription>
              You can inspect workflow history and download completed
              artifacts, but only editors or administrators
              can create or transition records.
            </AlertDescription>
          </Alert>
        )}
        <Tabs defaultValue="workbook">
          <TabsList className="h-auto w-full justify-start overflow-x-auto">
            <TabsTrigger value="workbook">Workbook</TabsTrigger>
            <TabsTrigger value="cair">CAIRs</TabsTrigger>
            <TabsTrigger value="amendment">Cost amendments</TabsTrigger>
            <TabsTrigger value="submission">Submission package</TabsTrigger>
          </TabsList>
          <TabsContent value="workbook" className="pt-4">
            <SupportingWorkbookPanel
              projectId={projectId}
              reports={completeReports}
              artifacts={artifacts.data?.artifacts ?? []}
              artifactsLoading={artifacts.isLoading}
              canWrite={canWrite}
            />
          </TabsContent>
          <TabsContent value="cair" className="pt-4">
            <CairPanel
              projectId={projectId}
              catalogueReleaseId={catalogueReleaseId}
              canWrite={canWrite}
            />
          </TabsContent>
          <TabsContent value="amendment" className="pt-4">
            <CostAmendmentPanel
              projectId={projectId}
              reports={completeReports}
              artifacts={artifacts.data?.artifacts ?? []}
              canWrite={canWrite}
            />
          </TabsContent>
          <TabsContent value="submission" className="pt-4">
            <SubmissionPanel
              projectId={projectId}
              reports={completeReports}
              artifacts={artifacts.data?.artifacts ?? []}
              canWrite={canWrite}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
