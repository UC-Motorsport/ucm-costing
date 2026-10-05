import { useQuery } from "@tanstack/react-query"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { ReportWorkflowOperations } from "@/features/reports/report-workflow-operations"
import {
  api,
  type CairRequestDetail,
  type CostAmendment,
  type CostAmendmentDetail,
  type CostAmendmentItem,
  type Report,
} from "@/lib/api"
import {
  adminUserFixture,
  authSessionFixture,
  catalogueItemFixture,
  evidenceFixture,
  partNodeFixture,
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
  id: "report-ready-editor-test",
  mode: "competition-ready",
  validation: readyValidation,
} satisfies Report

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

function renderReports() {
  return renderWithProviders(<ReportWorkflowHarness />)
}

function ReportWorkflowHarness() {
  const session = useQuery({
    queryKey: ["workflow-editor-test-session"],
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

describe("CAIR and cost-amendment editors", () => {
  it("edits a CAIR draft, attaches and detaches existing evidence, then freezes provenance on submission", async () => {
    useReadyProject()
    const csrfHeaders: Array<string | null> = []
    const bodies: unknown[] = []
    let cair: CairRequestDetail = {
      id: "cair-editor-test",
      project_id: projectSummaryFixture.id,
      cost_line_id: null,
      status: "draft",
      requested_catalogue_description: "Unlisted upright billet",
      rationale: "The verified release does not contain this stock form.",
      proposed_cost: "25",
      provenance_json: { source: "design-review" },
      external_reference: null,
      decision_note: null,
      resolved_catalogue_release_id: null,
      resolved_catalogue_item_id: null,
      created_by: adminUserFixture.id,
      updated_by: adminUserFixture.id,
      decided_by: null,
      created_at: "2026-07-30T02:00:00.000Z",
      updated_at: "2026-07-30T02:00:00.000Z",
      submitted_at: null,
      decided_at: null,
      version: 0,
      attachments: [],
    }

    const attachment = {
      evidence_id: evidenceFixture.id,
      display_name: evidenceFixture.display_name,
      kind: evidenceFixture.kind,
      mime_type: evidenceFixture.mime_type,
      content_sha256: evidenceFixture.content_sha256,
      byte_size: "2048",
      evidence_version: evidenceFixture.version,
      attached_by: adminUserFixture.id,
      attached_by_display_name: adminUserFixture.displayName,
      attached_at: "2026-07-30T02:01:00.000Z",
      frozen_content_sha256: null,
      frozen_byte_size: null,
      frozen_evidence_version: null,
      frozen_metadata_json: null,
      frozen_at: null,
      download_url: evidenceFixture.downloadUrl,
    } satisfies CairRequestDetail["attachments"][number]

    server.use(
      http.get(apiUrl("/api/projects/:projectId/cairs"), () =>
        HttpResponse.json({ cairs: [cair] }),
      ),
      http.put(
        apiUrl("/api/cairs/:cairId"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const body = (await request.json()) as {
            requestedCatalogueDescription: string
            rationale: string
            proposedCost: string
            expectedVersion: number
          }
          bodies.push(body)
          cair = {
            ...cair,
            requested_catalogue_description:
              body.requestedCatalogueDescription,
            rationale: body.rationale,
            proposed_cost: body.proposedCost,
            updated_at: "2026-07-30T02:01:00.000Z",
            version: cair.version + 1,
          }
          return HttpResponse.json({ cair })
        },
      ),
      http.post(
        apiUrl("/api/cairs/:cairId/evidence"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          bodies.push(await request.json())
          cair = {
            ...cair,
            attachments: [attachment],
            version: cair.version + 1,
          }
          return HttpResponse.json({ cair })
        },
      ),
      http.delete(
        apiUrl("/api/cairs/:cairId/evidence/:evidenceId"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          bodies.push(await request.json())
          cair = {
            ...cair,
            attachments: [],
            version: cair.version + 1,
          }
          return HttpResponse.json({ cair })
        },
      ),
      http.post(
        apiUrl("/api/cairs/:cairId/transitions"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const body = (await request.json()) as {
            externalReference: string
          }
          bodies.push(body)
          cair = {
            ...cair,
            status: "submitted",
            external_reference: body.externalReference,
            submitted_at: "2026-07-30T02:05:00.000Z",
            updated_at: "2026-07-30T02:05:00.000Z",
            version: cair.version + 1,
            attachments: [
              {
                ...attachment,
                frozen_content_sha256: attachment.content_sha256,
                frozen_byte_size: attachment.byte_size,
                frozen_evidence_version: attachment.evidence_version,
                frozen_metadata_json: {
                  displayName: attachment.display_name,
                },
                frozen_at: "2026-07-30T02:05:00.000Z",
              },
            ],
          }
          return HttpResponse.json({ cair })
        },
      ),
    )

    const { user } = renderReports()
    await screen.findByRole("heading", { name: "Report operations" })
    await user.click(screen.getByRole("tab", { name: "CAIRs" }))

    await user.click(
      await screen.findByRole("button", { name: "Edit draft" }),
    )
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit CAIR draft",
    })
    const rationale = within(editDialog).getByLabelText("Rationale")
    await user.clear(rationale)
    await user.type(
      rationale,
      "Updated rationale tied to the verified catalogue gap.",
    )
    await user.click(
      within(editDialog).getByRole("button", { name: "Save draft" }),
    )
    expect(
      await screen.findByText(
        "Updated rationale tied to the verified catalogue gap.",
      ),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("combobox", { name: "Existing evidence" }),
    )
    await user.click(
      await screen.findByRole("option", {
        name: evidenceFixture.display_name,
      }),
    )
    await user.click(
      screen.getByRole("button", { name: "Attach existing evidence" }),
    )
    const cairRecord = () =>
      within(
        screen
          .getByText("Unlisted upright billet")
          .closest("article") as HTMLElement,
      )
    await waitFor(() =>
      expect(
        cairRecord().getByRole("link", { name: "Download" }),
      ).toHaveAttribute("href", evidenceFixture.downloadUrl),
    )

    await user.click(
      screen.getByRole("button", {
        name: `Detach ${evidenceFixture.display_name}`,
      }),
    )
    await waitFor(() =>
      expect(
        cairRecord().queryByRole("link", { name: "Download" }),
      ).not.toBeInTheDocument(),
    )

    await user.click(
      screen.getByRole("combobox", { name: "Existing evidence" }),
    )
    await user.click(
      await screen.findByRole("option", {
        name: evidenceFixture.display_name,
      }),
    )
    await user.click(
      screen.getByRole("button", { name: "Attach existing evidence" }),
    )
    await waitFor(() =>
      expect(
        cairRecord().getByRole("link", { name: "Download" }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole("button", { name: "Submit CAIR" }))
    const submitDialog = await screen.findByRole("dialog", {
      name: "Submit CAIR",
    })
    await user.type(
      within(submitDialog).getByLabelText("External reference"),
      "AUTHORITY-CAIR-2026-17",
    )
    await user.click(
      within(submitDialog).getByRole("button", {
        name: "Submit and freeze evidence",
      }),
    )

    expect(
      await screen.findByText("Provenance frozen at submission"),
    ).toBeInTheDocument()
    expect(screen.getByText(/Frozen version 0/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: `Detach ${evidenceFixture.display_name}`,
      }),
    ).not.toBeInTheDocument()
    expect(
      csrfHeaders.every(
        (header) => header === authSessionFixture.csrfToken,
      ),
    ).toBe(true)
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ expectedVersion: 0 }),
        expect.objectContaining({
          evidenceId: evidenceFixture.id,
        }),
        expect.objectContaining({
          next: "submitted",
          externalReference: "AUTHORITY-CAIR-2026-17",
        }),
      ]),
    )
  })

  it("adds, edits, and deletes authoritative amendment items without client-supplied prices", async () => {
    useReadyProject()
    const csrfHeaders: Array<string | null> = []
    const itemBodies: Array<Record<string, unknown>> = []
    const amendment = {
      id: "amendment-editor-test",
      project_id: projectSummaryFixture.id,
      event_reference: "Post-scrutineering upright change",
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
      created_at: "2026-07-30T03:00:00.000Z",
      updated_at: "2026-07-30T03:00:00.000Z",
      locked_at: null,
      exported_at: null,
      submitted_at: null,
      decided_at: null,
      version: 0,
    } satisfies CostAmendment
    let detail: CostAmendmentDetail = {
      amendment,
      items: [],
      blockers: [],
      baseReport: {
        catalogueReleaseId: projectSummaryFixture.catalogue_release_id,
        catalogueRevision: projectSummaryFixture.catalogue_revision,
        parts: [
          {
            id: partNodeFixture.id,
            fullNumber: partNodeFixture.full_number,
            referenceId: partNodeFixture.reference_id,
            name: partNodeFixture.name,
            quantity: partNodeFixture.quantity,
            breakdown: partNodeFixture.breakdown,
          },
        ],
      },
    }

    const serverItem = (
      body: Record<string, unknown>,
      id = "amendment-item-test",
    ) =>
      ({
        id,
        amendment_id: amendment.id,
        action: body.action,
        node_id: partNodeFixture.id,
        description: body.description,
        cost_box: catalogueItemFixture.kind,
        classification: body.classification,
        change_group_id: body.changeGroupId ?? null,
        quantity: body.quantity,
        original_quantity: body.originalQuantity,
        revised_quantity: body.revisedQuantity,
        unit_cost: catalogueItemFixture.fixedCost,
        subtotal: String(
          Number(body.quantity) *
            Number(catalogueItemFixture.fixedCost),
        ),
        source_json: {
          partIdentity: partNodeFixture.id,
          partNumber: partNodeFixture.full_number!,
          catalogueReleaseId: projectSummaryFixture.catalogue_release_id,
          catalogueItemId: catalogueItemFixture.id,
          catalogueId: catalogueItemFixture.catalogueId,
          catalogueItemName: catalogueItemFixture.name,
          sizeInputs: body.sizeInputs,
          derivedFrom:
            "immutable-base-report-and-official-catalogue",
        },
        sort_order: 0,
      }) as CostAmendmentItem

    server.use(
      http.get(
        apiUrl("/api/projects/:projectId/cost-amendments"),
        () => HttpResponse.json({ amendments: [detail.amendment] }),
      ),
      http.get(
        apiUrl("/api/cost-amendments/:amendmentId"),
        () => HttpResponse.json(detail),
      ),
      http.post(
        apiUrl("/api/cost-amendments/:amendmentId/items"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const body = (await request.json()) as Record<string, unknown>
          itemBodies.push(body)
          const item = serverItem(body)
          detail = {
            ...detail,
            amendment: {
              ...detail.amendment,
              total_additions: item.subtotal,
              net_change: item.subtotal,
              version: 1,
            },
            items: [item],
          }
          return HttpResponse.json(detail, { status: 201 })
        },
      ),
      http.put(
        apiUrl("/api/cost-amendments/:amendmentId/items/:itemId"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const body = (await request.json()) as Record<string, unknown>
          itemBodies.push(body)
          const item = serverItem(body)
          detail = {
            ...detail,
            amendment: {
              ...detail.amendment,
              total_additions: item.subtotal,
              net_change: item.subtotal,
              version: 2,
            },
            items: [item],
          }
          return HttpResponse.json(detail)
        },
      ),
      http.delete(
        apiUrl("/api/cost-amendments/:amendmentId/items/:itemId"),
        async ({ request }) => {
          csrfHeaders.push(request.headers.get("x-csrf-token"))
          const body = (await request.json()) as Record<string, unknown>
          itemBodies.push(body)
          detail = {
            ...detail,
            amendment: {
              ...detail.amendment,
              total_additions: "0",
              net_change: "0",
              version: 3,
            },
            items: [],
          }
          return HttpResponse.json(detail)
        },
      ),
    )

    const { user } = renderReports()
    await screen.findByRole("heading", { name: "Report operations" })
    await user.click(
      screen.getByRole("tab", { name: "Cost amendments" }),
    )
    await user.click(
      await screen.findByRole("button", { name: "View amendment items" }),
    )
    expect(
      await screen.findByText(/Base report catalogue 26_R1/),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Add amendment item" }),
    )
    const addDialog = await screen.findByRole("dialog", {
      name: "Add amendment item",
    })
    await user.type(
      within(addDialog).getByLabelText("Description"),
      "Replacement upright billet",
    )
    const quantity = within(addDialog).getByLabelText(
      "Quantity costed on this row",
    )
    await user.clear(quantity)
    await user.type(quantity, "2")
    await user.click(
      await within(addDialog).findByRole("button", {
        name: /Aluminium 6061-T6/,
      }),
    )
    await user.click(
      within(addDialog).getByRole("button", {
        name: "Calculate and add",
      }),
    )

    expect(
      await screen.findByText("Replacement upright billet"),
    ).toBeInTheDocument()
    expect(screen.getByText(/2 × U\$ 5\.25 = U\$ 10\.50/)).toBeInTheDocument()
    expect(itemBodies[0]).toEqual({
      expectedAmendmentVersion: 0,
      action: "add",
      partIdentity: partNodeFixture.id,
      catalogueItemId: catalogueItemFixture.id,
      sizeInputs: {},
      description: "Replacement upright billet",
      classification: "new",
      changeGroupId: null,
      quantity: "2",
      originalQuantity: "0",
      revisedQuantity: "2",
    })
    expect(itemBodies[0]).not.toHaveProperty("unitCost")
    expect(itemBodies[0]).not.toHaveProperty("source")
    expect(itemBodies[0]).not.toHaveProperty("costBox")

    await user.click(
      screen.getByRole("button", {
        name: "Edit Replacement upright billet",
      }),
    )
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit amendment item",
    })
    const description = within(editDialog).getByLabelText("Description")
    await user.clear(description)
    await user.type(description, "Replacement upright billet revised")
    await user.click(
      within(editDialog).getByRole("button", {
        name: "Recalculate and save",
      }),
    )
    expect(
      await screen.findByText("Replacement upright billet revised"),
    ).toBeInTheDocument()
    expect(itemBodies[1]).not.toHaveProperty("unitCost")
    expect(itemBodies[1]).not.toHaveProperty("source")

    await user.click(
      screen.getByRole("button", {
        name: "Delete Replacement upright billet revised",
      }),
    )
    const deleteDialog = await screen.findByRole("dialog", {
      name: "Delete amendment item?",
    })
    await user.click(
      within(deleteDialog).getByRole("button", {
        name: "Delete and recalculate",
      }),
    )
    expect(
      await screen.findByText(/No amendment items/),
    ).toBeInTheDocument()
    expect(itemBodies[2]).toEqual({ expectedAmendmentVersion: 2 })
    expect(
      csrfHeaders.every(
        (header) => header === authSessionFixture.csrfToken,
      ),
    ).toBe(true)
  })
})
