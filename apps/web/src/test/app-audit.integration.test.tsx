import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import App from "@/App"
import { api, type Evidence, type ValidationResult } from "@/lib/api"
import {
  assemblyNodeFixture,
  evidenceFixture,
  metaFixture,
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
import { setViewport } from "@/test/viewport"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()

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

function useValidation(result: ValidationResult) {
  server.use(
    http.get(
      apiUrl("/api/projects/:projectId/validation"),
      () => HttpResponse.json(result),
    ),
  )
}

describe("production-readiness audit regressions", () => {
  it("removes unsupported header and navigation controls", async () => {
    renderApp("/validation")

    await screen.findByText("Competition report checks")

    const header = document.querySelector("header")
    expect(header).not.toBeNull()
    expect(
      within(header!).queryByText("Formula SAE-A 2026"),
    ).not.toBeInTheDocument()
    expect(
      within(header!).queryByRole("combobox", { name: "Select project" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Help" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Collapse navigation" }),
    ).not.toBeInTheDocument()
  })

  it("connects the keyboard skip link to the focusable main landmark", async () => {
    renderApp("/validation")

    await screen.findByText("Competition report checks")

    const skipLink = screen.getByRole("link", {
      name: "Skip to main content",
    })
    const main = screen.getByRole("main")

    expect(skipLink).toHaveAttribute("href", "#main-content")
    expect(main).toHaveAttribute("id", "main-content")
    expect(main).toHaveAttribute("tabindex", "-1")
    expect(document.querySelector("#main-content")).toBe(main)
  })

  it("keeps saving separate from explicit report setup confirmation", async () => {
    const { user } = renderApp("/setup")

    const confirm = await screen.findByRole("button", {
      name: "Confirm report setup",
    })
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(confirm).toBeDisabled()
    expect(save).toBeDisabled()

    await user.type(
      screen.getByLabelText("Cost-management summary"),
      " Updated for the current vehicle.",
    )

    await waitFor(() => expect(save).toBeEnabled())
    expect(confirm).toBeDisabled()
    expect(
      screen.getByRole("checkbox", {
        name: /Confirm the saved report setup/,
      }),
    ).toBeDisabled()
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2)
  })

  it("pins a node draft to its original version and preserves it after a conflict", async () => {
    useConfirmedProject()
    let remoteNode = { ...partNodeFixture }
    let updateBody: Record<string, unknown> | null = null
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json({
          ...projectDetailFixture,
          project: {
            ...projectDetailFixture.project,
            report_setup_confirmed: 1,
            report_setup_confirmation: projectSetupConfirmationFixture,
          },
          flatNodes: projectDetailFixture.flatNodes.map((node) =>
            node.id === remoteNode.id ? remoteNode : node,
          ),
        }),
      ),
      http.patch(
        apiUrl("/api/nodes/:nodeId"),
        async ({ request }) => {
          updateBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json(
            {
              error: {
                code: "version-conflict",
                message: "The node changed on the server.",
              },
            },
            { status: 409 },
          )
        },
      ),
    )
    const { user, queryClient } = renderApp(
      `/?node=${partNodeFixture.id}`,
    )

    const name = await screen.findByLabelText("Name")
    await user.clear(name)
    await user.type(name, "My unsaved upright draft")

    remoteNode = {
      ...remoteNode,
      name: "Upright changed by another editor",
      version: remoteNode.version + 1,
    }
    await queryClient.invalidateQueries({
      queryKey: ["workspace"],
    })
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: remoteNode.name,
        }),
      ).toBeInTheDocument(),
    )
    expect(name).toHaveValue("My unsaved upright draft")

    await user.click(
      screen.getByRole("button", { name: "Save part" }),
    )

    expect(
      await screen.findByText("Reload before saving"),
    ).toBeInTheDocument()
    expect(updateBody).toMatchObject({
      expectedVersion: partNodeFixture.version,
      name: "My unsaved upright draft",
    })
    expect(name).toHaveValue("My unsaved upright draft")
    expect(
      screen.getByRole("button", { name: "Save part" }),
    ).toBeDisabled()

    await user.click(
      screen.getByRole("button", {
        name: "Reload latest and discard draft",
      }),
    )
    expect(name).toHaveValue(remoteNode.name)
    expect(screen.getByText("Saved")).toBeInTheDocument()
  })

  it("restores the selected validation filter and page after editing an issue", async () => {
    useConfirmedProject()
    const warningIssues = Array.from({ length: 21 }, (_, index) => ({
      id: `part-visual-missing:${partNodeFixture.id}:${index + 1}`,
      severity: "warning" as const,
      code: "part-visual-missing",
      title: `Visual warning ${index + 1}`,
      detail: "Attach enough visual detail for judges to verify the part.",
      nodeId: partNodeFixture.id,
      ruleReference: "Local Addendum S.3.12.3",
    }))
    useValidation({
      ...validationFixture,
      blockers: 0,
      warnings: warningIssues.length,
      notices: 0,
      readyForCompetitionReport: false,
      issues: warningIssues,
    })
    const { user } = renderApp("/validation")

    const filters = await screen.findByRole("group", {
      name: "Filter validation findings",
    })
    const warningsFilter = within(filters).getByRole("button", {
      name: "warning",
    })
    await user.click(warningsFilter)
    await waitFor(() =>
      expect(currentPath()).toBe(
        `/validation?filter=warning&workspace=${projectSummaryFixture.id}`,
      ),
    )

    const pagination = screen.getByLabelText(
      "Validation findings pages",
    )
    await user.click(
      within(pagination).getByRole("button", { name: "Next" }),
    )

    expect(await screen.findByText("Visual warning 21")).toBeInTheDocument()
    expect(currentPath()).toBe(
      `/validation?filter=warning&page=2&workspace=${projectSummaryFixture.id}`,
    )
    expect(
      within(pagination).getByText("Page 2 of 2"),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Complete required evidence" }),
    )
    const back = await screen.findByRole("button", {
      name: "Back to validation",
    })
    expect(currentPath()).toBe(
      `/?node=${partNodeFixture.id}&section=evidence&workspace=${projectSummaryFixture.id}`,
    )

    await user.click(back)

    await screen.findByRole("heading", {
      level: 1,
      name: "Validation",
    })
    await waitFor(() =>
      expect(currentPath()).toBe(
        `/validation?filter=warning&page=2&workspace=${projectSummaryFixture.id}`,
      ),
    )
    const restoredFilters = screen.getByRole("group", {
      name: "Filter validation findings",
    })
    expect(
      within(restoredFilters).getByRole("button", {
        name: "warning",
      }),
    ).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("Visual warning 21")).toBeInTheDocument()
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument()
  })

  it("includes new uploads in reports and exposes report visibility in attachment details", async () => {
    useConfirmedProject()

    const { user } = renderApp(
      `/?node=${partNodeFixture.id}&section=evidence`,
    )

    await screen.findByRole("heading", {
      level: 3,
      name: "Attachments",
    })
    expect(screen.queryByLabelText("Visibility")).not.toBeInTheDocument()
    expect(screen.queryByText("Include in report")).not.toBeInTheDocument()
    expect(await screen.findByText("0 of 2 required")).toBeInTheDocument()

    const requirements = screen.getByRole("list", {
      name: "Evidence requirements",
    })
    expect(
      within(requirements).getByText("Isometric image"),
    ).toBeInTheDocument()
    expect(
      within(requirements).getByText("Technical drawing"),
    ).toBeInTheDocument()
    expect(
      within(requirements).getByText("Component datasheet"),
    ).toBeInTheDocument()
    expect(
      within(requirements).getByText("For electrical components."),
    ).toBeInTheDocument()
    expect(within(requirements).getAllByText("Required")).toHaveLength(2)
    expect(within(requirements).getByText("Optional")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Component datasheet file"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Attach component datasheet" }),
    ).not.toBeInTheDocument()

    const fileInput = screen.getByLabelText("Isometric image file")
    expect(fileInput).toHaveAttribute(
      "accept",
      ".png,.jpg,.jpeg,image/png,image/jpeg",
    )

    const file = new File(["image-bytes"], "upright-photo.png", {
      type: "image/png",
    })
    await user.upload(
      fileInput,
      file,
    )
    await user.type(
      screen.getByLabelText("Isometric image report caption"),
      "Front upright manufacturing evidence",
    )
    const attach = screen.getByRole("button", {
      name: "Attach isometric image",
    })
    await waitFor(() => expect(attach).toBeEnabled())

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ evidence: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    )
    try {
      await api.uploadEvidence(projectSummaryFixture.id, file, {
        kind: "drawing",
        nodeId: partNodeFixture.id,
        reportCaption: "Front upright manufacturing evidence",
      })
      const request = fetchMock.mock.calls[0]?.[1]
      expect(request?.body).toBeInstanceOf(FormData)
      if (!(request?.body instanceof FormData)) {
        throw new Error("Expected evidence upload to use FormData")
      }
      expect(request.body.get("visibility")).toBe("report")
    } finally {
      fetchMock.mockRestore()
    }

    await user.click(
      screen.getByRole("button", {
        name: `Edit details for ${evidenceFixture.display_name}`,
      }),
    )
    const detailsDialog = await screen.findByRole("dialog", {
      name: "Edit evidence details",
    })
    expect(
      within(detailsDialog).queryByLabelText("Visibility"),
    ).not.toBeInTheDocument()
    expect(
      within(detailsDialog).getByRole("checkbox", {name: "Include in report"}),
    ).not.toBeChecked()
    expect(
      within(detailsDialog).getByLabelText("Report caption"),
    ).toBeInTheDocument()
    await user.click(within(detailsDialog).getByRole("button", { name: "Cancel" }))

    await user.click(
      screen.getByRole("button", {
        name: `Preview ${evidenceFixture.display_name}`,
      }),
    )
    const previewDialog = await screen.findByRole("dialog", {
      name: evidenceFixture.display_name,
    })
    expect(
      within(previewDialog).getByTitle(
        `Preview ${evidenceFixture.display_name}`,
      ),
    ).toHaveAttribute("src", `${evidenceFixture.viewUrl}#toolbar=1&navpanes=0`)
  })

  it("separates item, selected-scope, and whole-car blockers in the inspector", async () => {
    useValidation({
      ...validationFixture,
      blockers: 2,
      issues: [
        validationFixture.issues[0]!,
        {
          id: `part-not-costed:${partNodeFixture.id}`,
          severity: "blocker",
          code: "part-not-costed",
          title: `${partNodeFixture.name} has no cost lines`,
          detail: "Add current catalogue-backed cost lines.",
          nodeId: partNodeFixture.id,
          ruleReference: "Local Addendum S.3.4.1",
        },
      ],
    })

    const { user } = renderApp("/")
    const table = await screen.findByRole("region", {
      name: "Bill of materials cost table. Scroll horizontally to reach all cost and status columns.",
    })
    const inspector = screen
      .getByRole("heading", { name: "Record Inspector" })
      .closest("aside")
    expect(inspector).not.toBeNull()

    const assemblyDirect = within(inspector!).getByText("This item").closest("div")
    const assemblyScope = within(inspector!)
      .getByText("Including contents")
      .closest("div")
    const wholeCar = within(inspector!).getByText("Whole car").closest("div")
    expect(assemblyDirect).toHaveTextContent("0")
    expect(assemblyScope).toHaveTextContent("1")
    expect(wholeCar).toHaveTextContent("2")

    await user.click(
      within(table).getByRole("button", {
        name: `Inspect part ${partNodeFixture.full_number} ${partNodeFixture.name}`,
      }),
    )

    expect(
      within(inspector!).getByText("This item").closest("div"),
    ).toHaveTextContent("1")
    expect(
      await within(inspector!).findByRole("button", {
        name: `Preview ${evidenceFixture.display_name}`,
      }),
    ).toBeInTheDocument()
  })

  it("makes the name-first BOM tree primary and keeps workspace tools compact", async () => {
    useConfirmedProject()
    const { user } = renderApp("/")

    const featureTree = await screen.findByRole("tree", {
      name: "Bill of materials feature tree",
    })
    const navigation = featureTree.closest("nav")
    expect(navigation).not.toBeNull()

    expect(
      within(featureTree).getByRole("button", {
        name: `Open system ${systemNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(
      within(featureTree).getByRole("button", {
        name: `Open assembly ${assemblyNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    await user.click(
      within(featureTree).getByRole("button", {
        name: `Expand ${assemblyNodeFixture.name}`,
      }),
    )
    expect(
      within(featureTree).getByRole("button", {
        name: `Open part ${partNodeFixture.name}`,
      }),
    ).toHaveTextContent(partNodeFixture.name)
    expect(
      within(featureTree).queryByText(partNodeFixture.full_number),
    ).not.toBeInTheDocument()

    const workspaceTools = within(navigation!).getByRole("button", {
      name: "Workspace tools",
    })
    expect(workspaceTools).toHaveAttribute("aria-expanded", "false")
    expect(
      within(navigation!).queryByRole("button", { name: "Validation" }),
    ).not.toBeInTheDocument()

    await user.click(workspaceTools)

    expect(workspaceTools).toHaveAttribute("aria-expanded", "true")
    expect(
      within(navigation!).getByRole("button", { name: "Report setup" }),
    ).toBeInTheDocument()
    expect(
      within(navigation!).getByRole("button", { name: "Validation" }),
    ).toBeInTheDocument()
    expect(
      within(navigation!).getByRole("button", { name: "Reports" }),
    ).toBeInTheDocument()
  })

  it("switches records from the sidebar without losing drafts and keeps the selected visual in view", async () => {
    useConfirmedProject()
    const { user } = renderApp(`/?node=${assemblyNodeFixture.id}`)

    await user.click(
      await screen.findByRole("tab", { name: /^Details\b/ }),
    )
    const name = await screen.findByLabelText("Name")
    await user.type(name, " draft")

    const navigation = screen.getByRole("navigation", {
      name: "Primary navigation",
    })
    const featureTree = within(navigation).getByRole("tree", {
      name: "Bill of materials feature tree",
    })
    const currentAssembly = within(featureTree).getByRole("button", {
      name: `Open assembly ${assemblyNodeFixture.name}`,
    })
    const openPart = await within(featureTree).findByRole("button", {
      name: `Open part ${partNodeFixture.name}`,
    })
    expect(currentAssembly).toHaveAttribute("aria-current", "page")

    await user.click(openPart)

    const discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    })
    await user.click(
      within(discardDialog).getByRole("button", { name: "Keep editing" }),
    )
    expect(currentPath()).toBe(
      `/?node=${assemblyNodeFixture.id}&workspace=${projectSummaryFixture.id}`,
    )
    expect(name).toHaveValue(`${assemblyNodeFixture.name} draft`)

    await user.click(openPart)
    await user.click(
      within(
        await screen.findByRole("dialog", {
          name: "Discard unsaved changes?",
        }),
      ).getByRole("button", { name: "Discard and continue" }),
    )

    await waitFor(() =>
      expect(currentPath()).toBe(
        `/?node=${partNodeFixture.id}&workspace=${projectSummaryFixture.id}`,
      ),
    )
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: partNodeFixture.name,
      }),
    ).toBeInTheDocument()
    expect(openPart).toHaveAttribute("aria-current", "page")

    const visual = screen.getByLabelText(
      `Visual context for ${partNodeFixture.name}`,
    )
    expect(
      within(visual).getByRole("heading", { name: "Isometric image" }),
    ).toBeInTheDocument()
    expect(
      within(visual).getByRole("heading", { name: "Technical drawing" }),
    ).toBeInTheDocument()
    expect(
      within(visual).queryByRole("heading", { name: "Datasheet" }),
    ).not.toBeInTheDocument()
    expect(visual).toHaveTextContent("No isometric image attached yet.")
    expect(
      within(visual).getByRole("button", {
        name: `Enlarge technical drawing for ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(visual).toHaveTextContent(evidenceFixture.display_name)
  })

  it("shows image and drawing together, with a datasheet only when attached", async () => {
    const photo = {
      ...evidenceFixture,
      id: "evidence-upright-photo",
      kind: "image",
      display_name: "upright-isometric.jpg",
      mime_type: "image/jpeg",
      report_caption: "Front-right upright isometric photo",
      viewUrl: "/api/evidence/evidence-upright-photo/view",
      downloadUrl: "/api/evidence/evidence-upright-photo/download",
    } satisfies Evidence
    const datasheet = {
      ...evidenceFixture,
      id: "evidence-upright-datasheet",
      kind: "datasheet",
      display_name: "upright-datasheet.pdf",
      report_caption: "Supplier upright datasheet",
      viewUrl: "/api/evidence/evidence-upright-datasheet/view",
      downloadUrl: "/api/evidence/evidence-upright-datasheet/download",
    } satisfies Evidence
    server.use(
      http.get(apiUrl("/api/projects/:projectId/evidence"), () =>
        HttpResponse.json({ evidence: [evidenceFixture, photo, datasheet] }),
      ),
    )
    useConfirmedProject()
    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    const visual = await screen.findByLabelText(
      `Visual context for ${partNodeFixture.name}`,
    )
    expect(visual.closest('[data-slot="card"]')).not.toBeNull()
    expect(visual).not.toHaveTextContent("Opens full size when selected")
    expect(visual.querySelector('[data-slot="badge"]')).toBeNull()
    expect(
      await within(visual).findByRole("heading", {
        name: "Isometric image",
      }),
    ).toBeInTheDocument()
    expect(
      within(visual).getByRole("heading", { name: "Technical drawing" }),
    ).toBeInTheDocument()
    expect(
      within(visual).getByRole("heading", { name: "Datasheet" }),
    ).toBeInTheDocument()

    const enlarge = await within(visual).findByRole("button", {
      name: `Enlarge isometric image for ${partNodeFixture.name}`,
    })
    expect(enlarge).toHaveAttribute("data-preview-variant", "gallery")
    expect(enlarge.querySelector("img")).toHaveAttribute(
      "src",
      photo.viewUrl,
    )
    expect(
      within(visual).getByRole("button", {
        name: `Enlarge technical drawing for ${partNodeFixture.name}`,
      }),
    ).toHaveAttribute("data-preview-variant", "gallery")
    expect(
      within(visual).getByRole("button", {
        name: `Enlarge datasheet for ${partNodeFixture.name}`,
      }),
    ).toHaveAttribute("data-preview-variant", "gallery")
    expect(visual).toHaveTextContent(photo.display_name)
    expect(visual).toHaveTextContent(evidenceFixture.display_name)
    expect(visual).toHaveTextContent(datasheet.display_name)

    await user.click(enlarge)
    const previewDialog = await screen.findByRole("dialog", {
      name: photo.display_name,
    })
    expect(within(previewDialog).getByRole("img")).toHaveAttribute(
      "src",
      photo.viewUrl,
    )
  })

  it("opens the existing evidence upload flow from an empty visual slot", async () => {
    useConfirmedProject()
    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    const visual = await screen.findByLabelText(
      `Visual context for ${partNodeFixture.name}`,
    )
    const uploadFromVisual = await within(visual).findByRole("button", {
      name: `Upload isometric image for ${partNodeFixture.name}`,
    })
    expect(uploadFromVisual).toHaveTextContent("Click to choose a file")
    expect(uploadFromVisual).toHaveClass("border-dashed")
    expect(uploadFromVisual.closest("article")).not.toHaveClass("border")

    const fileInput = screen.getByLabelText("Isometric image file")
    const inputClick = vi.spyOn(fileInput, "click")
    await user.click(uploadFromVisual)

    expect(inputClick).toHaveBeenCalledOnce()
    expect(screen.getByRole("tab", { name: /^Evidence\b/ })).toHaveAttribute(
      "aria-selected",
      "true",
    )

    const image = new File(["image"], "upright-isometric.png", {
      type: "image/png",
    })
    await user.upload(fileInput, image)

    expect((fileInput as HTMLInputElement).files?.[0]).toBe(image)
    expect(screen.getByText(image.name)).toBeVisible()
    expect(
      screen.getByLabelText("Isometric image report caption"),
    ).toBeVisible()
  })

  it("keeps the same named hierarchy and selected visual available on mobile", async () => {
    setViewport(390)
    useConfirmedProject()
    const { user } = renderApp(`/?node=${partNodeFixture.id}`)

    const visual = await screen.findByLabelText(
      `Visual context for ${partNodeFixture.name}`,
    )
    expect(
      await within(visual).findByRole("button", {
        name: `Enlarge technical drawing for ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(visual).toHaveTextContent(evidenceFixture.display_name)

    await user.click(
      screen.getByRole("button", { name: "Open navigation" }),
    )
    const navigationDialog = await screen.findByRole("dialog", {
      name: "Navigation",
    })
    const featureTree = within(navigationDialog).getByRole("tree", {
      name: "Bill of materials feature tree",
    })
    expect(
      within(featureTree).getByRole("button", {
        name: `Open part ${partNodeFixture.name}`,
      }),
    ).toHaveAttribute("aria-current", "page")
    expect(
      within(featureTree).queryByText(partNodeFixture.full_number),
    ).not.toBeInTheDocument()
  })

  it("keeps mobile cost details collapsed until explicitly expanded", async () => {
    setViewport(390)
    useConfirmedProject()
    const { user } = renderApp("/")

    const mobileItems = await screen.findByRole("list", {
      name: "Bill of materials items",
    })
    const toggle = within(mobileItems).getByRole("button", {
      name: `${partNodeFixture.name} part cost breakdown`,
    })
    const item = toggle.closest("article")
    expect(item).not.toBeNull()

    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(item!).queryByText("Material")).not.toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    for (const label of ["Material", "Process", "Fastener", "Tooling"]) {
      expect(within(item!).getByText(label)).toBeInTheDocument()
    }

    await user.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(item!).queryByText("Material")).not.toBeInTheDocument()
  })

  it("opens a system assembly tree with one click on desktop and mobile", async () => {
    useConfirmedProject()
    const { user } = renderApp("/")

    const desktopTable = await screen.findByRole("region", {
      name: "Bill of materials cost table. Scroll horizontally to reach all cost and status columns.",
    })
    await user.click(
      within(desktopTable).getByRole("button", {
        name: `Open system assembly tree ${systemNodeFixture.system_code} ${systemNodeFixture.name}`,
      }),
    )

    expect(currentPath()).toBe(
      `/?node=${systemNodeFixture.id}&section=children&workspace=${projectSummaryFixture.id}`,
    )
    expect(
      await screen.findByRole("heading", { name: "Assembly tree" }),
    ).toHaveFocus()
    expect(
      screen.getByRole("img", {
        name: `${systemNodeFixture.name} assembly tree with 2 descendants`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Assemblies" }),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Back to bill of materials" }),
    )
    setViewport(390)

    const mobileItems = await screen.findByRole("list", {
      name: "Bill of materials items",
    })
    await user.click(
      within(mobileItems).getByRole("button", {
        name: `Open system assembly tree ${systemNodeFixture.system_code} ${systemNodeFixture.name}`,
      }),
    )

    expect(currentPath()).toBe(
      `/?node=${systemNodeFixture.id}&section=children&workspace=${projectSummaryFixture.id}`,
    )
    expect(
      await screen.findByRole("img", {
        name: `${systemNodeFixture.name} assembly tree with 2 descendants`,
      }),
    ).toBeInTheDocument()
  })

  it("expands and collapses the complete BOM hierarchy while retaining row controls", async () => {
    useConfirmedProject()
    const { user } = renderApp("/")

    const collapseAll = await screen.findByRole("button", {
      name: "Collapse all hierarchy",
    })
    expect(
      screen.getByRole("button", {
        name: `Inspect part ${partNodeFixture.full_number} ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()

    await user.click(collapseAll)

    expect(
      screen.queryByRole("button", {
        name: `Inspect assembly ${assemblyNodeFixture.full_number} ${assemblyNodeFixture.name}`,
      }),
    ).not.toBeInTheDocument()
    const expandAll = screen.getByRole("button", {
      name: "Expand all hierarchy",
    })

    const desktopTable = screen.getByRole("region", {
      name: /Bill of materials cost table/,
    })
    await user.click(
      within(desktopTable).getByRole("button", {
        name: `Expand ${systemNodeFixture.system_code} ${systemNodeFixture.name}`,
      }),
    )
    expect(
      screen.getByRole("button", {
        name: `Inspect assembly ${assemblyNodeFixture.full_number} ${assemblyNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: `Inspect part ${partNodeFixture.full_number} ${partNodeFixture.name}`,
      }),
    ).not.toBeInTheDocument()

    await user.click(expandAll)

    expect(
      screen.getByRole("button", {
        name: `Inspect part ${partNodeFixture.full_number} ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
  })

  it("counts and filters only blockers while retaining warning and notice status", async () => {
    useConfirmedProject()
    useValidation({
      ...validationFixture,
      blockers: 1,
      warnings: 1,
      notices: 1,
      issues: [
        {
          id: `node-blocker:${systemNodeFixture.id}`,
          severity: "blocker",
          code: "node-blocker",
          title: "Suspension requires review",
          detail: "Review this system.",
          nodeId: systemNodeFixture.id,
          ruleReference: "Test blocker",
        },
        {
          id: `node-warning:${assemblyNodeFixture.id}`,
          severity: "warning",
          code: "node-warning",
          title: "Assembly warning",
          detail: "Review this assembly.",
          nodeId: assemblyNodeFixture.id,
          ruleReference: "Test warning",
        },
        {
          id: `node-notice:${partNodeFixture.id}`,
          severity: "notice",
          code: "node-notice",
          title: "Part notice",
          detail: "Review this part.",
          nodeId: partNodeFixture.id,
          ruleReference: "Test notice",
        },
      ],
    })
    const { user } = renderApp("/")

    const blockersOnly = await screen.findByRole("button", {
      name: "Blockers only 1",
    })
    expect(
      screen.getByRole("button", {
        name: `1 blocker for ${systemNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: `0 blockers for ${partNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("1 warning")).toBeInTheDocument()
    expect(screen.getByText("1 notice")).toBeInTheDocument()

    await user.click(blockersOnly)

    expect(blockersOnly).toHaveAttribute("aria-pressed", "true")
    expect(
      screen.getByRole("button", {
        name: `1 blocker for ${systemNodeFixture.name}`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: `0 blockers for ${partNodeFixture.name}`,
      }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("1 warning")).not.toBeInTheDocument()
    expect(screen.queryByText("1 notice")).not.toBeInTheDocument()
  })

  it("exposes real inspector actions through one accessible overflow menu", async () => {
    setViewport(1280)
    useConfirmedProject()
    const { user } = renderApp("/")
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue()

    const openActions = await screen.findByRole("button", {
      name: `Open actions for ${assemblyNodeFixture.name}`,
    })
    await user.click(openActions)

    let menu = await screen.findByRole("menu")
    expect(
      within(menu).getByRole("menuitem", { name: "Edit record" }),
    ).toBeInTheDocument()
    expect(
      within(menu).getByRole("menuitem", { name: "Copy identifier" }),
    ).toBeInTheDocument()
    expect(
      within(menu).getByRole("menuitem", { name: "Copy deep link" }),
    ).toBeInTheDocument()

    await user.click(
      within(menu).getByRole("menuitem", { name: "Copy identifier" }),
    )
    expect(writeText).toHaveBeenLastCalledWith(
      assemblyNodeFixture.full_number,
    )

    const originalExecCommand = Object.getOwnPropertyDescriptor(
      document,
      "execCommand",
    )
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    })
    writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"))

    await user.click(openActions)
    menu = await screen.findByRole("menu")
    await user.click(
      within(menu).getByRole("menuitem", { name: "Copy deep link" }),
    )
    expect(writeText).toHaveBeenLastCalledWith(
      `http://localhost/?node=${assemblyNodeFixture.id}`,
    )
    expect(execCommand).toHaveBeenCalledWith("copy")
    if (originalExecCommand) {
      Object.defineProperty(
        document,
        "execCommand",
        originalExecCommand,
      )
    } else {
      Reflect.deleteProperty(document, "execCommand")
    }

    await user.click(openActions)
    menu = await screen.findByRole("menu")
    await user.click(
      within(menu).getByRole("menuitem", { name: "Edit record" }),
    )
    await waitFor(() =>
      expect(currentPath()).toBe(
        `/?node=${assemblyNodeFixture.id}&workspace=${projectSummaryFixture.id}`,
      ),
    )
  })

  it("presents a submitted ledger as read-only instead of offering edits", async () => {
    setViewport(1280)
    const submittedSummary = {
      ...projectSummaryFixture,
      status: "submitted" as const,
      report_setup_confirmed: 1,
      report_setup_confirmation: projectSetupConfirmationFixture,
    }
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json({
          ...projectDetailFixture,
          project: {
            ...projectDetailFixture.project,
            ...submittedSummary,
          },
        }),
      ),
    )
    const { user } = renderApp("/")

    expect(
      await screen.findByText("Submission locked · read-only"),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Reopen for editing" }),
    ).toBeEnabled()

    await user.click(
      screen.getByRole("button", {
        name: `Open actions for ${assemblyNodeFixture.name}`,
      }),
    )
    const menu = await screen.findByRole("menu")
    expect(
      within(menu).getByRole("menuitem", { name: "View record" }),
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole("menuitem", { name: "Edit record" }),
    ).not.toBeInTheDocument()

    await user.click(
      within(menu).getByRole("menuitem", { name: "View record" }),
    )
    expect(await screen.findByLabelText("Name")).toBeDisabled()
  })

  it("states the active rule pack dynamically without promising release imports", async () => {
    server.use(
      http.get(apiUrl("/api/meta"), () =>
        HttpResponse.json({
          ...metaFixture,
          rulePack: {
            version: "release-test-9",
            sha256: "release-test-sha256",
          },
        }),
      ),
    )
    renderApp("/rule-pack")

    const governingSources = await screen.findByRole("heading", {
      name: "Governing sources",
    })
    const releaseCopy =
      governingSources.parentElement?.querySelector("p")
    expect(releaseCopy).not.toBeNull()
    expect(releaseCopy).toHaveTextContent(
      "Active rule pack release-test-9 is identified by SHA-256 release-test-sha256",
    )
    expect(
      screen.getByTitle("release-test-9"),
    ).toHaveTextContent("release-test-9")
    expect(
      screen.queryByText(/Updates must be imported as a new source/),
    ).not.toBeInTheDocument()
  })

  it("describes retained import provenance without claiming original bytes", async () => {
    useConfirmedProject()
    renderApp("/import")

    expect(
      await screen.findByText(
        "Source filename, SHA-256 hash, and parsed row provenance",
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Original bytes/),
    ).not.toBeInTheDocument()
  })
})
