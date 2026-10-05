import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import App from "@/App"
import type { CatalogueItem, CataloguePublicationInput } from "@/lib/api"
import { catalogueItemFixture } from "@/test/fixtures"
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

const editedItem = {
  ...catalogueItemFixture,
  id: "catalogue-edited-aluminium",
  catalogueId: "MAT-EDITED",
  name: "Edited aluminium rate",
  provenance: "edited",
  revision: 2,
  fixedCost: "6.10",
  latestChange: {
    reason: "Team verified the current catalogue rate",
    evidence: "Materials review 2026-09",
    createdAt: "2026-09-01T16:00:00.000Z",
    createdBy: { id: "user-editor", displayName: "Moss Benton" },
  },
} satisfies CatalogueItem

const teamItem = {
  ...catalogueItemFixture,
  id: "catalogue-team-brake-caliper",
  catalogueId: "TEAM-BRAKE",
  name: "Brake Caliper, Team Billet",
  category: "Brake components",
  unit: "each",
  fixedCost: "145.50",
  sourceSheet: "Team catalogue",
  sourceRow: 1,
  origin: "team",
  provenance: "team",
  latestChange: {
    reason: "Current team brake caliper option",
    evidence: "Supplier quote BR-2026-04",
    createdAt: "2026-09-01T16:30:00.000Z",
    createdBy: { id: "user-editor", displayName: "Moss Benton" },
  },
} satisfies CatalogueItem

describe("shared catalogue management", () => {
  it("labels official, edited, and team rows and publishes a team row", async () => {
    let submitted: CataloguePublicationInput | null = null
    let published: CatalogueItem = teamItem
    server.use(
      http.get(apiUrl("/api/catalogue"), ({ request }) => {
        const query = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? ""
        const items = [catalogueItemFixture, editedItem, published].filter(
          (item) =>
            !query ||
            item.name.toLowerCase().includes(query) ||
            item.catalogueId.toLowerCase().includes(query),
        )
        return HttpResponse.json({ items })
      }),
      http.post(apiUrl("/api/catalogue/team"), async ({ request }) => {
        submitted = (await request.json()) as CataloguePublicationInput
        published = {
          ...teamItem,
          id: "catalogue-team-new",
          catalogueId: "TEAM-NEW",
          name: submitted.name,
          category: submitted.category,
          supplier: submitted.supplier,
          unit: submitted.unit,
          fixedCost: submitted.fixedCost,
          latestChange: {
            ...teamItem.latestChange!,
            reason: submitted.reason,
            evidence: submitted.evidence,
          },
        }
        return HttpResponse.json({ item: published }, { status: 201 })
      }),
    )

    const { user } = renderApp("/catalogue")

    expect(
      await screen.findByRole("heading", { level: 1, name: "Catalogue" }),
    ).toBeInTheDocument()
    expect(await screen.findByText("Official")).toBeInTheDocument()
    expect(screen.getByText("Edited catalogue · rev 2")).toBeInTheDocument()
    expect(screen.getByText("Team row")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Add team row" }))
    const dialog = await screen.findByRole("dialog", {
      name: "Add team catalogue row",
    })
    await user.type(within(dialog).getByLabelText("Name"), "Custom caliper insert")
    await user.type(within(dialog).getByLabelText("Category"), "Brake components")
    await user.type(within(dialog).getByLabelText("Primary unit"), "each")
    await user.type(within(dialog).getByLabelText("Fixed unit cost (U$)"), "88.25")
    await user.type(
      within(dialog).getByLabelText("Reason for this row"),
      "Team manufactured alternative",
    )
    await user.type(
      within(dialog).getByLabelText("Evidence or reference"),
      "September supplier review",
    )
    await user.click(within(dialog).getByRole("button", { name: "Publish team row" }))

    await waitFor(() => {
      expect(submitted).toMatchObject({
        kind: "material",
        name: "Custom caliper insert",
        unit: "each",
        fixedCost: "88.25",
        reason: "Team manufactured alternative",
      })
    })
    expect(await screen.findByText("Custom caliper insert")).toBeInTheDocument()
    expect(screen.getByText("Team row")).toBeInTheDocument()
  })

  it("publishes a complete effective revision of an official row", async () => {
    let submitted:
      | (CataloguePublicationInput & { expectedRevision: number })
      | null = null
    server.use(
      http.get(apiUrl("/api/catalogue"), () =>
        HttpResponse.json({ items: [catalogueItemFixture] }),
      ),
      http.post(
        apiUrl("/api/catalogue/:itemId/revisions"),
        async ({ request }) => {
          submitted = (await request.json()) as CataloguePublicationInput & {
            expectedRevision: number
          }
          return HttpResponse.json(
            {
              item: {
                ...catalogueItemFixture,
                fixedCost: submitted.fixedCost,
                provenance: "edited",
                revision: 1,
                latestChange: {
                  reason: submitted.reason,
                  evidence: submitted.evidence,
                  createdAt: "2026-09-01T17:00:00.000Z",
                  createdBy: { id: "user-admin", displayName: "Admin User" },
                },
              },
            },
            { status: 201 },
          )
        },
      ),
    )

    const { user } = renderApp("/catalogue")
    const itemHeading = await screen.findByRole("heading", {
      level: 3,
      name: catalogueItemFixture.name,
    })
    const card = itemHeading.closest("article")!
    await user.click(within(card).getByRole("button", { name: "Edit effective row" }))

    const dialog = await screen.findByRole("dialog", {
      name: "Publish catalogue edit",
    })
    const fixedCost = within(dialog).getByLabelText("Fixed unit cost (U$)")
    await user.clear(fixedCost)
    await user.type(fixedCost, "5.75")
    await user.type(
      within(dialog).getByLabelText("Reason for this row"),
      "Team reviewed current material pricing",
    )
    await user.click(within(dialog).getByRole("button", { name: "Publish revision" }))

    await waitFor(() => {
      expect(submitted).toMatchObject({
        expectedRevision: 0,
        releaseId: "catalogue-release-26-r1",
        name: catalogueItemFixture.name,
        fixedCost: "5.75",
        reason: "Team reviewed current material pricing",
      })
    })
  })
})
