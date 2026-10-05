import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import App from "@/App"
import type { CostNode } from "@/lib/api"
import { partNodeFixture, projectDetailFixture } from "@/test/fixtures"
import { renderWithProviders, screen, within, waitFor } from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()

describe("part handedness workflow", () => {
  it("reviews an opposite-side sibling, prevents duplicates, and navigates after creating it", async () => {
    const left: CostNode = {
      ...partNodeFixture,
      name: "Endplate L",
      full_number: "E17-26-SU-010101-L-A",
      reference_id: "010101-L",
      revision: "A",
    }
    let created: CostNode | undefined
    let createBody: Record<string, unknown> | undefined
    const rewrite = (node: CostNode): CostNode => {
      const next = node.id === left.id ? left : node
      const children = next.children.map(rewrite)
      return {
        ...next,
        children:
          next.id === left.parent_id && created
            ? [...children, created]
            : children,
      }
    }
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json({
          ...projectDetailFixture,
          tree: rewrite(projectDetailFixture.tree),
          flatNodes: [
            ...projectDetailFixture.flatNodes.map(rewrite),
            ...(created ? [created] : []),
          ],
        }),
      ),
      http.post(
        apiUrl("/api/nodes/:parentId/children"),
        async ({ request, params }) => {
          createBody = (await request.json()) as Record<string, unknown>
          expect(params.parentId).toBe(left.parent_id)
          created = {
            ...left,
            id: "created-right",
            name: String(createBody.name),
            full_number: String(createBody.fullNumber),
            reference_id: String(createBody.referenceId),
            revision: String(createBody.revision),
            children: [],
            costLines: [],
          }
          return HttpResponse.json({ node: created }, { status: 201 })
        },
      ),
    )
    window.history.replaceState(null, "", `/?node=${left.id}`)
    const { user } = renderWithProviders(<App />)
    await user.click(
      await screen.findByRole("button", { name: "Create opposite-side part" }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Create opposite-side part",
    })
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Endplate R")
    expect(within(dialog).getByLabelText("Part number segment")).toHaveValue(
      "01",
    )
    expect(within(dialog).getByLabelText("Full part number")).toHaveValue(
      "E17-26-SU-010101-R-A",
    )
    expect(within(dialog).getByLabelText("Full part number")).toHaveAttribute(
      "readonly",
    )
    expect(
      within(dialog).getByRole("button", { name: "Right" }),
    ).toHaveAttribute("aria-pressed", "true")
    await user.click(within(dialog).getByRole("button", { name: "Left" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Full number already used by Endplate L",
    )
    expect(
      within(dialog).getByRole("button", { name: "Create part" }),
    ).toBeDisabled()
    await user.click(within(dialog).getByRole("button", { name: "Right" }))
    await user.click(
      within(dialog).getByRole("button", { name: "Create part" }),
    )
    await waitFor(() =>
      expect(createBody).toMatchObject({
        name: "Endplate R",
        fullNumber: "E17-26-SU-010101-R-A",
        referenceId: "010101-R",
        revision: "A",
        kind: "part",
      }),
    )
    await waitFor(() =>
      expect(window.location.search).toContain("node=created-right"),
    )
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).not.toBeInTheDocument()
  })
})
