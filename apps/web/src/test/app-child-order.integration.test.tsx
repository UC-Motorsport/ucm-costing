import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"
import App from "@/App"
import { NodeChildrenList } from "@/features/bom/node-children-list"
import type { CostNode } from "@/lib/api"
import {
  assemblyNodeFixture,
  partNodeFixture,
  projectDetailFixture,
} from "@/test/fixtures"
import { renderWithProviders, screen, waitFor, within } from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()
const children = ["Panel", "Mounts", "Floor"].map((name, index) => ({
  ...partNodeFixture,
  id: `child-${index}`,
  name,
  parent_id: assemblyNodeFixture.id,
}))
const parent = { ...assemblyNodeFixture, children }

function serveWorkspace() {
  let current = { ...parent }
  const moves: { childIds: string[]; expectedParentVersion: number }[] = []
  const saves: Record<string, unknown>[] = []
  const rewrite = (node: CostNode): CostNode =>
    node.id === current.id
      ? current
      : { ...node, children: node.children.map(rewrite) }
  server.use(
    http.get(apiUrl("/api/projects/:projectId"), () =>
      HttpResponse.json({
        ...projectDetailFixture,
        tree: rewrite(projectDetailFixture.tree),
        flatNodes: [
          ...projectDetailFixture.flatNodes
            .filter((n) => n.id !== partNodeFixture.id)
            .map(rewrite),
          ...children,
        ],
      }),
    ),
    http.patch(
      apiUrl(`/api/nodes/${parent.id}/children/order`),
      async ({ request }) => {
        const input = (await request.json()) as (typeof moves)[number]
        moves.push(input)
        current = {
          ...current,
          version: current.version + 1,
          children: input.childIds.map(
            (id) => children.find((c) => c.id === id)!,
          ),
        }
        return HttpResponse.json({
          parentVersion: current.version,
          childIds: input.childIds,
        })
      },
    ),
    http.patch(apiUrl(`/api/nodes/${parent.id}`), async ({ request }) => {
      const input = (await request.json()) as Record<string, unknown>
      saves.push(input)
      current = {
        ...current,
        name: String(input.name),
        version: current.version + 1,
      }
      return HttpResponse.json({ node: current })
    }),
  )
  return { moves, saves }
}

describe("assembly child order", () => {
  it("saves repeated moves with refreshed versions and preserves a parent draft", async () => {
    const { moves, saves } = serveWorkspace()
    window.history.replaceState(null, "", `/?node=${parent.id}`)
    const { user } = renderWithProviders(<App />)
    await screen.findByRole("list", { name: `Children of ${parent.name}` })
    expect(screen.getByRole("button", { name: "Move Panel up" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Move Floor down" }),
    ).toBeDisabled()
    await user.click(screen.getByRole("tab", { name: /^Details/ }))
    await user.clear(screen.getByRole("textbox", { name: "Name" }))
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Draft assembly name",
    )
    await user.click(screen.getByRole("tab", { name: /^Children/ }))
    await user.click(screen.getByRole("button", { name: "Move Floor up" }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move Mounts down" }),
      ).toBeDisabled(),
    )
    await user.click(screen.getByRole("button", { name: "Move Floor up" }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move Floor up" }),
      ).toBeDisabled(),
    )
    const rows = within(
      screen.getByRole("list", { name: `Children of ${parent.name}` }),
    ).getAllByRole("listitem")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Floor"),
      expect.stringContaining("Panel"),
      expect.stringContaining("Mounts"),
    ])
    expect(moves).toEqual([
      {
        childIds: ["child-0", "child-2", "child-1"],
        expectedParentVersion: parent.version,
      },
      {
        childIds: ["child-2", "child-0", "child-1"],
        expectedParentVersion: parent.version + 1,
      },
    ])
    await user.click(screen.getByRole("button", { name: "Save assembly" }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toMatchObject({
      name: "Draft assembly name",
      expectedVersion: parent.version + 2,
    })
  })

  it("keeps read-only children openable without reorder controls", async () => {
    const open = vi.fn()
    const { user } = renderWithProviders(
      <NodeChildrenList
        parent={parent}
        readOnly
        onOpen={open}
        onReordered={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole("button", { name: /^Move / }),
    ).not.toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Open" })[0]!)
    expect(open).toHaveBeenCalledWith("child-0", parent.id)
  })

  it("refreshes after a conflict without applying the rejected move", async () => {
    server.use(
      http.patch(apiUrl(`/api/nodes/${parent.id}/children/order`), () =>
        HttpResponse.json(
          { error: { code: "version-conflict", message: "Changed elsewhere" } },
          { status: 409 },
        ),
      ),
    )
    const refresh = vi.fn(async () => {})
    const reordered = vi.fn()
    const { user } = renderWithProviders(
      <NodeChildrenList
        parent={parent}
        readOnly={false}
        onOpen={vi.fn()}
        onReordered={reordered}
        onRefresh={refresh}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Move Floor up" }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(reordered).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Move Floor down" }),
    ).toBeDisabled()
  })
})
