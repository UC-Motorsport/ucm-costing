import { useEffect, useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Info, LoaderCircle, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { useUnsavedChangesRegistration } from "@/hooks/use-unsaved-changes"
import { api, type ProjectDetail } from "@/lib/api"

export function ReportSetupPage({
  detail,
  canWrite,
}: {
  detail: ProjectDetail
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const { project } = detail
  const [projectSummary, setProjectSummary] = useState(
    project.project_summary,
  )
  const [numberingConvention, setNumberingConvention] = useState(
    project.numbering_convention,
  )
  const [bulkMethodSummary, setBulkMethodSummary] = useState(
    project.bulk_method_summary,
  )
  const [attested, setAttested] = useState(false)

  useEffect(() => {
    setProjectSummary(project.project_summary)
    setNumberingConvention(project.numbering_convention)
    setBulkMethodSummary(project.bulk_method_summary)
    setAttested(false)
  }, [
    project.bulk_method_summary,
    project.numbering_convention,
    project.project_summary,
    project.version,
  ])

  const save = useMutation({
    mutationFn: () =>
      api.updateWorkspace(project.id, {
        expectedVersion: project.version,
        projectSummary,
        numberingConvention,
        bulkMethodSummary,
      }),
    onSuccess: async () => {
      await invalidateSetupQueries(queryClient, project.id)
      toast.success("Report setup saved")
    },
    onError: showSetupMutationError,
  })

  const confirm = useMutation({
    mutationFn: () => api.confirmReportSetup(project.id, project.version),
    onSuccess: async () => {
      setAttested(false)
      await invalidateSetupQueries(queryClient, project.id)
      toast.success("Report setup confirmed")
    },
    onError: showSetupMutationError,
  })

  const missingRequired =
    !setupFieldIsSubstantive(projectSummary, 40) ||
    !setupFieldIsSubstantive(numberingConvention, 10) ||
    !setupFieldIsSubstantive(bulkMethodSummary, 20)
  const hasDraft =
    projectSummary !== project.project_summary ||
    numberingConvention !== project.numbering_convention ||
    bulkMethodSummary !== project.bulk_method_summary
  const confirmation = project.report_setup_confirmation
  const mutationPending = save.isPending || confirm.isPending

  useEffect(() => {
    if (hasDraft) setAttested(false)
  }, [hasDraft])

  useUnsavedChangesRegistration(
    `report-setup:${project.id}`,
    hasDraft,
    { label: "Report setup" },
  )

  useEffect(() => {
    const field = new URLSearchParams(window.location.search).get("field")
    if (field) focusSetupField(field)
  }, [project.id])

  return (
    <div className="mx-auto max-w-4xl">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle
                id="report-setup"
                tabIndex={-1}
                className="outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
              >
                Report setup
              </CardTitle>
            </div>
            <Badge
              variant={hasDraft || !confirmation ? "destructive" : "outline"}
              aria-live="polite"
            >
              {mutationPending
                ? "Saving…"
                : hasDraft
                  ? "Unsaved changes"
                  : confirmation
                    ? "Confirmed"
                    : "Confirmation required"}
            </Badge>
          </div>
        </CardHeader>
        <fieldset disabled={!canWrite} className="contents">
        <CardContent className="space-y-5">
          <SetupField label="Cost-management summary">
            <Textarea
              id="project-summary"
              value={projectSummary}
              onChange={(event) => setProjectSummary(event.target.value)}
              rows={7}
              placeholder="Performance-versus-manufacturing-cost decisions"
            />
          </SetupField>
          <SetupField label="Part-numbering convention">
            <Textarea
              id="numbering-convention"
              value={numberingConvention}
              onChange={(event) =>
                setNumberingConvention(event.target.value)
              }
              rows={4}
              placeholder="Explain every identifier segment and variant"
            />
          </SetupField>
          <SetupField label="Bulk-manufacturing methods">
            <Textarea
              id="bulk-method-summary"
              value={bulkMethodSummary}
              onChange={(event) => setBulkMethodSummary(event.target.value)}
              rows={5}
              placeholder="Describe each bulk method and where it applies"
            />
          </SetupField>
          <Alert>
            {confirmation ? <ShieldCheck /> : <Info />}
            <AlertTitle>
              {confirmation
                ? hasDraft
                  ? "Saved-version confirmation"
                  : "Active setup confirmation"
                : "No active setup confirmation"}
            </AlertTitle>
            <AlertDescription>
              {confirmation ? (
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Confirmed by</dt>
                    <dd className="font-medium">
                      {confirmation.confirmedBy.displayName} ·{" "}
                      {confirmation.confirmedBy.email}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      Server-recorded time
                    </dt>
                    <dd className="font-medium">
                      <time dateTime={confirmation.confirmedAt}>
                        {new Date(
                          confirmation.confirmedAt,
                        ).toLocaleString("en-NZ")}
                      </time>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">
                      Confirmed content SHA-256
                    </dt>
                    <dd className="break-all font-mono text-[11px]">
                      {confirmation.contentHash}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p>
                  Saving and confirming are separate actions. Confirmation is
                  recorded by the server with the actor, server time, workspace
                  version, and hash of these exact three saved fields.
                </p>
              )}
            </AlertDescription>
          </Alert>
          <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[#b51031]"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
              disabled={hasDraft || missingRequired || mutationPending}
            />
            <span>
              <span className="block font-medium">
                Confirm the saved report setup
              </span>
              <span className="mt-1 block text-muted-foreground">
                I attest that these three saved summaries are complete for the
                current vehicle and are the exact content I intend to use in
                generated reports.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span
              className="mr-auto text-xs font-medium text-muted-foreground"
              aria-live="polite"
            >
              {save.isPending
                ? "Saving report setup…"
                : confirm.isPending
                  ? "Recording confirmation…"
                  : hasDraft
                    ? "Unsaved changes"
                    : confirmation
                      ? "Saved version is confirmed"
                      : "Saved; confirmation required"}
            </span>
            <Button
              variant="outline"
              onClick={() => save.mutate()}
              disabled={mutationPending || missingRequired || !hasDraft}
            >
              {save.isPending && <LoaderCircle className="animate-spin" />}
              Save changes
            </Button>
            <Button
              onClick={() => confirm.mutate()}
              disabled={
                mutationPending ||
                hasDraft ||
                missingRequired ||
                !attested
              }
            >
              {confirm.isPending && <LoaderCircle className="animate-spin" />}
              Confirm report setup
            </Button>
          </div>
        </CardContent>
        </fieldset>
      </Card>
    </div>
  )
}

function SetupField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

function setupFieldIsSubstantive(
  value: string,
  minimumLength: number,
): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized.length < minimumLength) return false
  return !(
    /^(todo|tbd|test|demo|placeholder|replace me)[.!]?$/.test(normalized) ||
    normalized.includes("mvp seed is deliberately incomplete") ||
    normalized.includes("synthetic demonstration vehicle")
  )
}

function focusSetupField(id: string): void {
  window.requestAnimationFrame(() => {
    const target = document.getElementById(id)
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    target?.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    })
    target?.focus({ preventScroll: true })
  })
}

async function invalidateSetupQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["workspace"] }),
    queryClient.invalidateQueries({ queryKey: ["validation", projectId] }),
  ])
}

function showSetupMutationError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Request failed")
}
