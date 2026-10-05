import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { ReportsPage } from "@/features/reports/reports-page"
import type { CostLine, CostNode, ProjectDetail, ProjectSummary } from "@/lib/api"
import {
  partNodeFixture,
  projectDetailFixture,
  projectSummaryFixture,
} from "@/test/fixtures"
import { renderWithProviders, screen, waitFor, within } from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()

const materialLine = {
  id: "line-current-material",
  node_id: partNodeFixture.id,
  kind: "material",
  catalogue_item_id: "catalogue-aluminium",
  description: "6061-T6 aluminium",
  use_description: "Front upright blank",
  unit_cost: "120",
  quantity: "1",
  multiplier: "1",
  multiplier_name: null,
  multiplier_catalogue_item_id: null,
  fraction_included: "1",
  production_volume_factor: null,
  size_inputs_json: "{}",
  subtotal: "120",
  sort_order: 0,
  version: 1,
} satisfies CostLine

function currentDetail(): ProjectDetail {
  const currentPart = {
    ...partNodeFixture,
    raw_hla: "01",
    raw_subassembly: "01",
    raw_part_number: "001",
    costLines: [materialLine],
    breakdown: {
      material: "120",
      process: "0",
      fastener: "0",
      tooling: "0",
      total: "120",
    },
  } satisfies CostNode
  return {
    ...projectDetailFixture,
    tree: {
      ...projectDetailFixture.tree,
      breakdown: currentPart.breakdown,
    },
    flatNodes: projectDetailFixture.flatNodes.map((node) =>
      node.id === currentPart.id ? currentPart : node,
    ),
    breakdown: currentPart.breakdown,
  }
}

function historicalDetail(): ProjectDetail {
  const project = {
    ...projectSummaryFixture,
    id: "project-test-2025",
    name: "UCM25 final",
    season: 2025,
    is_historical: true,
  } satisfies ProjectSummary
  const historicalPart = {
    ...partNodeFixture,
    project_id: project.id,
    raw_hla: "01",
    raw_subassembly: "01",
    raw_part_number: "001",
    full_number: "SU-001-001-A",
    internal_note: JSON.stringify({
      historicalBomBreakdown: {
        material: "100",
        process: "0",
        fastener: "0",
        tooling: "0",
        total: "100",
      },
      historicalBomExtendedCost: "100",
    }),
  } satisfies CostNode
  const tree = {
    ...projectDetailFixture.tree,
    project_id: project.id,
    internal_note: JSON.stringify({ historicalBomHeaderTotal: "100" }),
    breakdown: {
      material: "100",
      process: "0",
      fastener: "0",
      tooling: "0",
      total: "100",
    },
  } satisfies CostNode

  return {
    project: { ...project, focusSystems: ["SU"] },
    tree,
    flatNodes: projectDetailFixture.flatNodes.map((node) => {
      if (node.id === historicalPart.id) return historicalPart
      return { ...node, project_id: project.id }
    }),
    breakdown: tree.breakdown,
  }
}

describe("report output preview", () => {
  it("shows the exported master-table columns and compares against the nearest final", async () => {
    const current = currentDetail()
    const historical = historicalDetail()
    server.use(
      http.get(apiUrl("/api/projects"), () =>
        HttpResponse.json({ projects: [current.project, historical.project] }),
      ),
      http.get(apiUrl("/api/projects/:projectId"), ({ params }) =>
        HttpResponse.json(
          params.projectId === historical.project.id ? historical : current,
        ),
      ),
    )

    const { user } = renderWithProviders(
      <ReportsPage detail={current} canWrite />,
    )

    const table = screen.getByRole("region", {
      name: "Master bill of materials output table",
    })
    expect(within(table).getByRole("columnheader", { name: "Vehicle System" }))
      .toBeInTheDocument()
    expect(within(table).getByRole("columnheader", { name: "Assembly/ Part Number" }))
      .toBeInTheDocument()
    expect(within(table).getByRole("columnheader", { name: "Extended Cost" }))
      .toBeInTheDocument()
    expect(within(table).getByRole("columnheader", { name: "Cost Table Page" }))
      .toBeInTheDocument()

    const compareButton = await screen.findByRole("button", {
      name: "Compare with 2025 final",
    })
    await waitFor(() => expect(compareButton).toBeEnabled())
    expect(screen.getByText("1 changed, added, or removed rows"))
      .toBeInTheDocument()
    await user.click(compareButton)

    expect(await within(table).findByText("changed")).toBeInTheDocument()
    expect(within(table).getAllByText("+20.00")).toHaveLength(3)
    expect(screen.getByText("+U$ 20.00")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Changes only/ }))
    expect(within(table).queryByText("Front corner assembly")).not.toBeInTheDocument()
    expect(within(table).getByText("Front-right upright")).toBeInTheDocument()
  })
})
