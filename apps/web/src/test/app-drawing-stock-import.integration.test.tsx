import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import App from "@/App"
import type { CostLine, CostNode, CatalogueItem } from "@/lib/api"
import { catalogueItemFixture, projectDetailFixture, partNodeFixture, evidenceFixture } from "@/test/fixtures"
import { renderWithProviders, screen, within, waitFor } from "@/test/render"
import { server } from "@/test/server"

const url = (path: string) => new URL(path, window.location.origin).toString()
const material = { ...catalogueItemFixture, name: "Carbon Fibre, 1 Ply, Dry Cloth", fixedCost: null, effectiveFormula: "[size1]*120", effectiveFormulaValidation: {ok:true}, metadata: {size1:"Mass"}, unit:"kg" } as CatalogueItem
const line: CostLine = { id:"historical-line", node_id:partNodeFixture.id, kind:"material", catalogue_item_id:null, description:material.name, use_description:"Double skin", quantity:"2", unit_cost:"50.4", subtotal:"100.8", multiplier:"1", multiplier_name:null, multiplier_catalogue_item_id:null, fraction_included:"1", production_volume_factor:null, size_inputs_json: JSON.stringify({size1:"0.42",size1Unit:"kg"}), sort_order:0,version:0 }
function setup(costLine = line) {
  const detail = structuredClone(projectDetailFixture)
  const update = (node: CostNode): void => { if(node.id === partNodeFixture.id) node.costLines = [costLine]; node.children.forEach(update) }
  update(detail.tree); detail.flatNodes.forEach(update)
  server.use(
    http.get(url("/api/projects/:projectId"), () => HttpResponse.json(detail)),
    http.get(url("/api/catalogue"), () => HttpResponse.json({items:[material]})),
    http.get(url("/api/catalogue/:itemId"), () => HttpResponse.json({item:material})),
  )
  window.history.replaceState(null,"",`/?node=${partNodeFixture.id}&section=cost-lines`)
  return renderWithProviders(<App />)
}

describe("drawing, historical input, and stock selection", () => {
  it("shows historical mass and keeps it when linking and reselecting the matching row", async () => {
    const {user} = setup()
    await user.click(await screen.findByRole("button",{name:`Edit ${material.name}`}))
    const dialog = await screen.findByRole("dialog",{name:"Edit catalogue cost line"})
    expect(within(dialog).getByText("Mass (kg): 0.42")).toBeInTheDocument()
    await user.click(await within(dialog).findByRole("button",{name: new RegExp(material.name)}))
    expect(within(dialog).getByLabelText("Mass (kg)")).toHaveValue("0.42")
    await user.click(within(dialog).getByRole("button",{name: new RegExp(material.name)}))
    expect(within(dialog).getByLabelText("Mass (kg)")).toHaveValue("0.42")
    await user.clear(within(dialog).getByLabelText("Mass (kg)"))
    await user.type(within(dialog).getByLabelText("Mass (kg)"),"0.6")
    expect(within(dialog).getByText("Mass (kg): 0.42")).toBeInTheDocument()
  })
  it("honestly shows missing historical measurements without populating zero", async () => {
    const {user} = setup({...line,size_inputs_json:"{}"})
    await user.click(await screen.findByRole("button",{name:`Edit ${material.name}`}))
    const dialog = await screen.findByRole("dialog",{name:"Edit catalogue cost line"})
    expect(within(dialog).getByText(/Previous mass.*were not recorded/)).toBeInTheDocument()
    await user.click(await within(dialog).findByRole("button",{name: new RegExp(material.name)}))
    expect(within(dialog).getByLabelText("Mass (kg)")).toHaveValue("")
    expect(within(dialog).getByRole("button",{name:"Recalculate and save"})).toBeDisabled()
  })
  it("exposes stock sizes as a costing category with a stock picker and material price", async () => {
    const {user} = setup()
    await user.click(await screen.findByRole("button",{name:"Add line"}))
    const dialog = await screen.findByRole("dialog",{name:"Add a catalogue cost line"})
    await user.click(within(dialog).getByLabelText("Cost category"))
    await user.click(await screen.findByRole("option",{name:"Stock sizes"}))
    expect(await within(dialog).findByLabelText("Stock profile")).toBeInTheDocument()
    expect(within(dialog).getByText(/Material price/)).toBeInTheDocument()
  })
  it("saves an image exemption with a reason and can require it again", async () => {
    const detail = structuredClone(projectDetailFixture)
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.get(url("/api/projects/:projectId"), () => HttpResponse.json(detail)),
      http.get(url("/api/projects/:projectId/evidence"), () => HttpResponse.json({evidence: []})),
      http.patch(url(`/api/nodes/${partNodeFixture.id}`), async ({request}) => {
        const input = await request.json() as Record<string, unknown>
        submitted.push(input)
        const update = (node: CostNode): void => {
          if (node.id === partNodeFixture.id) {
            node.image_required = input.imageRequired as boolean
            node.image_requirement_reason = input.imageRequirementReason as string
            node.version = Number(input.expectedVersion) + 1
          }
          node.children.forEach(update)
        }
        update(detail.tree); detail.flatNodes.forEach(update)
        return HttpResponse.json({node:detail.flatNodes.find(node => node.id === partNodeFixture.id)})
      }),
    )
    window.history.replaceState(null,"",`/?node=${partNodeFixture.id}&section=evidence`)
    const {user} = renderWithProviders(<App />)
    const checkbox = await screen.findByRole("checkbox", {name:"Isometric image not required"})
    expect(checkbox).not.toBeChecked()
    await user.click(checkbox)
    const dialog = await screen.findByRole("dialog", {name:"Isometric image not required"})
    expect(within(dialog).getByRole("button", {name:"Save exemption"})).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Reason"), "Standard bought component")
    await user.click(within(dialog).getByRole("button", {name:"Save exemption"}))
    await waitFor(() => expect(checkbox).toBeChecked())
    expect(submitted[0]).toMatchObject({expectedVersion:2, imageRequired:false, imageRequirementReason:"Standard bought component"})
    expect(screen.getByText("Reason: Standard bought component")).toBeInTheDocument()
    expect(screen.getByText("Isometric image not required for this item.")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", {name:"Drawing not required"})).not.toBeChecked()
    await user.click(checkbox)
    await waitFor(() => expect(checkbox).not.toBeChecked())
    expect(submitted[1]).toMatchObject({expectedVersion:3, imageRequired:true})
  })

  it("does not count an internal image as report-ready", async () => {
    server.use(http.get(url("/api/projects/:projectId/evidence"), () => HttpResponse.json({
      evidence: [{...evidenceFixture, kind:"image", visibility:"internal", node_id:partNodeFixture.id}],
    })))
    window.history.replaceState(null,"",`/?node=${partNodeFixture.id}&section=evidence`)
    renderWithProviders(<App />)
    const requirements = await screen.findByRole("list", {name:"Evidence requirements"})
    expect(await within(requirements).findByText("Excluded from report")).toBeInTheDocument()
    expect(screen.getByText("0 of 2 required")).toBeInTheDocument()
  })

  it("includes an internal attachment in the report and refreshes its completion state", async () => {
    let evidence = {...evidenceFixture, kind:"image" as const, visibility:"internal" as "internal" | "report", node_id:partNodeFixture.id}
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.get(url("/api/projects/:projectId/evidence"), () => HttpResponse.json({evidence:[evidence]})),
      http.patch(url(`/api/evidence/${evidence.id}`), async ({request}) => {
        submitted = await request.json() as Record<string,unknown>
        evidence = {...evidence, visibility:"report", version:evidence.version + 1}
        return HttpResponse.json({evidence})
      }),
    )
    window.history.replaceState(null,"",`/?node=${partNodeFixture.id}&section=evidence`)
    const {user} = renderWithProviders(<App />)
    await user.click(await screen.findByRole("button", {name:`Edit details for ${evidence.display_name}`}))
    const dialog = await screen.findByRole("dialog", {name:"Edit evidence details"})
    await user.click(within(dialog).getByRole("checkbox", {name:"Include in report"}))
    await user.click(within(dialog).getByRole("button", {name:"Save details"}))
    await waitFor(() => expect(submitted).toMatchObject({expectedVersion:evidenceFixture.version, visibility:"report"}))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(await screen.findByText("1 of 2 required")).toBeInTheDocument()
    expect(within(screen.getByRole("list",{name:"Evidence requirements"})).queryByText("Excluded from report")).not.toBeInTheDocument()
  })

  it("updates the drawing exception through the versioned node API", async () => {
    const detail = structuredClone(projectDetailFixture)
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.get(url("/api/projects/:projectId"), () => HttpResponse.json(detail)),
      http.patch(url(`/api/nodes/${partNodeFixture.id}`), async ({request}) => {
        submitted = await request.json() as Record<string,unknown>
        const update = (node: CostNode): void => { if(node.id === partNodeFixture.id) { node.drawing_required = false; node.version = 3 } node.children.forEach(update) }
        update(detail.tree); detail.flatNodes.forEach(update)
        return HttpResponse.json({node:detail.flatNodes.find(node=>node.id===partNodeFixture.id)})
      }),
    )
    window.history.replaceState(null,"",`/?node=${partNodeFixture.id}&section=evidence`)
    const {user} = renderWithProviders(<App />)
    await user.click(await screen.findByRole("checkbox",{name:"Drawing not required"}))
    await waitFor(() => expect(submitted).toMatchObject({expectedVersion:2,drawingRequired:false}))
    await waitFor(() => expect(screen.getByRole("checkbox",{name:"Drawing not required"})).toBeChecked())
    await user.click(screen.getByRole("tab", {name: /^Details/}))
    await user.clear(screen.getByLabelText("Name", {exact:true}))
    await user.type(screen.getByLabelText("Name", {exact:true}), "Updated upright")
    await user.click(screen.getByRole("button", {name:"Save part"}))
    await waitFor(() => expect(submitted).toMatchObject({expectedVersion:3,name:"Updated upright"}))
  })
})
