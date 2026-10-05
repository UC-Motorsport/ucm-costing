import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"
import App from "@/App"
import { api } from "@/lib/api"
import type { CostLine, CostNode, Evidence } from "@/lib/api"
import {
  projectDetailFixture,
  partNodeFixture,
  evidenceFixture,
} from "@/test/fixtures"
import { renderWithProviders, screen, within, waitFor } from "@/test/render"
import { server } from "@/test/server"
const url = (path: string) => new URL(path, window.location.origin).toString()
const initialLines = ["Cut blank", "Drill holes", "Deburr"].map(
  (description, index): CostLine => ({
    id: `line-${index}`,
    node_id: partNodeFixture.id,
    kind: "process",
    description,
    use_description: "",
    unit_cost: "10",
    quantity: "1",
    subtotal: "10",
    multiplier: "1",
    multiplier_name: null,
    multiplier_catalogue_item_id: null,
    catalogue_item_id: null,
    fraction_included: "1",
    production_volume_factor: null,
    size_inputs_json: "{}",
    sort_order: index,
    version: 0,
  }),
)
function setup(section = "cost-lines", readOnly = false) {
  let lines = [...initialLines]
  const moves: {
    kind: string
    lines: { id: string; expectedVersion: number }[]
  }[] = []
  const deletes: { lines: { id: string; expectedVersion: number }[] }[] = []
  server.use(
    http.get(url("/api/projects/:projectId"), () => {
      const rewrite = (node: CostNode): CostNode => ({
        ...node,
        ...(node.id === partNodeFixture.id
          ? {
              costLines: lines,
              quantity: "4",
              breakdown: {
                material: "0",
                process: String(lines.length * 10),
                fastener: "0",
                tooling: "0",
                total: String(lines.length * 10),
              },
            }
          : {}),
        children: node.children.map(rewrite),
      })
      return HttpResponse.json({
        ...projectDetailFixture,
        project: {
          ...projectDetailFixture.project,
          ...(readOnly ? { status: "submitted" } : {}),
        },
        tree: rewrite(projectDetailFixture.tree),
        flatNodes: projectDetailFixture.flatNodes.map(rewrite),
      })
    }),
    http.patch(
      url(`/api/nodes/${partNodeFixture.id}/cost-lines/order`),
      async ({ request }) => {
        const input = (await request.json()) as (typeof moves)[number]
        moves.push(input)
        lines = input.lines.map(({ id }, index) => ({
          ...lines.find((line) => line.id === id)!,
          version: 1,
          sort_order: index,
        }))
        return new HttpResponse(null, { status: 204 })
      },
    ),
    http.post(
      url(`/api/nodes/${partNodeFixture.id}/cost-lines/delete-batch`),
      async ({ request }) => {
        const input = (await request.json()) as (typeof deletes)[number]
        deletes.push(input)
        lines = lines.filter(
          (line) => !input.lines.some((selected) => selected.id === line.id),
        )
        return new HttpResponse(null, { status: 204 })
      },
    ),
  )
  window.history.replaceState(
    null,
    "",
    `/?node=${partNodeFixture.id}&section=${section}`,
  )
  return { ...renderWithProviders(<App />), moves, deletes }
}
describe("cost sheet improvements", () => {
  it("moves a process, confirms a selection, and deletes with the refreshed versions", async () => {
    const { user, moves, deletes } = setup()
    await user.click(
      await screen.findByRole("button", { name: "Move Deburr up" }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move Drill holes down" }),
      ).toBeDisabled(),
    )
    expect(moves[0]?.lines.map((line) => line.id)).toEqual([
      "line-0",
      "line-2",
      "line-1",
    ])
    await user.click(screen.getByRole("checkbox", { name: "Select Cut blank" }))
    await user.click(screen.getByRole("checkbox", { name: "Select Deburr" }))
    await user.click(screen.getByRole("button", { name: "Delete selected" }))
    const dialog = screen.getByRole("dialog", { name: "Delete 2 cost items?" })
    expect(dialog).toHaveTextContent("Cut blank")
    expect(deletes).toHaveLength(0)
    await user.click(
      within(dialog).getByRole("button", { name: "Delete 2 items" }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("checkbox", { name: "Select Cut blank" }),
      ).not.toBeInTheDocument(),
    )
    expect(deletes[0]?.lines).toEqual([
      { id: "line-0", expectedVersion: 1 },
      { id: "line-2", expectedVersion: 1 },
    ])
    expect(
      screen.getByText("Total for quantity 4, incl. children"),
    ).toBeInTheDocument()
    expect(screen.getByText("U$ 40.00")).toBeInTheDocument()
  })
  it("hides mutation controls on a locked project", async () => {
    setup("cost-lines", true)
    await screen.findByText("Cost sheet")
    expect(
      screen.queryByRole("button", { name: "Delete selected" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Move Deburr up" }),
    ).not.toBeInTheDocument()
  })
  it("uploads several drawings and keeps only failed/pending files for retry", async () => {
    const attached: Evidence[] = []
    const uploads: string[] = []
    let fail = true
    server.use(
      http.get(url("/api/projects/:projectId/evidence"), () =>
        HttpResponse.json({ evidence: attached }),
      ),
    )
    const upload = vi
      .spyOn(api, "uploadEvidence")
      .mockImplementation(async (_projectId, file, options) => {
        uploads.push(file.name)
        if (file.name === "sheet-2.pdf" && fail) {
          fail = false
          throw new Error("Upload failed")
        }
        const item = {
          ...evidenceFixture,
          id: file.name,
          display_name: file.name,
          report_caption: options.reportCaption ?? "",
        }
        attached.push(item)
        return { evidence: item }
      })
    const { user } = setup("evidence")
    const input = await screen.findByLabelText("Technical drawing file")
    expect(input).toHaveAttribute("multiple")
    await user.upload(
      input,
      [1, 2, 3].map(
        (n) =>
          new File(["drawing"], `sheet-${n}.pdf`, { type: "application/pdf" }),
      ),
    )
    await user.type(
      screen.getByLabelText("Technical drawing report caption"),
      "Assembly sheets",
    )
    await user.click(screen.getByRole("button", { name: "Attach 3 drawings" }))
    await waitFor(() => expect(uploads).toEqual(["sheet-1.pdf", "sheet-2.pdf"]))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach 2 drawings" }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole("button", { name: "Attach 2 drawings" }))
    await waitFor(() => expect(attached).toHaveLength(3))
    expect(uploads).toEqual([
      "sheet-1.pdf",
      "sheet-2.pdf",
      "sheet-2.pdf",
      "sheet-3.pdf",
    ])
    upload.mockRestore()
    await screen.findByRole("heading", { name: "Technical drawing 3 of 3" })
    expect(
      screen.getByRole("button", {
        name: `Enlarge technical drawing 2 of 3 for ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
  })
})
