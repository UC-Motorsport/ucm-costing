import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import App from "@/App"
import type {
  AuthSession,
  CatalogueItem,
  CostLine,
  CostNode,
  HistoricalCostLineSearchItem,
  ProjectDetail,
  ProjectSummary,
  ValidationResult,
} from "@/lib/api"
import {
  adminUserFixture,
  assemblyNodeFixture,
  authSessionFixture,
  catalogueItemFixture,
  partNodeFixture,
  projectDetailFixture,
  projectSetupConfirmationFixture,
  projectSummaryFixture,
  systemNodeFixture,
  validationFixture,
} from "@/test/fixtures"
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

function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function useConfirmedProject() {
  const detail = {
    ...projectDetailFixture,
    project: {
      ...projectDetailFixture.project,
      report_setup_confirmed: 1,
      report_setup_confirmation: projectSetupConfirmationFixture,
    },
  }

  server.use(
    http.get(apiUrl("/api/projects/:projectId"), () => HttpResponse.json(detail)),
  )
}

function useWorkspaceNodePatch(
  nodeId: string,
  patch: Partial<CostNode>,
  options: { confirmed?: boolean } = {},
) {
  const rewriteNode = (node: CostNode): CostNode => {
    const children = node.children.map(rewriteNode)
    return node.id === nodeId
      ? { ...node, ...patch, children }
      : { ...node, children }
  }
  const detail = {
    ...projectDetailFixture,
    project: options.confirmed
      ? {
          ...projectDetailFixture.project,
          report_setup_confirmed: 1,
          report_setup_confirmation: projectSetupConfirmationFixture,
        }
      : projectDetailFixture.project,
    tree: rewriteNode(projectDetailFixture.tree),
    flatNodes: projectDetailFixture.flatNodes.map((node) =>
      node.id === nodeId ? { ...node, ...patch } : node,
    ),
  } satisfies ProjectDetail

  server.use(
    http.get(apiUrl("/api/projects/:projectId"), () => HttpResponse.json(detail)),
  )
}

function useValidation(result: ValidationResult) {
  server.use(
    http.get(
      apiUrl("/api/projects/:projectId/validation"),
      () => HttpResponse.json(result),
    ),
  )
}

describe("application routing and workflow safeguards", () => {
  it("resolves a node deep link within the team project", async () => {
    const targetProjectId = "project-deep-link-target"
    const targetNodeName = "Target project upright"
    const targetProject = {
      ...projectSummaryFixture,
      id: targetProjectId,
      name: "Deep-link target project",
      report_setup_confirmed: 1,
      report_setup_confirmation: projectSetupConfirmationFixture,
    } satisfies ProjectSummary
    const rewriteNode = (node: CostNode): CostNode => ({
      ...node,
      project_id: targetProjectId,
      name: node.id === partNodeFixture.id ? targetNodeName : node.name,
      children: node.children.map(rewriteNode),
    })
    const targetDetail = {
      ...projectDetailFixture,
      project: {
        ...projectDetailFixture.project,
        ...targetProject,
      },
      tree: rewriteNode(projectDetailFixture.tree),
      flatNodes: projectDetailFixture.flatNodes.map((node) => ({
        ...node,
        project_id: targetProjectId,
        name: node.id === partNodeFixture.id ? targetNodeName : node.name,
      })),
    } satisfies ProjectDetail
    server.use(
      http.get(
        apiUrl("/api/projects/:projectId"),
        () => HttpResponse.json(targetDetail),
      ),
    )

    renderApp(`/?node=${partNodeFixture.id}`)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: targetNodeName,
      }),
    ).toBeInTheDocument()
    expect(currentPath()).toBe(
      `/?node=${partNodeFixture.id}&workspace=${projectSummaryFixture.id}`,
    )
    expect(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    ).toHaveAttribute("aria-selected", "true")
  })

  it("selects Children by default and exposes Details for an assembly", async () => {
    const { user } = renderApp(`/?node=${assemblyNodeFixture.id}`)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: assemblyNodeFixture.name,
      }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole("tab", { name: /^Children\b/ }),
    ).toHaveAttribute("aria-selected", "true")
    expect(
      screen.getByRole("button", { name: "Save assembly" }),
    ).toBeVisible()
    expect(
      screen.getByRole("tab", { name: /^Details\b/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: "Evidence" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Revision A · Quantity 2 in parent"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("combobox", { name: "Made or bought" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Made or bought not set"),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: /^Costing\b/ }))
    expect(
      await screen.findByRole("button", { name: "Import 2025" }),
    ).toBeVisible()
  })

  it("selects Details for an explicit record link", async () => {
    renderApp(
      `/?node=${assemblyNodeFixture.id}&section=record`,
    )

    expect(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    ).toHaveAttribute("aria-selected", "true")
  })

  it.each([
    {
      section: "cost-lines",
      tabName: "Costing",
      headingName: "Cost sheet",
    },
    {
      section: "evidence",
      tabName: "Evidence",
      headingName: "Attachments",
    },
  ])(
    "selects $tabName and focuses its content for a direct section link",
    async ({ section, tabName, headingName }) => {
      renderApp(`/?node=${partNodeFixture.id}&section=${section}`)

      const tab = await screen.findByRole("tab", {
        name: new RegExp(`^${tabName}\\b`),
      })
      expect(tab).toHaveAttribute("aria-selected", "true")

      const heading = await screen.findByRole("heading", {
        level: 3,
        name: headingName,
      })
      await waitFor(() => expect(heading).toHaveFocus())
      expect(
        screen.queryByRole("tab", { name: /^Children\b/ }),
      ).not.toBeInTheDocument()
    },
  )

  it("calculates corrected monocoque tooling with the published PVF choice", async () => {
    const correctedTooling = {
      ...catalogueItemFixture,
      id: "catalogue-tooling-19",
      kind: "tooling",
      catalogueId: "19",
      name: "Lamination - Mold Tool",
      category: "Composite Tooling",
      unit: "m^2",
      rawFormula: "m^2",
      sourceFormula: "m^2",
      effectiveFormula: "=[C1]*[Size1]",
      formulaCorrection: {
        id: "26_R1-tooling-19-surface-area-formula",
        reason:
          "The source formula cell repeats the m^2 unit; the row defines a surface-area tooling cost.",
        evidence: "FSAE-A Cost Catalogue 2026 v1.0, Tooling ID 19.",
        sourceFormula: "m^2",
        effectiveFormula: "=[C1]*[Size1]",
        inputs: {
          size1: { label: "Tool surface area", unit: "m²" },
        },
      },
      effectiveFormulaValidation: {
        ok: true,
        normalized: "20000*size1",
      },
      fixedCost: null,
      coefficients: { c1: 20000, c2: null, c3: null, c4: null },
      metadata: {
        size1: "Tool surface area",
        formulaValidation: {
          ok: false,
          error: "Unknown identifier m",
        },
      },
      sourceSheet: "Tooling",
      sourceRow: 20,
    } satisfies CatalogueItem
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.get(apiUrl("/api/catalogue"), ({ request }) => {
        const url = new URL(request.url)
        return HttpResponse.json({
          items:
            url.searchParams.get("kind") === "tooling"
              ? [correctedTooling]
              : [],
        })
      }),
      http.get(apiUrl("/api/catalogue/:itemId"), ({ params }) =>
        params.itemId === correctedTooling.id
          ? HttpResponse.json({ item: correctedTooling })
          : HttpResponse.json({ error: { code: "not-found" } }, { status: 404 }),
      ),
      http.post(
        apiUrl("/api/nodes/:nodeId/cost-lines"),
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return HttpResponse.json(
            {
              line: {
                id: "cost-line-tooling-19",
                node_id: partNodeFixture.id,
                catalogue_item_id: correctedTooling.id,
                kind: "tooling",
                description: correctedTooling.name,
                use_description: "",
                unit_cost: "68400",
                quantity: "1",
                multiplier: "1",
                multiplier_name: null,
                multiplier_catalogue_item_id: null,
                fraction_included: "1",
                production_volume_factor: "120",
                size_inputs_json: JSON.stringify({ size1: "3.42" }),
                subtotal: "570",
                sort_order: 0,
                version: 0,
              },
            },
            { status: 201 },
          )
        },
      ),
    )

    const { user } = renderApp(
      `/?node=${partNodeFixture.id}&section=cost-lines`,
    )
    await user.click(
      await screen.findByRole("button", { name: "Add line" }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Add a catalogue cost line",
    })
    await user.click(within(dialog).getByLabelText("Cost category"))
    await user.click(await screen.findByRole("option", { name: "Tooling" }))
    await user.click(
      await within(dialog).findByRole("button", {
        name: /Lamination - Mold Tool/,
      }),
    )

    expect(
      await within(dialog).findByText("Catalogue correction applied"),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/Cost Committee/i)).not.toBeInTheDocument()
    const area = within(dialog).getByLabelText("Tool surface area (m²)")
    await user.type(area, "3.42")
    await user.click(within(dialog).getByLabelText("Production class"))
    await user.click(
      await screen.findByRole("option", {
        name: "Composite monocoque · PVF 120",
      }),
    )
    await user.click(
      within(dialog).getByRole("button", { name: "Calculate and add" }),
    )

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({
      kind: "tooling",
      catalogueItemId: correctedTooling.id,
      quantity: "1",
      fractionIncluded: "1",
      productionVolumeFactor: "120",
      sizeInputs: { size1: "3.42" },
    })
  })

  it("preserves an unsaved Details field while switching tabs", async () => {
    const { user } = renderApp(`/?node=${assemblyNodeFixture.id}`)
    const draftName = "Front corner assembly draft"

    await user.click(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    )
    const name = await screen.findByLabelText("Name")
    await user.clear(name)
    await user.type(name, draftName)

    await user.click(
      screen.getByRole("tab", { name: /^Costing\b/ }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^Costing\b/ }),
      ).toHaveAttribute("aria-selected", "true"),
    )

    await user.click(
      screen.getByRole("tab", { name: /^Details\b/ }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /^Details\b/ }),
      ).toHaveAttribute("aria-selected", "true"),
    )

    expect(screen.getByLabelText("Name")).toHaveValue(draftName)
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
  })

  it("clears a discarded evidence draft when moving to another record", async () => {
    const { user } = renderApp(
      `/?node=${assemblyNodeFixture.id}&section=evidence`,
    )

    const file = new File(["image-bytes"], "isometric.png", {
      type: "image/png",
    })
    await user.upload(
      await screen.findByLabelText("Isometric image file"),
      file,
    )
    const caption = screen.getByLabelText("Isometric image report caption")
    await user.type(caption, "Discard this evidence draft")
    await user.click(screen.getByRole("button", { name: /^Next\b/ }))

    const discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    })
    await user.click(
      within(discardDialog).getByRole("button", {
        name: "Discard and continue",
      }),
    )

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: partNodeFixture.name,
      }),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("tab", { name: /^Evidence\b/ }),
    )
    expect(await screen.findByLabelText("Isometric image file")).toHaveValue(
      "",
    )
  })

  it("keeps section tabs usable while record fields are read-only", async () => {
    const viewerSession = {
      ...authSessionFixture,
      user: {
        ...adminUserFixture,
        id: "user-tab-viewer",
        role: "viewer",
      },
    } satisfies AuthSession
    server.use(
      http.get(apiUrl("/api/auth/me"), () =>
        HttpResponse.json(viewerSession),
      ),
    )
    const { user } = renderApp(`/?node=${assemblyNodeFixture.id}`)

    await user.click(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    )
    expect(await screen.findByLabelText("Name")).toBeDisabled()

    const costing = screen.getByRole("tab", { name: /^Costing\b/ })
    expect(costing).toBeEnabled()
    await user.click(costing)

    await waitFor(() =>
      expect(costing).toHaveAttribute("aria-selected", "true"),
    )
    expect(
      screen.getByRole("heading", { level: 3, name: "Cost sheet" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/direct catalogue lines?/i),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("tab", { name: /^Children\b/ }),
    )
    const openChild = await screen.findByRole("button", { name: "Open" })
    expect(openChild).toBeEnabled()
    await user.click(openChild)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: partNodeFixture.name,
      }),
    ).toBeInTheDocument()
  })

  it("groups direct cost lines by source with compact subtotals", async () => {
    const line = {
      id: "cost-line-material-one",
      node_id: partNodeFixture.id,
      kind: "material",
      catalogue_item_id: catalogueItemFixture.id,
      catalogue_unit: "kg",
      catalogue_unit_2: null,
      description: "Aluminium 6061-T6",
      use_description: "Upright billet",
      unit_cost: "5",
      quantity: "1",
      multiplier: "1",
      multiplier_name: "None",
      multiplier_catalogue_item_id: "multiplier-none",
      fraction_included: "1",
      production_volume_factor: null,
      size_inputs_json: "{}",
      subtotal: "5",
      sort_order: 0,
      version: 0,
    } satisfies CostLine
    const costLines = [
      line,
      {
        ...line,
        id: "cost-line-material-two",
        description: "Aluminium plate",
        unit_cost: "7.5",
        subtotal: "7.5",
        sort_order: 1,
      },
      {
        ...line,
        id: "cost-line-process-one",
        kind: "process",
        catalogue_item_id: "catalogue-process-machining",
        description: "CNC machining",
        use_description: "Finish machine the upright",
        unit_cost: "10",
        subtotal: "10",
        sort_order: 0,
      },
    ] satisfies CostLine[]
    useWorkspaceNodePatch(partNodeFixture.id, {
      costLines,
      breakdown: {
        material: "12.5",
        process: "10",
        fastener: "0",
        tooling: "0",
        total: "22.5",
      },
    })

    renderApp(
      `/?node=${partNodeFixture.id}&section=cost-lines`,
    )

    expect(
      await screen.findByRole("row", {
        name: /Material 2 lines Material subtotal: U\$ 12\.50/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("row", {
        name: /Process 1 line Process subtotal: U\$ 10\.00/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("row", { name: /Aluminium plate/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("row", { name: /CNC machining/ }),
    ).toBeInTheDocument()
    expect(screen.getAllByText("Catalogue unit: kg").length).toBeGreaterThan(0)
  })

  it("imports only checked 2025 costs after selecting a source assembly", async () => {
    const suggested = {
      id: "historical-cost-suggested",
      sourceNodeId: "historical-node-suggested",
      sourceNodeName: "Front Upright",
      sourceNodeNumber: "E13-25-SU-030001-A",
      sourceNodeKind: "part",
      sourceProjectId: "historical-project-2025",
      sourceProjectName: "UC Motorsport 2025",
      sourceSeason: 2025,
      sizeInputs: { size1: "0.2576", size1Unit: "kg" },
      kind: "material",
      catalogueItemId: null,
      description: "Suggested aluminium billet",
      useDescription: "Original upright billet",
      unitCost: "25",
      quantity: "2",
      multiplier: "1",
      multiplierName: null,
      fractionIncluded: "1",
      productionVolumeFactor: null,
      subtotal: "50",
    } satisfies HistoricalCostLineSearchItem
    const searched = {
      ...suggested,
      id: "historical-cost-selected",
      sizeInputs: {},
      sourceNodeId: "historical-node-caliper",
      sourceNodeName: "Front Caliper",
      sourceNodeNumber: "E13-25-BR-040120-A",
      description: "Brake Caliper, ISR, 22-048",
      useDescription: "Front braking assembly",
      unitCost: "96",
      quantity: "1",
      subtotal: "96",
    } satisfies HistoricalCostLineSearchItem
    let imported: { sourceNodeId: string; sourceLineIds: string[] } | null = null
    const base = `/api/nodes/${partNodeFixture.id}/cost-lines/import-2025`
    server.use(
      http.get(apiUrl(`${base}/sources`), ({ request }) => HttpResponse.json({
        sourceProject: { id: "historical-project-2025", name: "UC Motorsport 2025", season: 2025 },
        items: new URL(request.url).searchParams.get("q")?.includes("brakes")
          ? [{ id: "historical-brakes", name: "Historical brakes", fullNumber: "E13-25-DR-030000-A", kind: "assembly", rowCount: 2 }]
          : [],
        hasMore: false,
      })),
      http.get(apiUrl(`${base}/sources/historical-brakes`), () => HttpResponse.json({ items: [suggested, searched] })),
      http.post(apiUrl(`${base}/batch`), async ({ request }) => {
        imported = await request.json() as typeof imported
        return HttpResponse.json({ results: [{}], warnings: [] }, { status: 201 })
      }),
    )
    const { user } = renderApp(`/?node=${partNodeFixture.id}&section=cost-lines`)
    await user.click(await screen.findByRole("button", { name: "Import 2025" }))
    const dialog = await screen.findByRole("dialog", { name: "Import 2025 costs" })
    await user.type(within(dialog).getByLabelText("Search 2025 parts and assemblies"), "brakes")
    await user.click(await within(dialog).findByRole("button", { name: /Historical brakes/ }))
    await within(dialog).findByText(searched.description)
    expect(within(dialog).getByText("Mass: 0.2576 kg")).toBeVisible()
    expect(within(dialog).getByText("Quantity: 2")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Import selected rows" })).toBeDisabled()
    await user.click(within(dialog).getByRole("checkbox", { name: "Select all" }))
    expect(within(dialog).getByText("2 of 2 rows selected")).toBeVisible()
    await user.click(within(dialog).getByRole("button", { name: "Clear selection" }))
    expect(within(dialog).getByRole("button", { name: "Import selected rows" })).toBeDisabled()
    await user.click(within(dialog).getByRole("checkbox", { name: "Select all" }))
    await user.click(within(dialog).getByRole("checkbox", { name: `Select ${suggested.description} from ${suggested.sourceNodeName}` }))
    expect(within(dialog).getByText("1 of 2 rows selected")).toBeVisible()
    await user.click(within(dialog).getByRole("button", { name: "Import 1 row" }))
    await waitFor(() => expect(imported).toEqual({ sourceNodeId: "historical-brakes", sourceLineIds: [searched.id] }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import 2025 costs" })).not.toBeInTheDocument())
  })

  it("keeps Import 2025 contextual and moves a subassembly with an explicit destination", async () => {
    const subassembly = {
      ...partNodeFixture,
      id: "node-subassembly-cooling",
      kind: "subassembly",
      parent_id: assemblyNodeFixture.id,
      name: "Accessory cooling subassembly",
      full_number: "SU-001-200-A",
      reference_id: "001200",
      version: 4,
      children: [],
    } satisfies CostNode
    const assembly = {
      ...assemblyNodeFixture,
      children: [subassembly, partNodeFixture],
    } satisfies CostNode
    const system = {
      ...systemNodeFixture,
      children: [assembly],
    } satisfies CostNode
    const detail = {
      ...projectDetailFixture,
      tree: {
        ...projectDetailFixture.tree,
        children: [system],
      },
      flatNodes: [
        projectDetailFixture.tree,
        system,
        assembly,
        subassembly,
        partNodeFixture,
      ],
    } satisfies ProjectDetail
    let moveBody: Record<string, unknown> | null = null
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json(detail),
      ),
      http.post(
        apiUrl(`/api/nodes/${subassembly.id}/move`),
        async ({ request }) => {
          moveBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
            node: {
              ...subassembly,
              parent_id: system.id,
              kind: "assembly",
              version: subassembly.version + 1,
            },
          })
        },
      ),
    )

    const { user } = renderApp(
      `/?node=${subassembly.id}&section=cost-lines`,
    )
    expect(
      await screen.findByRole("button", { name: "Import 2025" }),
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: /^Details\b/ }))
    await user.click(
      await screen.findByRole("button", { name: "Move or change level" }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Move or change hierarchy level",
    })
    await user.click(within(dialog).getByLabelText("New level"))
    await user.click(await screen.findByRole("option", { name: "Assembly" }))
    expect(
      within(dialog).getByText(
        /will become an assembly under Suspension/,
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Controlled numbers are preserved/),
    ).toBeInTheDocument()

    await user.click(
      within(dialog).getByRole("button", { name: "Confirm move" }),
    )
    await waitFor(() =>
      expect(moveBody).toEqual({
        expectedVersion: subassembly.version,
        targetParentId: system.id,
        expectedTargetParentVersion: system.version,
        kind: "assembly",
      }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "Move or change hierarchy level",
        }),
      ).not.toBeInTheDocument(),
    )
  })

  it("moves a part to a valid parent while keeping its level fixed", async () => {
    const destination = {
      ...partNodeFixture,
      id: "node-part-move-destination",
      kind: "subassembly",
      parent_id: assemblyNodeFixture.id,
      name: "Part destination",
      full_number: "SU-001-300-A",
      reference_id: "001300",
      costLines: [],
      children: [],
      version: 3,
    } satisfies CostNode
    const part = {
      ...partNodeFixture,
      parent_id: assemblyNodeFixture.id,
      version: 5,
    } satisfies CostNode
    const assembly = {
      ...assemblyNodeFixture,
      children: [part, destination],
    } satisfies CostNode
    const system = {
      ...systemNodeFixture,
      children: [assembly],
    } satisfies CostNode
    const detail = {
      ...projectDetailFixture,
      tree: {
        ...projectDetailFixture.tree,
        children: [system],
      },
      flatNodes: [projectDetailFixture.tree, system, assembly, part, destination],
    } satisfies ProjectDetail
    let moveBody: Record<string, unknown> | null = null
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json(detail),
      ),
      http.post(
        apiUrl(`/api/nodes/${part.id}/move`),
        async ({ request }) => {
          moveBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
            node: {
              ...part,
              parent_id: destination.id,
              version: part.version + 1,
            },
          })
        },
      ),
    )

    const { user } = renderApp(`/?node=${part.id}`)
    await user.click(
      await screen.findByRole("button", { name: "Move or change level" }),
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Move or change hierarchy level",
    })
    expect(within(dialog).getByLabelText("New level")).toBeDisabled()
    expect(
      within(dialog).getByText(
        "Parts stay parts when moved; only their parent changes.",
      ),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByLabelText("Place under"))
    await user.click(
      await screen.findByRole("option", {
        name: "Part destination · Subassembly",
      }),
    )
    expect(
      within(dialog).getByText(
        /will remain a part under Part destination/,
      ),
    ).toBeInTheDocument()
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm move" }),
    )
    await waitFor(() =>
      expect(moveBody).toEqual({
        expectedVersion: part.version,
        targetParentId: destination.id,
        expectedTargetParentVersion: destination.version,
        kind: "part",
      }),
    )
  })

  it("maps direct validation issue badges to the relevant item tabs", async () => {
    useWorkspaceNodePatch(
      partNodeFixture.id,
      { revision: null },
      { confirmed: true },
    )
    useValidation({
      ...validationFixture,
      blockers: 2,
      warnings: 1,
      notices: 0,
      issues: [
        {
          id: `part-revision-missing:${partNodeFixture.id}`,
          severity: "blocker",
          code: "part-revision-missing",
          title: `${partNodeFixture.name} has no revision`,
          detail: "Add the controlled part revision.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.4.1",
        },
        {
          id: `part-not-costed:${partNodeFixture.id}`,
          severity: "blocker",
          code: "part-not-costed",
          title: `${partNodeFixture.name} has no cost lines`,
          detail: "Add current catalogue costs for this part.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.4.1",
        },
        {
          id: `part-visual-missing:${partNodeFixture.id}`,
          severity: "warning",
          code: "part-visual-missing",
          title: `${partNodeFixture.name} has no report-visible drawing or image`,
          detail: "Attach enough visual detail for judges to verify the part.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.12.3",
        },
      ],
    })

    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    expect(
      await screen.findByRole("tab", { name: "Details 1 issue" }),
    ).toHaveAttribute("aria-selected", "true")
    expect(
      screen.getByRole("tab", { name: "Costing 1 issue" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: "Evidence 1 issue" }),
    ).toBeInTheDocument()

    const revision = await screen.findByLabelText("Revision")
    expect(revision).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByLabelText("Assembly number segment")).toHaveAttribute(
      "aria-invalid",
      "false",
    )

    const fieldError = screen.getByRole("alert")
    expect(fieldError).toHaveTextContent(
      `${partNodeFixture.name} has no revision`,
    )
    expect(fieldError).toHaveAttribute(
      "title",
      "Add the controlled part revision.",
    )

    await user.type(revision, "B")

    expect(revision).toHaveAttribute("aria-invalid", "false")
    expect(revision).not.toHaveAttribute("aria-describedby")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("marks the exact record field for a missing controlled number", async () => {
    useWorkspaceNodePatch(assemblyNodeFixture.id, {
      full_number: null,
    })
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 0,
      notices: 0,
      issues: [
        {
          id: `assembly-number-missing:${assemblyNodeFixture.id}`,
          severity: "blocker",
          code: "assembly-number-missing",
          title: `${assemblyNodeFixture.name} has no controlled full number`,
          detail:
            "Record the exact controlled identifier used by the BOM, drawing, and evidence.",
          nodeId: assemblyNodeFixture.id,
          ruleReference: "Local Addendum S.3.5",
        },
      ],
    })

    const { user } = renderApp(`/?node=${assemblyNodeFixture.id}`)

    await user.click(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    )
    const assemblyNumber = await screen.findByLabelText(
      "Assembly number segment",
    )
    expect(assemblyNumber).toHaveAttribute("aria-invalid", "true")
    expect(assemblyNumber).toHaveAccessibleDescription(
      `${assemblyNodeFixture.name} has no controlled full number`,
    )
    expect(screen.getByLabelText("Revision")).toHaveAttribute(
      "aria-invalid",
      "false",
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      `${assemblyNodeFixture.name} has no controlled full number`,
    )
    expect(
      screen.getByText("E17-26-SU-010000-A"),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Use suggested number" }),
    )

    expect(assemblyNumber).toHaveValue("01")
    expect(screen.getByLabelText("Level number segment")).toHaveValue("00")
    expect(screen.getByLabelText("Part number segment")).toHaveValue("00")
    expect(assemblyNumber).toHaveAttribute("aria-invalid", "false")
    expect(assemblyNumber).not.toHaveAttribute("aria-describedby")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Use suggested number" }),
    ).not.toBeInTheDocument()
  })

  it("suggests and applies a controlled number for an unnumbered part", async () => {
    useWorkspaceNodePatch(partNodeFixture.id, {
      full_number: null,
      reference_id: null,
    })
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 0,
      notices: 0,
      issues: [
        {
          id: `part-number-missing:${partNodeFixture.id}`,
          severity: "blocker",
          code: "part-number-missing",
          title: `${partNodeFixture.name} has no controlled full number`,
          detail: "Add the controlled part number.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.5",
        },
      ],
    })

    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    await user.click(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    )
    expect(
      await screen.findByText("E17-26-SU-010101-A"),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Use suggested number" }),
    )

    expect(screen.getByLabelText("Assembly number segment")).toHaveValue("01")
    expect(screen.getByLabelText("Level number segment")).toHaveValue("01")
    expect(screen.getByLabelText("Part number segment")).toHaveValue("01")
    expect(
      screen.queryByRole("button", { name: "Use suggested number" }),
    ).not.toBeInTheDocument()
  })

  it("marks and clears an unset made-or-bought field", async () => {
    useWorkspaceNodePatch(partNodeFixture.id, {
      procurement_type: "unknown",
    })
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 0,
      notices: 0,
      issues: [
        {
          id: `made-bought-unset:${partNodeFixture.id}`,
          severity: "blocker",
          code: "made-bought-unset",
          title: `${partNodeFixture.name} is not marked made or bought`,
          detail: "Choose how this item is sourced.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.4.1",
        },
      ],
    })
    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    const procurement = await screen.findByRole("combobox", {
      name: "Made or bought",
    })
    expect(procurement).toHaveAttribute("aria-invalid", "true")
    expect(procurement).toHaveAccessibleDescription(
      `${partNodeFixture.name} is not marked made or bought`,
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      `${partNodeFixture.name} is not marked made or bought`,
    )

    await user.click(procurement)
    await user.click(await screen.findByRole("option", { name: "Made" }))

    expect(procurement).toHaveAttribute("aria-invalid", "false")
    expect(procurement).not.toHaveAttribute("aria-describedby")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("opens directly into the ready team workspace", async () => {
    renderApp("/")

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Bill of materials",
      }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(currentPath()).toBe(`/?workspace=${projectSummaryFixture.id}`),
    )
  })

  it("keeps an explicit validation deep link instead of applying the first-run redirect", async () => {
    const route = "/validation?datasheet=cells#critical-datasheets"
    renderApp(route)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Validation",
      }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(currentPath()).toBe(
        `/validation?datasheet=cells&workspace=${projectSummaryFixture.id}#critical-datasheets`,
      ),
    )
  })

  it("shows both electric and combustion datasheet requirements for a dual-powertrain vehicle", async () => {
    useConfirmedProject()
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json({
          ...projectDetailFixture,
          project: {
            ...projectDetailFixture.project,
            vehicle_type: "dual",
            report_setup_confirmed: 1,
            report_setup_confirmation: projectSetupConfirmationFixture,
          },
        } satisfies ProjectDetail),
      ),
    )

    renderApp("/validation")

    expect(
      await screen.findByText("Critical dual-powertrain datasheets"),
    ).toBeInTheDocument()
    expect(screen.getAllByText("Cell datasheet")).not.toHaveLength(0)
    expect(screen.getByText("Engine datasheet")).toBeInTheDocument()
    expect(
      screen.getByText("Engine-control unit (ECU) datasheet"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Fuel-injector datasheet"),
    ).toBeInTheDocument()
  })

  it("marks the current navigation item and presents the blocker-focused primary action", async () => {
    useConfirmedProject()
    renderApp("/validation")

    await screen.findByRole("heading", {
      level: 1,
      name: "Validation",
    })

    const navigation = screen.getByRole("navigation", {
      name: "Primary navigation",
    })
    expect(
      within(navigation).getByRole("button", { name: "Validation" }),
    ).toHaveAttribute("aria-current", "page")
    expect(
      await screen.findByRole("button", {
        name: /Review 1 blockers/,
      }),
    ).toBeEnabled()
  })

  it("keeps report setup edits on cancel and discards them only after confirmation", async () => {
    const { user } = renderApp("/setup")

    await screen.findByRole("heading", {
      level: 1,
      name: "Report setup",
    })
    const summary = await screen.findByLabelText(
      "Cost-management summary",
    )
    await user.type(summary, " Unsaved addition")

    const navigation = screen.getByRole("navigation", {
      name: "Primary navigation",
    })
    const importNavigation = within(navigation).getByRole("button", {
      name: "Import",
    })
    await user.click(importNavigation)

    const firstDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    })
    expect(
      within(firstDialog).getByText(
        "Report setup has changes that have not been saved. Leaving now will discard them.",
      ),
    ).toBeInTheDocument()

    await user.click(
      within(firstDialog).getByRole("button", {
        name: "Keep editing",
      }),
    )
    expect(currentPath()).toBe(
      `/setup?workspace=${projectSummaryFixture.id}`,
    )
    expect(summary).toHaveValue(
      `${projectSummaryFixture.project_summary} Unsaved addition`,
    )

    await user.click(importNavigation)
    const secondDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    })
    await user.click(
      within(secondDialog).getByRole("button", {
        name: "Discard and continue",
      }),
    )

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Import spreadsheet",
      }),
    ).toBeInTheDocument()
    expect(currentPath()).toBe(
      `/import?workspace=${projectSummaryFixture.id}`,
    )
  })

  it("opens a newly created assembly without prompting to discard its saved draft", async () => {
    const createdAssembly = {
      ...assemblyNodeFixture,
      id: "node-assembly-created",
      parent_id: systemNodeFixture.id,
      name: "Created assembly",
      description: "",
      revision: "A",
      reference_id: "020000",
      full_number: "E17-26-SU-020000-A",
      quantity: "1",
      version: 1,
      children: [],
    } satisfies CostNode
    let workspace: ProjectDetail = projectDetailFixture

    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json(workspace),
      ),
      http.post(
        apiUrl("/api/nodes/:parentId/children"),
        () => {
          const appendCreatedAssembly = (node: CostNode): CostNode =>
            node.id === systemNodeFixture.id
              ? {
                  ...node,
                  version: node.version + 1,
                  children: [...node.children, createdAssembly],
                }
              : {
                  ...node,
                  children: node.children.map(appendCreatedAssembly),
                }

          workspace = {
            ...projectDetailFixture,
            tree: appendCreatedAssembly(projectDetailFixture.tree),
            flatNodes: [
              ...projectDetailFixture.flatNodes.map((node) =>
                node.id === systemNodeFixture.id
                  ? { ...node, version: node.version + 1 }
                  : node,
              ),
              createdAssembly,
            ],
          }
          return HttpResponse.json(
            { node: createdAssembly },
            { status: 201 },
          )
        },
      ),
    )
    const { user } = renderApp(`/?node=${systemNodeFixture.id}`)

    await screen.findByRole("heading", {
      level: 1,
      name: systemNodeFixture.name,
    })
    await user.click(
      await screen.findByRole("button", { name: "Add assembly" }),
    )

    const createDialog = await screen.findByRole("dialog", {
      name: `Add assembly to ${systemNodeFixture.name}`,
    })
    expect(
      within(createDialog).getByLabelText("Assembly number segment"),
    ).toHaveValue("02")
    expect(
      within(createDialog).getByLabelText("Level number segment"),
    ).toHaveValue("00")
    expect(
      within(createDialog).getByLabelText("Part number segment"),
    ).toHaveValue("00")
    expect(within(createDialog).getByLabelText("Revision segment")).toHaveValue(
      "A",
    )
    await user.type(
      within(createDialog).getByLabelText("Name"),
      createdAssembly.name,
    )
    await user.click(
      within(createDialog).getByRole("button", {
        name: "Create assembly",
      }),
    )

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: createdAssembly.name,
      }),
    ).toBeInTheDocument()
    expect(currentPath()).toBe(
      `/?node=${createdAssembly.id}&section=record&workspace=${projectSummaryFixture.id}`,
    )
    expect(
      screen.queryByRole("dialog", {
        name: "Discard unsaved changes?",
      }),
    ).not.toBeInTheDocument()
  })

  it("defaults process costing to None and filters searchable multipliers", async () => {
    const formulaMaterial = {
      ...catalogueItemFixture,
      id: "catalogue-material-billet-shape",
      catalogueId: "MAT-BILLET-SHAPE",
      name: "Mill shape from billet",
      unit: "cm³",
      fixedCost: null,
      rawFormula: "[size1] * 0.01",
      sourceFormula: "[size1] * 0.01",
      effectiveFormula: "[size1] * 0.01",
      effectiveFormulaValidation: {
        ok: true,
        normalized: "size1*0.01",
      },
      metadata: { size1: "Mill shape from billet" },
      sourceRow: 44,
    }
    const processItem = {
      ...catalogueItemFixture,
      id: "catalogue-process-rapid-plastic",
      kind: "process",
      catalogueId: "12",
      name: "Rapid Prototype - Plastic",
      unit: "kg",
      fixedCost: "32",
      sourceSheet: "Processes",
      sourceRow: 13,
    }
    const noneMultiplier = {
      ...catalogueItemFixture,
      id: "catalogue-multiplier-none",
      kind: "multiplier",
      catalogueId: "1",
      name: "None",
      fixedCost: "1",
      sourceSheet: "Process Multipliers",
      sourceRow: 4,
    }
    const holeMultiplier = {
      ...noneMultiplier,
      id: "catalogue-multiplier-hole",
      catalogueId: "17",
      name: "Hole machining",
      fixedCost: "1.5",
      sourceRow: 20,
    }

    server.use(
      http.get(apiUrl("/api/catalogue"), ({ request }) => {
        const params = new URL(request.url).searchParams
        const kind = params.get("kind")
        const query = params.get("q")?.toLowerCase() ?? ""
        if (kind === "process") {
          return HttpResponse.json({ items: [processItem] })
        }
        if (kind === "multiplier") {
          return HttpResponse.json({
            items: query.includes("hole")
              ? [holeMultiplier]
              : query.includes("none")
                ? [noneMultiplier]
                : [noneMultiplier, holeMultiplier],
          })
        }
        return HttpResponse.json({ items: [formulaMaterial] })
      }),
      http.get(apiUrl("/api/catalogue/:itemId"), ({ params }) => {
        const items = [
          formulaMaterial,
          processItem,
          noneMultiplier,
          holeMultiplier,
        ]
        const item = items.find((candidate) => candidate.id === params.itemId)
        return item
          ? HttpResponse.json({ item })
          : HttpResponse.json({ error: { code: "not-found" } }, { status: 404 })
      }),
    )

    const { user } = renderApp(`/?node=${partNodeFixture.id}`)
    await user.click(await screen.findByRole("tab", { name: /^Costing\b/ }))
    await user.click(
      await screen.findByRole("button", { name: "Add line" }),
    )

    const dialog = await screen.findByRole("dialog", {
      name: "Add a catalogue cost line",
    })
    await user.click(within(dialog).getByLabelText("Cost category"))
    await user.click(await screen.findByRole("option", { name: "Process" }))
    expect(
      await within(dialog).findByText(/Selected #1 None · ×1/),
    ).toBeInTheDocument()
    await user.click(
      within(dialog).getByRole("button", {
        name: /Rapid Prototype - Plastic/,
      }),
    )
    expect(within(dialog).getByLabelText("Weight (kg)")).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "The catalogue rate is per kg; enter the weight used.",
      ),
    ).toBeInTheDocument()

    const search = within(dialog).getByLabelText("Process multiplier")
    await user.type(search, "hole")
    const option = await within(dialog).findByRole("option", {
      name: /Hole machining/,
    })
    expect(
      within(dialog).queryByRole("option", { name: /None/ }),
    ).not.toBeInTheDocument()
    await user.click(option)
    expect(
      within(dialog).getByText(/Selected #17 Hole machining · ×1\.5/),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "Add line" }))
    const materialDialog = await screen.findByRole("dialog", {
      name: "Add a catalogue cost line",
    })
    expect(
      await within(materialDialog).findByText("None ×1"),
    ).toBeInTheDocument()
    expect(
      within(materialDialog).queryByLabelText("Process multiplier"),
    ).not.toBeInTheDocument()
    await user.click(
      within(materialDialog).getByRole("button", {
        name: /Mill shape from billet/,
      }),
    )
    expect(
      await within(materialDialog).findByText("Unit: cm³"),
    ).toBeInTheDocument()
    expect(
      within(materialDialog).getByLabelText("Mill shape from billet (cm³)"),
    ).toBeInTheDocument()
    expect(within(materialDialog).getByLabelText("Quantity")).toBeInTheDocument()
  })

  it("routes report validation actions to and focuses the exact setup field", async () => {
    useConfirmedProject()
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 0,
      notices: 0,
      issues: [
        {
          id: "project-summary-missing:project",
          severity: "blocker",
          code: "project-summary-missing",
          title: "Project cost-management summary is missing",
          detail: "Add the required project summary.",
          nodeId: null,
          ruleReference: "Local Addendum S.3.4.1",
        },
      ],
    })
    const { user } = renderApp("/validation")

    const action = await screen.findByRole("button", {
      name: "Add cost-management summary",
    })
    await user.click(action)

    const field = await screen.findByLabelText("Cost-management summary")
    await waitFor(() => expect(field).toHaveFocus())
    expect(currentPath()).toBe(
      `/setup?field=project-summary&workspace=${projectSummaryFixture.id}`,
    )
  })

  it("routes node validation actions to the exact editor section", async () => {
    useConfirmedProject()
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 0,
      notices: 0,
      issues: [
        {
          id: `part-not-costed:${partNodeFixture.id}`,
          severity: "blocker",
          code: "part-not-costed",
          title: `${partNodeFixture.name} has no cost lines`,
          detail: "Add current catalogue costs for this part.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.4.1",
        },
      ],
    })
    const { user } = renderApp("/validation")

    const action = await screen.findByRole("button", {
      name: "Add cost lines",
    })
    await user.click(action)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: partNodeFixture.name,
      }),
    ).toBeInTheDocument()
    const sectionHeading = await screen.findByRole("heading", {
      level: 3,
      name: "Cost sheet",
    })
    await waitFor(() => expect(sectionHeading).toHaveFocus())
    expect(currentPath()).toBe(
      `/?node=${partNodeFixture.id}&section=cost-lines&workspace=${projectSummaryFixture.id}`,
    )
  })
})
