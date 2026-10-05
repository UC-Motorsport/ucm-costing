import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { PartFlag } from "./part-flag"
import { partNodeFixture } from "@/test/fixtures"
import { renderWithProviders, screen, waitFor } from "@/test/render"
import { server } from "@/test/server"

const endpoint = `http://localhost/api/nodes/${partNodeFixture.id}`

describe("shared part flags", () => {
  it("saves a flag and comment using the version captured when opened", async () => {
    let submitted: unknown
    server.use(http.patch(endpoint, async ({ request }) => {
      submitted = await request.json()
      return HttpResponse.json({ node: { ...partNodeFixture, version: 3 } })
    }))
    const { user } = renderWithProviders(<PartFlag node={partNodeFixture} canWrite />)
    await user.click(screen.getByRole("button", { name: /Part status for/ }))
    await user.click(screen.getByRole("radio", { name: "Needs attention" }))
    expect(screen.getByRole("radio", { name: "Needs attention" })).toBeChecked()
    await user.type(screen.getByLabelText("Comment (optional)"), "Check the drawing revision")
    await user.click(screen.getByRole("button", { name: "Save status" }))
    await waitFor(() => expect(submitted).toEqual({ expectedVersion: 2, workStatus: "needs-attention", flagComment: "Check the drawing revision" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it.each(["done", "none"])("can change an existing flag to %s while retaining its comment", async (status) => {
    let submitted: unknown
    server.use(http.patch(endpoint, async ({ request }) => {
      submitted = await request.json()
      return HttpResponse.json({ node: partNodeFixture })
    }))
    const { user } = renderWithProviders(<PartFlag node={{ ...partNodeFixture, work_status: "needs-attention", flag_comment: "Check fit" }} canWrite />)
    await user.click(screen.getByRole("button", { name: /Needs attention, has comment/ }))
    expect(screen.getByLabelText("Comment (optional)")).toHaveValue("Check fit")
    await user.click(screen.getByRole("radio", { name: status === "done" ? "Done" : "No status" }))
    await user.click(screen.getByRole("button", { name: "Save status" }))
    await waitFor(() => expect(submitted).toMatchObject({ workStatus: status, flagComment: "Check fit" }))
  })

  it("preserves a conflicting draft until the user explicitly reloads", async () => {
    server.use(http.patch(endpoint, () => HttpResponse.json({ error: { code: "version-conflict", message: "Changed" } }, { status: 409 })))
    const { user } = renderWithProviders(<PartFlag node={partNodeFixture} canWrite />)
    await user.click(screen.getByRole("button", { name: /Part status for/ }))
    await user.type(screen.getByLabelText("Comment (optional)"), "My draft")
    await user.click(screen.getByRole("button", { name: "Save status" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("This part changed elsewhere")
    expect(screen.getByLabelText("Comment (optional)")).toHaveValue("My draft")
    expect(screen.getByRole("button", { name: "Save status" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Reload latest status" }))
    expect(screen.getByLabelText("Comment (optional)")).toHaveValue("")
  })

  it("allows viewers to read status and comments without editing", async () => {
    const { user } = renderWithProviders(<PartFlag node={{ ...partNodeFixture, work_status: "done", flag_comment: "Reviewed" }} canWrite={false} />)
    await user.click(screen.getByRole("button", { name: /Done, has comment/ }))
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled()
    expect(screen.getByRole("radio", { name: "Done" })).toBeChecked()
    expect(screen.getByLabelText("Comment (optional)")).toHaveAttribute("readonly")
    expect(screen.getByLabelText("Comment (optional)")).toHaveValue("Reviewed")
    expect(screen.queryByRole("button", { name: "Save status" })).not.toBeInTheDocument()
  })

  it("keeps the draft on a failed save and permits retry", async () => {
    server.use(http.patch(endpoint, () => HttpResponse.json({ error: "unavailable" }, { status: 503 })))
    const { user } = renderWithProviders(<PartFlag node={partNodeFixture} canWrite />)
    await user.click(screen.getByRole("button", { name: /Part status for/ }))
    await user.type(screen.getByLabelText("Comment (optional)"), "Retry this")
    await user.click(screen.getByRole("button", { name: "Save status" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save")
    expect(screen.getByLabelText("Comment (optional)")).toHaveValue("Retry this")
    expect(screen.getByRole("button", { name: "Save status" })).toBeEnabled()
  })
})
