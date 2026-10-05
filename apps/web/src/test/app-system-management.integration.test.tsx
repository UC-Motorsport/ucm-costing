import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import App from "@/App"
import type { CostNode, ProjectDetail } from "@/lib/api"
import {
  projectDetailFixture,
  systemNodeFixture,
} from "@/test/fixtures"
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) => new URL(path, window.location.origin).toString()

describe("vehicle system management", () => {
  it("adds default and custom systems and removes a populated system after confirmation", async () => {
    let detail = structuredClone(projectDetailFixture) as ProjectDetail
    const createBodies: Record<string, unknown>[] = []
    const deletedRequest = { query: new URLSearchParams() }

    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () => HttpResponse.json(detail)),
      http.post(
        apiUrl("/api/nodes/:parentId/children"),
        async ({ request, params }) => {
          const createBody = (await request.json()) as Record<string, unknown>
          createBodies.push(createBody)
          const systemCode = String(createBody.systemCode)
          const systemName = String(createBody.name)
          const created = {
            ...systemNodeFixture,
            id: `node-system-${systemCode.toLowerCase()}`,
            parent_id: String(params.parentId),
            system_code: systemCode,
            name: systemName,
            description: `${systemName} system.`,
            sort_order: detail.tree.children.length,
            version: 0,
            children: [],
          } satisfies CostNode
          detail = {
            ...detail,
            tree: {
              ...detail.tree,
              version: detail.tree.version + 1,
              children: [...detail.tree.children, created],
            },
            flatNodes: [...detail.flatNodes, created],
          }
          return HttpResponse.json({ node: created }, { status: 201 })
        },
      ),
      http.delete(
        apiUrl("/api/nodes/:nodeId"),
        ({ request, params }) => {
          deletedRequest.query = new URL(request.url).searchParams
          const removedIds = new Set(
            collectIds(
              detail.flatNodes.find((node) => node.id === params.nodeId)!,
            ),
          )
          detail = {
            ...detail,
            tree: {
              ...detail.tree,
              version: detail.tree.version + 1,
              children: detail.tree.children.filter(
                (node) => !removedIds.has(node.id),
              ),
            },
            flatNodes: detail.flatNodes.filter(
              (node) => !removedIds.has(node.id),
            ),
          }
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )

    window.history.replaceState(null, "", "/")
    const { user } = renderWithProviders(<App />)

    await user.click(
      await screen.findByRole("button", {
        name: "Manage vehicle systems",
      }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Manage vehicle systems",
    })

    await user.click(
      within(dialog).getByRole("button", { name: "Add Brakes" }),
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Remove Brakes" }),
      ).toBeInTheDocument(),
    )
    expect(createBodies[0]).toMatchObject({
      expectedParentVersion: projectDetailFixture.tree.version,
      kind: "system",
      systemCode: "BR",
      name: "Brakes",
    })

    await user.click(
      within(dialog).getByRole("button", { name: "Remove Suspension" }),
    )
    expect(
      screen.getByRole("heading", { name: "Remove Suspension?" }),
    ).toBeInTheDocument()
    expect(screen.getByText(/2 descendants will also be deleted/)).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", {
        name: "Remove system and contents",
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add Suspension" }),
      ).toBeInTheDocument(),
    )
    expect(deletedRequest.query.get("expectedVersion")).toBe(
      String(systemNodeFixture.version),
    )
    expect(deletedRequest.query.get("cascade")).toBe("true")

    await user.click(
      screen.getByRole("button", { name: "Add custom system" }),
    )
    expect(
      screen.getByRole("heading", { name: "Add custom system" }),
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText("Short code"), "co")
    await user.type(screen.getByLabelText("System name"), "Cooling")
    await user.click(
      screen.getByRole("button", { name: "Create system" }),
    )

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove Cooling" }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText("Custom")).toBeInTheDocument()
    expect(createBodies[1]).toMatchObject({
      expectedParentVersion: projectDetailFixture.tree.version + 2,
      kind: "system",
      systemCode: "CO",
      name: "Cooling",
    })
  })
})

function collectIds(node: CostNode): string[] {
  return [node.id, ...node.children.flatMap(collectIds)]
}
