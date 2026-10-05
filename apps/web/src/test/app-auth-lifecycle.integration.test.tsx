import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import App from "@/App"
import type {
  AuditEntry,
  AuthSession,
  ProjectDetail,
  UserRecord,
} from "@/lib/api"
import {
  adminUserFixture,
  authSessionFixture,
  editorUserFixture,
  importPreviewFixture,
  projectDetailFixture,
  projectSetupConfirmationFixture,
  projectSummaryFixture,
} from "@/test/fixtures"
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test/render"
import { server } from "@/test/server"

const apiUrl = (path: string) =>
  new URL(path, window.location.origin).toString()

function renderApp(route: string) {
  window.history.replaceState(null, "", route)
  return renderWithProviders(<App />)
}

function currentPath() {
  return `${window.location.pathname}${window.location.search}`
}

describe("authenticated production shell", () => {
  it("sends only email and key while the server selects the account-role key", async () => {
    let workspaceRequests = 0
    let loginBody: unknown
    server.use(
      http.get(apiUrl("/api/auth/me"), () =>
        HttpResponse.json(
          {
            error: {
              code: "authentication-required",
              message: "Sign in required",
            },
          },
          { status: 401 },
        ),
      ),
      http.get(apiUrl("/api/projects/:projectId"), () => {
        workspaceRequests += 1
        return HttpResponse.json(projectDetailFixture)
      }),
      http.post(apiUrl("/api/auth/login"), async ({ request }) => {
        loginBody = await request.json()
        return HttpResponse.json(authSessionFixture)
      }),
    )

    const { user } = renderApp("/")

    expect(
      await screen.findByRole("heading", {
        name: "Sign in to UCM Costing",
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Use your email address and the access key for your account role.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(workspaceRequests).toBe(0)

    await user.type(
      screen.getByLabelText("Email"),
      "ADMIN@UCMOTORSPORT.EXAMPLE",
    )
    await user.type(screen.getByLabelText("Key"), "correct horse battery")
    await user.click(screen.getByRole("button", { name: "Sign in" }))

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Bill of materials",
      }),
    ).toBeInTheDocument()
    expect(workspaceRequests).toBeGreaterThan(0)
    expect(loginBody).toEqual({
      email: "ADMIN@UCMOTORSPORT.EXAMPLE",
      key: "correct horse battery",
    })
  })

  it("keeps team membership out of the shell and clears it on CSRF-protected logout", async () => {
    let csrfHeader: string | null = null
    server.use(
      http.post(apiUrl("/api/auth/logout"), ({ request }) => {
        csrfHeader = request.headers.get("x-csrf-token")
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp("/validation")

    await screen.findByRole("heading", { level: 1, name: "Validation" })
    expect(screen.queryByText("Project members")).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("button", {
        name: `Account menu for ${adminUserFixture.displayName}`,
      }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    )

    expect(
      await screen.findByRole("heading", {
        name: "Sign in to UCM Costing",
      }),
    ).toBeInTheDocument()
    expect(csrfHeader).toBe(authSessionFixture.csrfToken)
  })

  it("lets administrators add users, change access, disable, and revoke sessions", async () => {
    const createdUser = {
      ...editorUserFixture,
      id: "user-created",
      email: "new.user@example.test",
      displayName: "New User",
      status: "active",
      version: 0,
    } satisfies UserRecord
    let userCreated = false
    const requests: Array<{
      method: string
      body: unknown
      csrf: string | null
    }> = []

    server.use(
      http.get(apiUrl("/api/users"), () =>
        HttpResponse.json({
          users: [
            adminUserFixture,
            editorUserFixture,
            ...(userCreated ? [createdUser] : []),
          ],
        }),
      ),
      http.post(apiUrl("/api/users"), async ({ request }) => {
        userCreated = true
        requests.push({
          method: "create",
          body: await request.json(),
          csrf: request.headers.get("x-csrf-token"),
        })
        return HttpResponse.json(
          {
            user: createdUser,
          },
          { status: 201 },
        )
      }),
      http.patch(apiUrl("/api/users/:userId"), async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>
        requests.push({
          method: `patch:${String(params.userId)}`,
          body,
          csrf: request.headers.get("x-csrf-token"),
        })
        return HttpResponse.json({
          user: {
            ...editorUserFixture,
            ...body,
            version: editorUserFixture.version + 1,
          },
        })
      }),
      http.post(
        apiUrl("/api/users/:userId/revoke-sessions"),
        ({ request, params }) => {
          requests.push({
            method: `revoke:${String(params.userId)}`,
            body: null,
            csrf: request.headers.get("x-csrf-token"),
          })
          return HttpResponse.json({ revokedSessions: 2 })
        },
      ),
    )
    const { user } = renderApp("/users")

    expect(
      await screen.findByRole("heading", { name: "Team users" }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add user" }))
    const dialog = await screen.findByRole("dialog", { name: "Add user" })
    await user.type(within(dialog).getByLabelText("Display name"), "New User")
    await user.type(
      within(dialog).getByLabelText("Email"),
      "new.user@example.test",
    )
    await user.click(
      within(dialog).getByRole("button", { name: "Create user" }),
    )

    expect(await screen.findByText(createdUser.email)).toBeInTheDocument()
    expect(requests).toContainEqual({
      method: "create",
      body: {
        displayName: createdUser.displayName,
        email: createdUser.email,
        role: createdUser.role,
      },
      csrf: authSessionFixture.csrfToken,
    })

    const editorRow = screen
      .getByText(editorUserFixture.email)
      .closest("tr")
    expect(editorRow).not.toBeNull()
    await user.click(
      within(editorRow!).getByRole("combobox", {
        name: `Role for ${editorUserFixture.displayName}`,
      }),
    )
    await user.click(await screen.findByRole("option", { name: "Viewer" }))
    await waitFor(() =>
      expect(
        requests.some(
          ({ body }) =>
            typeof body === "object" &&
            body !== null &&
            (body as Record<string, unknown>).role === "viewer",
        ),
      ).toBe(true),
    )

    await user.click(
      within(editorRow!).getByRole("button", { name: "Disable" }),
    )
    await waitFor(() =>
      expect(
        requests.some(
          ({ body }) =>
            typeof body === "object" &&
            body !== null &&
            (body as Record<string, unknown>).status === "disabled",
        ),
      ).toBe(true),
    )

    await user.click(
      within(editorRow!).getByRole("button", {
        name: "Revoke sessions",
      }),
    )
    await waitFor(() =>
      expect(
        requests.some(
          ({ method }) => method === `revoke:${editorUserFixture.id}`,
        ),
      ).toBe(true),
    )
    expect(
      requests.every(({ csrf }) => csrf === authSessionFixture.csrfToken),
    ).toBe(true)
  })

  it("shows no project selection, identity, creation, or archive controls", async () => {
    renderApp("/validation")
    const banner = await screen.findByRole("banner")

    expect(
      within(banner).queryByRole("combobox", {
        name: "Select project",
      }),
    ).not.toBeInTheDocument()
    expect(
      within(banner).queryByRole("button", { name: "Project actions" }),
    ).not.toBeInTheDocument()
    expect(
      within(banner).queryByText("Formula SAE-A 2026"),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Create project"),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Archived projects"),
    ).not.toBeInTheDocument()
  })

  it("saves setup text first, then records an explicit server confirmation", async () => {
    let currentProject: ProjectDetail["project"] = {
      ...projectDetailFixture.project,
    }
    let savedBody: unknown
    let confirmationBody: unknown
    let confirmationCsrf: string | null = null
    server.use(
      http.get(apiUrl("/api/projects/:projectId"), () =>
        HttpResponse.json({
          ...projectDetailFixture,
          project: currentProject,
        }),
      ),
      http.patch(apiUrl("/api/projects/:projectId"), async ({ request }) => {
        savedBody = await request.json()
        currentProject = {
          ...currentProject,
          ...(savedBody as {
            projectSummary: string
            numberingConvention: string
            bulkMethodSummary: string
          }),
          project_summary: (
            savedBody as { projectSummary: string }
          ).projectSummary,
          numbering_convention: (
            savedBody as { numberingConvention: string }
          ).numberingConvention,
          bulk_method_summary: (
            savedBody as { bulkMethodSummary: string }
          ).bulkMethodSummary,
          version: currentProject.version + 1,
          report_setup_confirmed: 0,
          report_setup_confirmation: null,
        }
        return HttpResponse.json({ project: currentProject })
      }),
      http.post(
        apiUrl("/api/projects/:projectId/declarations"),
        async ({ request }) => {
          confirmationBody = await request.json()
          confirmationCsrf = request.headers.get("x-csrf-token")
          currentProject = {
            ...currentProject,
            version: currentProject.version + 1,
            report_setup_confirmed: 1,
            report_setup_confirmation: {
              ...projectSetupConfirmationFixture,
              projectVersion: currentProject.version + 1,
            },
          }
          return HttpResponse.json({ project: currentProject })
        },
      ),
    )
    const { user } = renderApp("/setup")

    const summary = await screen.findByLabelText("Cost-management summary")
    await user.type(summary, " Updated for the actual current vehicle.")
    await user.click(screen.getByRole("button", { name: "Save changes" }))

    const attestation = await screen.findByRole("checkbox", {
      name: /Confirm the saved report setup/,
    })
    await waitFor(() => expect(attestation).toBeEnabled())
    expect(
      screen.getByRole("button", { name: "Confirm report setup" }),
    ).toBeDisabled()
    await user.click(attestation)
    await user.click(
      screen.getByRole("button", { name: "Confirm report setup" }),
    )

    expect(
      await screen.findByText("Active setup confirmation"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(projectSetupConfirmationFixture.contentHash),
    ).toBeInTheDocument()
    expect(savedBody).toMatchObject({
      expectedVersion: projectSummaryFixture.version,
    })
    expect(confirmationBody).toEqual({
      expectedVersion: projectSummaryFixture.version + 1,
      attested: true,
    })
    expect(confirmationCsrf).toBe(authSessionFixture.csrfToken)
  })

  it("hides legacy import operations without both capability and feature flag", async () => {
    const viewerSession = {
      ...authSessionFixture,
      user: {
        ...adminUserFixture,
        id: "user-viewer",
        role: "viewer",
      },
      capabilities: {
        ...authSessionFixture.capabilities,
        canManageImports: false,
      },
    } satisfies AuthSession
    server.use(
      http.get(apiUrl("/api/auth/me"), () =>
        HttpResponse.json(viewerSession),
      ),
    )

    renderApp("/import")

    await screen.findByRole("heading", {
      level: 1,
      name: "Bill of materials",
    })
    expect(currentPath()).toBe(`/?workspace=${projectSummaryFixture.id}`)
    expect(
      screen.queryByRole("button", { name: "Import" }),
    ).not.toBeInTheDocument()
  })

  it("resumes and cancels a persisted import preview with its stored version", async () => {
    let cancelBody: unknown
    let cancelCsrf: string | null = null
    server.use(
      http.get(apiUrl("/api/projects/:projectId/imports"), () =>
        HttpResponse.json({
          batches: [
            {
              id: importPreviewFixture.id,
              projectId: importPreviewFixture.projectId,
              sourceName: importPreviewFixture.sourceName,
              sourceSha256: importPreviewFixture.sourceSha256,
              template: importPreviewFixture.preview.template,
              status: "preview",
              version: importPreviewFixture.version,
              createdAt: importPreviewFixture.createdAt,
              committedAt: null,
              cancelledAt: null,
              createdBy: importPreviewFixture.createdBy,
              errors: 0,
              warnings: 0,
              insertedNodes: 0,
              skippedRows: 0,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.delete(apiUrl("/api/imports/:batchId"), async ({ request }) => {
        cancelBody = await request.json()
        cancelCsrf = request.headers.get("x-csrf-token")
        return HttpResponse.json({
          ...importPreviewFixture,
          status: "cancelled",
          version: importPreviewFixture.version + 1,
          cancelledAt: "2026-07-30T02:00:00.000Z",
        })
      }),
    )
    const { user } = renderApp("/import")

    await user.click(
      await screen.findByRole("button", { name: "Resume preview" }),
    )
    expect(
      await screen.findByText(
        new RegExp(importPreviewFixture.sourceSha256),
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel preview" }))

    expect(
      await screen.findByText("Choose a CSV exported from the team workbook"),
    ).toBeInTheDocument()
    expect(cancelBody).toEqual({
      expectedVersion: importPreviewFixture.version,
    })
    expect(cancelCsrf).toBe(authSessionFixture.csrfToken)
  })

  it("renders and paginates the server-recorded hash-linked activity ledger", async () => {
    const currentEntry = {
      sequence: "42",
      previousHash: "previous-entry-sha256",
      entryHash: "current-entry-sha256",
      actor: {
        id: adminUserFixture.id,
        displayName: adminUserFixture.displayName,
        email: adminUserFixture.email,
      },
      projectId: projectSummaryFixture.id,
      requestId: "request-current",
      action: "project.setup-confirmed",
      entityType: "project",
      entityId: projectSummaryFixture.id,
      before: { confirmed: false },
      after: { confirmed: true },
      metadata: { declarationId: "declaration-test" },
      occurredAt: "2026-07-30T02:00:00.000Z",
    } satisfies AuditEntry
    const olderEntry = {
      ...currentEntry,
      sequence: "41",
      previousHash: null,
      entryHash: "genesis-entry-sha256",
      requestId: "request-older",
      action: "project.created",
      before: null,
      after: { id: projectSummaryFixture.id },
      metadata: null,
      occurredAt: "2026-07-29T23:00:00.000Z",
    } satisfies AuditEntry
    const cursors: Array<string | null> = []
    server.use(
      http.get(
        apiUrl("/api/projects/:projectId/activity"),
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get(
            "cursor",
          )
          cursors.push(cursor)
          return cursor
            ? HttpResponse.json({
                entries: [olderEntry],
                nextCursor: null,
              })
            : HttpResponse.json({
                entries: [currentEntry],
                nextCursor: "41",
              })
        },
      ),
    )
    const { user } = renderApp("/activity")

    expect(
      await screen.findByRole("heading", {
        name: "Activity ledger",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("Sequence 42")).toBeInTheDocument()
    expect(
      screen.getByText(
        /Aroha Chen · admin@ucmotorsport\.example/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(currentEntry.entryHash)).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Load older activity" }),
    )
    expect(
      await screen.findByText("Sequence 41"),
    ).toBeInTheDocument()
    expect(cursors).toEqual([null, "41"])
  })
})
