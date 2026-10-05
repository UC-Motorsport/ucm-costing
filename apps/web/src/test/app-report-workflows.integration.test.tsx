import { useQuery } from "@tanstack/react-query"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { ReportWorkflowOperations } from "@/features/reports/report-workflow-operations"
import {
  api,
  type Artifact,
  type CairRequest,
  type CostAmendment,
  type Report,
  type Submission,
} from "@/lib/api"
import {
  adminUserFixture,
  authSessionFixture,
  projectDetailFixture,
  projectSetupConfirmationFixture,
  projectSummaryFixture,
  reportFixture,
  validationFixture,
} from "@/test/fixtures"
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()

function renderReports() {
  return renderWithProviders(<ReportWorkflowHarness />)
}

const readyValidation = {
  ...validationFixture,
  blockers: 0,
  warnings: 0,
  notices: 0,
  readyForCompetitionReport: true,
  issues: [],
}

const readyReport = {
  ...reportFixture,
  id: "report-ready-test",
  mode: "competition-ready",
  validation: readyValidation,
} satisfies Report

function ReportWorkflowHarness() {
  const session = useQuery({
    queryKey: ["workflow-test-session"],
    queryFn: api.currentSession,
  })
  if (!session.data) return null

  return (
    <ReportWorkflowOperations
      projectId={projectSummaryFixture.id}
      catalogueReleaseId={projectSummaryFixture.catalogue_release_id}
      reports={[readyReport]}
      canWrite
    />
  )
}

function useReadyProject() {
  server.use(
    http.get(apiUrl("/api/projects"), () =>
      HttpResponse.json({
        projects: [
          {
            ...projectSummaryFixture,
            report_setup_confirmed: 1,
            report_setup_confirmation: projectSetupConfirmationFixture,
          },
        ],
      }),
    ),
    http.get(apiUrl("/api/projects/:projectId"), () =>
      HttpResponse.json({
        ...projectDetailFixture,
        project: {
          ...projectDetailFixture.project,
          report_setup_confirmed: 1,
          report_setup_confirmation: projectSetupConfirmationFixture,
        },
      }),
    ),
    http.get(apiUrl("/api/projects/:projectId/validation"), () =>
      HttpResponse.json(readyValidation),
    ),
    http.get(apiUrl("/api/projects/:projectId/reports"), () =>
      HttpResponse.json({ reports: [readyReport] }),
    ),
  )
}

function workbookArtifact(): Artifact {
  return {
    id: "artifact-workbook-test",
    project_id: projectSummaryFixture.id,
    kind: "supporting-workbook",
    status: "complete",
    content_sha256: "workbook-content-sha256",
    byte_size: 8192,
    mime_type:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    report_snapshot_id: readyReport.id,
    metadata_json: { filename: "supporting-cost-data.xlsx" },
    created_by: adminUserFixture.id,
    created_at: "2026-07-30T01:00:00.000Z",
    completed_at: "2026-07-30T01:00:01.000Z",
    error_message: null,
    version: 1,
    downloadUrl: "/api/artifacts/artifact-workbook-test/download",
  }
}

describe("immutable report workflow operations", () => {
  it("generates a supporting workbook and creates an explicit CAIR draft", async () => {
    useReadyProject()
    let artifacts: Artifact[] = []
    let cairs: CairRequest[] = []
    let workbookCsrf: string | null = null
    let cairCsrf: string | null = null
    let cairBody: unknown
    server.use(
      http.get(apiUrl("/api/projects/:projectId/artifacts"), () =>
        HttpResponse.json({ artifacts }),
      ),
      http.post(
        apiUrl("/api/reports/:reportId/supporting-workbook"),
        ({ request }) => {
          workbookCsrf = request.headers.get("x-csrf-token")
          const artifact = workbookArtifact()
          artifacts = [artifact]
          return HttpResponse.json({ artifact }, { status: 201 })
        },
      ),
      http.get(apiUrl("/api/projects/:projectId/cairs"), () =>
        HttpResponse.json({ cairs }),
      ),
      http.post(
        apiUrl("/api/projects/:projectId/cairs"),
        async ({ request }) => {
          cairCsrf = request.headers.get("x-csrf-token")
          cairBody = await request.json()
          const cair = {
            id: "cair-test",
            project_id: projectSummaryFixture.id,
            cost_line_id: null,
            status: "draft",
            requested_catalogue_description:
              "6061-T6 plate, 12 mm, verified bulk stock",
            rationale:
              "The current official release has no equivalent stock entry.",
            proposed_cost: "42.50",
            provenance_json: {},
            external_reference: null,
            decision_note: null,
            resolved_catalogue_release_id: null,
            resolved_catalogue_item_id: null,
            created_by: adminUserFixture.id,
            updated_by: adminUserFixture.id,
            decided_by: null,
            created_at: "2026-07-30T01:05:00.000Z",
            updated_at: "2026-07-30T01:05:00.000Z",
            submitted_at: null,
            decided_at: null,
            version: 0,
          } satisfies CairRequest
          cairs = [cair]
          return HttpResponse.json({ cair }, { status: 201 })
        },
      ),
    )
    const { user } = renderReports()

    expect(
      await screen.findByRole("heading", {
        name: "Report operations",
      }),
    ).toBeInTheDocument()
    const generate = screen.getByRole("button", {
      name: "Generate XLSX",
    })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)

    expect(
      await screen.findByText("supporting-cost-data.xlsx"),
    ).toBeInTheDocument()
    expect(workbookCsrf).toBe(authSessionFixture.csrfToken)

    await user.click(screen.getByRole("tab", { name: "CAIRs" }))
    expect(
      await screen.findByText("External catalogue authority"),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "New CAIR draft" }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Create CAIR draft",
    })
    await user.type(
      within(dialog).getByLabelText(
        "Requested catalogue description",
      ),
      "6061-T6 plate, 12 mm, verified bulk stock",
    )
    await user.type(
      within(dialog).getByLabelText("Rationale"),
      "The current official release has no equivalent stock entry.",
    )
    await user.type(
      within(dialog).getByLabelText(
        "Proposed Universal $ cost (optional)",
      ),
      "42.50",
    )
    await user.click(
      within(dialog).getByRole("button", { name: "Create draft" }),
    )

    expect(
      await screen.findByText(
        "6061-T6 plate, 12 mm, verified bulk stock",
      ),
    ).toBeInTheDocument()
    expect(cairBody).toEqual({
      requestedCatalogueDescription:
        "6061-T6 plate, 12 mm, verified bulk stock",
      rationale:
        "The current official release has no equivalent stock entry.",
      proposedCost: "42.50",
      provenance: {},
    })
    expect(cairCsrf).toBe(authSessionFixture.csrfToken)
  })

  it("creates only a watermarked amendment preview and renders server lock blockers", async () => {
    useReadyProject()
    let artifacts: Artifact[] = []
    let amendments: CostAmendment[] = []
    let createBody: unknown
    const csrfHeaders: Array<string | null> = []
    server.use(
      http.get(apiUrl("/api/projects/:projectId/artifacts"), () =>
        HttpResponse.json({ artifacts }),
      ),
      http.get(
        apiUrl("/api/projects/:projectId/cost-amendments"),
        () => HttpResponse.json({ amendments }),
      ),
      http.post(
        apiUrl("/api/projects/:projectId/cost-amendments"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          createBody = await request.json()
          const amendment = {
            id: "amendment-test",
            project_id: projectSummaryFixture.id,
            event_reference: "Round 2 scrutineering replacement",
            status: "draft",
            base_report_snapshot_id: readyReport.id,
            total_additions: "0",
            total_removals: "0",
            net_change: "0",
            external_reference: null,
            created_by: adminUserFixture.id,
            updated_by: adminUserFixture.id,
            locked_by: null,
            submitted_by: null,
            decided_by: null,
            created_at: "2026-07-30T01:10:00.000Z",
            updated_at: "2026-07-30T01:10:00.000Z",
            locked_at: null,
            exported_at: null,
            submitted_at: null,
            decided_at: null,
            version: 0,
          } satisfies CostAmendment
          amendments = [amendment]
          return HttpResponse.json({ amendment }, { status: 201 })
        },
      ),
      http.post(
        apiUrl("/api/cost-amendments/:amendmentId/preview"),
        ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const artifact = {
            id: "artifact-amendment-preview",
            project_id: projectSummaryFixture.id,
            kind: "cost-amendment",
            status: "complete",
            content_sha256: "preview-content-sha256",
            byte_size: 4096,
            mime_type: "application/pdf",
            report_snapshot_id: readyReport.id,
            metadata_json: {
              filename: "cost-amendment-PREVIEW.pdf",
              previewOnly: true,
              amendmentId: "amendment-test",
            },
            created_by: adminUserFixture.id,
            created_at: "2026-07-30T01:11:00.000Z",
            completed_at: "2026-07-30T01:11:01.000Z",
            error_message: null,
            version: 1,
            downloadUrl:
              "/api/artifacts/artifact-amendment-preview/download",
          } satisfies Artifact
          artifacts = [artifact]
          return HttpResponse.json({ artifact }, { status: 201 })
        },
      ),
      http.post(
        apiUrl("/api/cost-amendments/:amendmentId/lock"),
        ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          return HttpResponse.json(
            {
              error: {
                code: "workflow-blocked",
                message: "The final amendment cannot be locked.",
                issues: [
                  {
                    code: "official-car-template-unverified",
                    severity: "blocker",
                    message:
                      "The official 2026 cost amendment template is not in the verified source set.",
                  },
                ],
              },
            },
            { status: 422 },
          )
        },
      ),
    )
    const { user } = renderReports()

    await screen.findByRole("heading", { name: "Report operations" })
    await user.click(
      screen.getByRole("tab", { name: "Cost amendments" }),
    )
    expect(
      await screen.findByText("Final cost amendment is blocked"),
    ).toBeInTheDocument()
    const newDraft = screen.getByRole("button", {
      name: "New amendment draft",
    })
    await waitFor(() => expect(newDraft).toBeEnabled())
    await user.click(newDraft)
    const dialog = await screen.findByRole("dialog", {
      name: "Create cost amendment draft",
    })
    await user.type(
      within(dialog).getByLabelText("Event reference"),
      "Round 2 scrutineering replacement",
    )
    const create = within(dialog).getByRole("button", {
      name: "Create draft",
    })
    await waitFor(() => expect(create).toBeEnabled())
    await user.click(create)

    expect(
      await screen.findByText("Round 2 scrutineering replacement"),
    ).toBeInTheDocument()
    expect(createBody).toEqual({
      eventReference: "Round 2 scrutineering replacement",
      baseReportSnapshotId: readyReport.id,
    })

    await user.click(
      screen.getByRole("button", { name: "Generate preview" }),
    )
    expect(
      await screen.findByRole("link", { name: "Download preview" }),
    ).toHaveAttribute(
      "href",
      "/api/artifacts/artifact-amendment-preview/download",
    )
    await user.click(
      screen.getByRole("button", {
        name: "Check final eligibility",
      }),
    )

    expect(
      await screen.findByText("Final lock blocked"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /official 2026 cost amendment template is not in the verified source set/i,
      ),
    ).toBeInTheDocument()
    expect(
      csrfHeaders.every(
        (header) => header === authSessionFixture.csrfToken,
      ),
    ).toBe(true)
  })

  it("prepares locally, then requires explicit export and organizer receipt transitions", async () => {
    useReadyProject()
    let artifacts: Artifact[] = [workbookArtifact()]
    let submissions: Submission[] = []
    const requests: Array<{
      action: string
      body: unknown
      csrf: string | null
    }> = []
    const baseSubmission = {
      id: "submission-test",
      project_id: projectSummaryFixture.id,
      status: "prepared",
      report_snapshot_id: readyReport.id,
      cost_amendment_id: null,
      supporting_artifact_id: workbookArtifact().id,
      amendment_artifact_id: null,
      manifest_artifact_id: "artifact-manifest-test",
      package_artifact_id: "artifact-package-test",
      manifest_json: { reportSnapshotId: readyReport.id },
      external_reference: null,
      prepared_by: adminUserFixture.id,
      exported_by: null,
      submitted_by: null,
      prepared_at: "2026-07-30T01:20:00.000Z",
      exported_at: null,
      submitted_at: null,
      version: 0,
    } satisfies Submission
    const packageArtifact = {
      id: "artifact-package-test",
      project_id: projectSummaryFixture.id,
      kind: "submission-package",
      status: "complete",
      content_sha256: "package-content-sha256",
      byte_size: 16384,
      mime_type: "application/zip",
      report_snapshot_id: readyReport.id,
      metadata_json: { filename: "competition-submission.zip" },
      created_by: adminUserFixture.id,
      created_at: "2026-07-30T01:20:00.000Z",
      completed_at: "2026-07-30T01:20:01.000Z",
      error_message: null,
      version: 1,
      downloadUrl: "/api/artifacts/artifact-package-test/download",
    } satisfies Artifact
    const manifestArtifact = {
      ...packageArtifact,
      id: "artifact-manifest-test",
      kind: "submission-manifest",
      mime_type: "application/json",
      metadata_json: { filename: "manifest.json" },
      downloadUrl: "/api/artifacts/artifact-manifest-test/download",
    } satisfies Artifact

    server.use(
      http.get(apiUrl("/api/projects/:projectId/artifacts"), () =>
        HttpResponse.json({ artifacts }),
      ),
      http.get(apiUrl("/api/projects/:projectId/submissions"), () =>
        HttpResponse.json({ submissions }),
      ),
      http.post(
        apiUrl("/api/projects/:projectId/submissions/prepare"),
        async ({ request }) => {
          requests.push({
            action: "prepare",
            body: await request.json(),
            csrf: request.headers.get("x-csrf-token"),
          })
          submissions = [baseSubmission]
          artifacts = [
            workbookArtifact(),
            packageArtifact,
            manifestArtifact,
          ]
          return HttpResponse.json(
            {
              submission: baseSubmission,
              packageArtifact,
              manifestArtifact,
            },
            { status: 201 },
          )
        },
      ),
      http.post(
        apiUrl("/api/submissions/:submissionId/exported"),
        async ({ request }) => {
          requests.push({
            action: "exported",
            body: await request.json(),
            csrf: request.headers.get("x-csrf-token"),
          })
          const submission = {
            ...baseSubmission,
            status: "exported",
            exported_by: adminUserFixture.id,
            exported_at: "2026-07-30T01:21:00.000Z",
            version: 1,
          } satisfies Submission
          submissions = [submission]
          return HttpResponse.json({ submission })
        },
      ),
      http.post(
        apiUrl("/api/submissions/:submissionId/manual-submission"),
        async ({ request }) => {
          const body = await request.json()
          requests.push({
            action: "manual",
            body,
            csrf: request.headers.get("x-csrf-token"),
          })
          const submission = {
            ...baseSubmission,
            status: "manually-submitted",
            exported_by: adminUserFixture.id,
            submitted_by: adminUserFixture.id,
            exported_at: "2026-07-30T01:21:00.000Z",
            submitted_at: "2026-07-30T01:22:00.000Z",
            external_reference: "Organizer receipt FSAE-A-2026-0091",
            version: 2,
          } satisfies Submission
          submissions = [submission]
          return HttpResponse.json({ submission })
        },
      ),
    )
    const { user } = renderReports()

    await screen.findByRole("heading", { name: "Report operations" })
    await user.click(
      screen.getByRole("tab", { name: "Submission package" }),
    )
    expect(
      await screen.findByText("Manual external submission"),
    ).toBeInTheDocument()
    const prepare = screen.getByRole("button", {
      name: "Prepare package",
    })
    await waitFor(() => expect(prepare).toBeEnabled())
    await user.click(prepare)

    expect(
      await screen.findByText(/Package prepared/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Download package" }),
    ).toHaveAttribute(
      "href",
      "/api/artifacts/artifact-package-test/download",
    )
    await user.click(
      screen.getByRole("button", {
        name: "Record package exported",
      }),
    )

    const receipt = await screen.findByLabelText(
      "Organizer receipt or external reference",
    )
    await user.type(receipt, "Organizer receipt FSAE-A-2026-0091")
    await user.click(
      screen.getByRole("button", {
        name: "Record manual submission",
      }),
    )

    expect(
      await screen.findByText("External receipt recorded"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Organizer receipt FSAE-A-2026-0091"),
    ).toBeInTheDocument()
    expect(requests).toEqual([
      {
        action: "prepare",
        body: {
          reportSnapshotId: readyReport.id,
          supportingArtifactId: workbookArtifact().id,
        },
        csrf: authSessionFixture.csrfToken,
      },
      {
        action: "exported",
        body: { expectedVersion: 0 },
        csrf: authSessionFixture.csrfToken,
      },
      {
        action: "manual",
        body: {
          expectedVersion: 1,
          externalReference: "Organizer receipt FSAE-A-2026-0091",
        },
        csrf: authSessionFixture.csrfToken,
      },
    ])
  })
})
