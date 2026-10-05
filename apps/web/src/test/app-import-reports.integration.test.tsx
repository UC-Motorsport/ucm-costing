import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import App from "@/App"
import type {
  ImportCommitResult,
  ImportPreview,
  LegacyImportRecord,
} from "@/lib/api"
import { importPreviewFixture, reportFixture } from "@/test/fixtures"
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) => new URL(path, window.location.origin).toString()

function renderApp(route: string) {
  window.history.replaceState(null, "", route)
  return renderWithProviders(<App />)
}

function candidateRecord(index: number): LegacyImportRecord {
  const rowNumber = index + 2
  const identifier = `SU.01.01.${String(index + 1).padStart(3, "0")}`
  return {
    recordKind: "component",
    system: "SU",
    hla: "01",
    subassembly: "01",
    partNumber: identifier,
    sourceKey: identifier,
    assemblyName: null,
    componentName: `Candidate part ${index + 1}`,
    quantityOnCar: 1,
    provenance: {
      rowNumber,
      rawCells: [identifier, `Candidate part ${index + 1}`],
      namedCells: {},
    },
  }
}

describe("import and report recovery workflows", () => {
  it("exports and downloads one neutral full report even with blockers", async () => {
    let requestedMode: string | undefined
    let downloadedUrl: string | undefined
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloadedUrl = this.href
      },
    )
    server.use(
      http.post(
        apiUrl("/api/projects/:projectId/reports"),
        async ({ request }) => {
          const body = (await request.json()) as { mode?: string }
          requestedMode = body.mode
          return HttpResponse.json(
            {
              report: {
                ...reportFixture,
                id: "report-export-test",
                mode: "export",
              },
            },
            { status: 201 },
          )
        },
      ),
    )

    const { user } = renderApp("/reports")
    const exportReport = await screen.findByRole("button", {
      name: "Export full report",
    })
    expect(exportReport).toBeEnabled()
    expect(screen.queryByText("Draft report")).not.toBeInTheDocument()
    expect(screen.queryByText("Deadline fallback")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Competition-ready report"),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Report operations")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Draft reports remain available/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Export" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Review \d+ blockers/ }),
    ).not.toBeInTheDocument()

    await user.click(exportReport)
    await waitFor(() => expect(requestedMode).toBe("export"))
    expect(downloadedUrl).toBe(apiUrl(reportFixture.downloadUrl!))
  })

  it("paginates preview candidates and renders an idempotent committed receipt", async () => {
    const records = Array.from({ length: 27 }, (_, index) =>
      candidateRecord(index),
    )
    const preview = {
      ...importPreviewFixture,
      preview: {
        ...importPreviewFixture.preview,
        rawRows: records.map((record) => ({
          rowNumber: record.provenance.rowNumber,
          cells: record.provenance.rawCells,
        })),
        records,
        stats: {
          rows: records.length,
          candidates: records.length,
        },
      },
    } satisfies ImportPreview
    const commitBodies: Array<{
      expectedVersion: number
      commitValidOnly: boolean
      idempotencyKey: string
    }> = []

    server.use(
      http.post(
        apiUrl("/api/projects/:projectId/imports/preview"),
        () => HttpResponse.json(preview, { status: 201 }),
      ),
      http.post(
        apiUrl("/api/imports/:batchId/commit"),
        async ({ request }) => {
          commitBodies.push(
            (await request.json()) as {
              expectedVersion: number
              commitValidOnly: boolean
              idempotencyKey: string
            },
          )
          return HttpResponse.json({
            batchId: preview.id,
            status: "committed",
            version: preview.version + 1,
            insertedNodes: records.length,
            skippedRows: 0,
            alreadyCommitted: true,
            committedAt: "2026-07-30T00:05:00.000Z",
          } satisfies ImportCommitResult)
        },
      ),
    )

    const { user } = renderApp("/import")
    await screen.findByRole("heading", {
      level: 1,
      name: "Import spreadsheet",
    })

    const input = await screen.findByLabelText(
      /Choose a CSV exported from the team workbook/,
    )
    await user.upload(
      input,
      new File(["system,name\nSU,Upright"], "test-bom.csv", {
        type: "text/csv",
      }),
    )
    await user.click(
      screen.getByRole("button", { name: "Create preview" }),
    )

    const candidateRegion = await screen.findByRole("region", {
      name: "Import candidate records",
    })
    expect(
      within(candidateRegion).getByText("Candidate part 1"),
    ).toBeInTheDocument()
    expect(
      within(candidateRegion).queryByText("Candidate part 26"),
    ).not.toBeInTheDocument()
    expect(screen.getByText("1–25 of 27")).toBeInTheDocument()

    const pagination = screen.getByLabelText("Candidate records pages")
    await user.click(
      within(pagination).getByRole("button", { name: "Next" }),
    )
    expect(
      within(candidateRegion).getByText("Candidate part 26"),
    ).toBeInTheDocument()
    expect(
      within(candidateRegion).queryByText("Candidate part 1"),
    ).not.toBeInTheDocument()
    expect(screen.getByText("26–27 of 27")).toBeInTheDocument()
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", {
        name: "Commit reviewed preview",
      }),
    )

    const receiptTitle = await screen.findByText(
      "Import already committed",
    )
    const receipt = receiptTitle.closest('[role="alert"]')
    expect(receipt).not.toBeNull()
    expect(receipt).toHaveTextContent(
      "The server recognised this completed batch and did not create duplicate nodes.",
    )
    expect(receipt).toHaveTextContent("Inserted nodes")
    expect(receipt).toHaveTextContent("27")
    expect(receipt).toHaveTextContent("Skipped rows")
    expect(
      within(receipt as HTMLElement).getByRole("button", {
        name: "View imported items",
      }),
    ).toBeEnabled()
    expect(
      screen.queryByRole("button", {
        name: "Commit reviewed preview",
      }),
    ).not.toBeInTheDocument()

    expect(commitBodies).toHaveLength(1)
    expect(commitBodies[0]).toMatchObject({
      expectedVersion: preview.version,
      commitValidOnly: false,
    })
    expect(commitBodies[0]?.idempotencyKey).toEqual(expect.any(String))
    expect(commitBodies[0]?.idempotencyKey.length).toBeGreaterThanOrEqual(8)
  })

  it("does not load legacy report history on the export page", async () => {
    let reportRequests = 0
    server.use(
      http.get(
        apiUrl("/api/projects/:projectId/reports"),
        () => {
          reportRequests += 1
          return HttpResponse.json({ reports: [] })
        },
      ),
    )

    renderApp("/reports")

    expect(
      await screen.findByRole("button", { name: "Export full report" }),
    ).toBeEnabled()
    expect(reportRequests).toBe(0)
  })
})
