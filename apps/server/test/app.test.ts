import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import request from "supertest";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  verifyAuditLedgerRows,
  type AuditLedgerRow,
} from "../src/audit/audit-ledger";
import { createApp } from "../src/app";
import { getAppPaths } from "../src/config";
import { LATEST_DATABASE_MIGRATION } from "../src/db/database";
import { systemDefinitions } from "../src/domain/systems";
import {
  CATALOGUE_RELEASE_ID,
  OFFICIAL_RULE_DOCUMENT_ID,
} from "../src/services/reference-data-service";
import {
  ADMIN_EMAIL,
  TEST_ADMIN_ACCESS_KEY,
  TEST_AUDIT_IP_SALT,
  TEST_CSRF_SECRET,
  TEST_MEMBER_ACCESS_KEY,
  TEST_VIEWER_ACCESS_KEY,
  TEST_ORIGIN,
  createAndLogin,
  createHttpTestContext,
  getTeamWorkspace,
  mutation,
  type HttpTestContext,
} from "./helpers/http-app";
import { hasPostgresTestDatabase } from "./helpers/postgres";

const TAILSCALE_HTTP_ORIGIN = "http://100.64.0.10:8080";

describe
  .skipIf(!hasPostgresTestDatabase())
  .sequential("authenticated PostgreSQL HTTP application", () => {
  let context: HttpTestContext;
  let projectId: string;

  beforeAll(async () => {
    context = await createHttpTestContext({ enableLegacyImports: true });
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("starts with verified reference data and one ready team workspace", async () => {
    const projectCount = await context.database.one<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM projects",
    );
    expect(projectCount.count).toBe(1);

    const health = await request(context.app).get("/health").expect(200);
    expect(health.body).toMatchObject({
      status: "ok",
      database: "ready",
      databaseEngine: "postgresql",
      migrationVersion: LATEST_DATABASE_MIGRATION,
      sourceIntegrity: { verified: true, documents: 3 },
      projects: 1,
    });

    const workspace = await context.adminAgent
      .get("/api/workspace")
      .expect(200);
    expect(workspace.body.project).toMatchObject({
      name: "UC Motorsport 2026",
      season: 2026,
      vehicle_type: "electric",
      entry_number: "E13",
    });
  });

  it("enforces origin, authentication, and CSRF before mutable routes", async () => {
    const missingOrigin = await request(context.app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(403);
    expect(missingOrigin.body.error.code).toBe("origin-not-allowed");

    const anonymousMutation = await request(context.app)
      .patch("/api/workspace")
      .set("origin", TEST_ORIGIN)
      .send({})
      .expect(401);
    expect(anonymousMutation.body.error.code).toBe(
      "authentication-required",
    );

    const missingCsrf = await context.adminAgent
      .patch("/api/workspace")
      .set("origin", TEST_ORIGIN)
      .send({})
      .expect(403);
    expect(missingCsrf.body.error.code).toBe("csrf-token-invalid");

    const me = await context.adminAgent.get("/api/auth/me").expect(200);
    expect(me.body).toMatchObject({
      user: {
        id: context.adminUser.id,
        email: ADMIN_EMAIL,
        role: "admin",
        status: "active",
      },
      csrfToken: context.adminCsrfToken,
      capabilities: {
        canManageUsers: true,
        canManageImports: true,
      },
    });

    const disposableAgent = request.agent(context.app);
    const disposableLogin = await disposableAgent
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);
    const setCookies = disposableLogin.headers[
      "set-cookie"
    ] as unknown as string[] | undefined;
    const cookies = setCookies?.join("; ");
    expect(cookies).toContain("ucm_session=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Strict");
    await mutation(
      disposableAgent.post("/api/auth/logout"),
      disposableLogin.body.csrfToken,
    ).expect(204);
    const revoked = await disposableAgent
      .get("/api/auth/me")
      .expect(401);
    expect(revoked.body.error.code).toBe("authentication-required");
    const revokedCookie = setCookies?.[0]?.split(";")[0];
    expect(revokedCookie).toBeTruthy();
    const staleCookie = await request(context.app)
      .get("/api/auth/me")
      .set("cookie", revokedCookie!)
      .expect(401);
    expect(staleCookie.body.error.code).toBe("session-invalid");
  });

  it("uses secure host cookies by default and a non-host cookie for the explicit HTTP override", async () => {
    const secureApp = createApp({
      database: context.database,
      paths: context.paths,
      production: true,
      security: {
        csrfSecret: TEST_CSRF_SECRET,
        auditIpSalt: TEST_AUDIT_IP_SALT,
        sharedAccessKey: TEST_MEMBER_ACCESS_KEY,
        viewerAccessKey: TEST_VIEWER_ACCESS_KEY,
        adminAccessKey: TEST_ADMIN_ACCESS_KEY,
        allowWeakAccessKeys: false,
        allowedOrigins: [TEST_ORIGIN],
        allowMissingOrigin: false,
        trustedProxyHops: 0,
        secureSessionCookies: true,
      },
    });
    const secureLogin = await request(secureApp)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);
    const secureCookie = (
      secureLogin.headers["set-cookie"] as unknown as string[] | undefined
    )?.[0];
    expect(secureLogin.headers["strict-transport-security"]).toBeDefined();
    expect(secureLogin.headers["content-security-policy"]).toContain(
      "upgrade-insecure-requests",
    );
    expect(secureCookie).toContain("__Host-ucm_session=");
    expect(secureCookie).toContain("Path=/");
    expect(secureCookie).toContain("HttpOnly");
    expect(secureCookie).toContain("Secure");
    expect(secureCookie).toContain("SameSite=Strict");
    expect(secureCookie).not.toMatch(/;\s*Domain=/i);

    const secureCookiePair = secureCookie?.split(";")[0];
    expect(secureCookiePair).toBeTruthy();
    await request(secureApp)
      .get("/api/auth/me")
      .set("cookie", secureCookiePair!)
      .expect(200);
    const secureLogout = await request(secureApp)
      .post("/api/auth/logout")
      .set("origin", TEST_ORIGIN)
      .set("x-csrf-token", secureLogin.body.csrfToken)
      .set("cookie", secureCookiePair!)
      .expect(204);
    const secureClearCookie = (
      secureLogout.headers["set-cookie"] as unknown as string[] | undefined
    )?.[0];
    expect(secureClearCookie).toContain("__Host-ucm_session=;");
    expect(secureClearCookie).toContain("Path=/");
    expect(secureClearCookie).toContain("HttpOnly");
    expect(secureClearCookie).toContain("Secure");
    expect(secureClearCookie).toContain("SameSite=Strict");
    expect(secureClearCookie).not.toMatch(/;\s*Domain=/i);

    const insecureApp = createApp({
      database: context.database,
      paths: context.paths,
      production: true,
      security: {
        csrfSecret: TEST_CSRF_SECRET,
        auditIpSalt: TEST_AUDIT_IP_SALT,
        sharedAccessKey: TEST_MEMBER_ACCESS_KEY,
        viewerAccessKey: TEST_VIEWER_ACCESS_KEY,
        adminAccessKey: TEST_ADMIN_ACCESS_KEY,
        allowWeakAccessKeys: false,
        allowedOrigins: [TAILSCALE_HTTP_ORIGIN],
        allowMissingOrigin: false,
        trustedProxyHops: 0,
        secureSessionCookies: false,
      },
    });
    const insecureAgent = request.agent(insecureApp);
    const insecureLogin = await insecureAgent
      .post("/api/auth/login")
      .set("origin", TAILSCALE_HTTP_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);
    const insecureCookie = (
      insecureLogin.headers["set-cookie"] as unknown as string[] | undefined
    )?.[0];
    expect(insecureLogin.headers["strict-transport-security"]).toBeUndefined();
    expect(insecureLogin.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );
    expect(insecureCookie).toContain("ucm_session=");
    expect(insecureCookie).not.toContain("__Host-ucm_session=");
    expect(insecureCookie).toContain("Path=/");
    expect(insecureCookie).toContain("HttpOnly");
    expect(insecureCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    expect(insecureCookie).toContain("SameSite=Strict");
    expect(insecureCookie).not.toMatch(/;\s*Domain=/i);

    await insecureAgent.get("/api/auth/me").expect(200);
    const insecureLogout = await insecureAgent
      .post("/api/auth/logout")
      .set("origin", TAILSCALE_HTTP_ORIGIN)
      .set("x-csrf-token", insecureLogin.body.csrfToken)
      .expect(204);
    const insecureClearCookie = (
      insecureLogout.headers["set-cookie"] as unknown as
        | string[]
        | undefined
    )?.[0];
    expect(insecureClearCookie).toContain("ucm_session=;");
    expect(insecureClearCookie).not.toContain("__Host-ucm_session=");
    expect(insecureClearCookie).toContain("Path=/");
    expect(insecureClearCookie).toContain("HttpOnly");
    expect(insecureClearCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    expect(insecureClearCookie).toContain("SameSite=Strict");
    expect(insecureClearCookie).not.toMatch(/;\s*Domain=/i);
    await insecureAgent.get("/api/auth/me").expect(401);
  }, 120_000);

  it("uses the access key for the stored role without revealing account state", async () => {
    const normalized = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: `  ${ADMIN_EMAIL.toUpperCase()}  `,
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(200);
    expect(normalized.body.user).toMatchObject({
      id: context.adminUser.id,
      email: ADMIN_EMAIL,
    });

    const localPartOnly = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: ADMIN_EMAIL.split("@")[0],
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(400);
    expect(localPartOnly.body.error.code).toBe("invalid-request");

    const obsoleteContract = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        username: ADMIN_EMAIL.split("@")[0],
        password: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(400);
    expect(obsoleteContract.body.error.code).toBe("invalid-request");

    const wrongKey = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: "not-an-access-key" })
      .expect(401);
    const adminWithMemberKey = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_MEMBER_ACCESS_KEY })
      .expect(401);
    const unknownEmail = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: "unknown@ucm.integration.test",
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(401);

    const viewer = await createAndLogin(context, {
      email: "shared-local@first.integration.test",
      displayName: "Shared Local First",
      role: "viewer",
    });
    const editor = await createAndLogin(context, {
      email: "shared-local@second.integration.test",
      displayName: "Shared Local Second",
      role: "editor",
    });
    expect(viewer.user.email).toBe("shared-local@first.integration.test");
    expect(editor.user.email).toBe("shared-local@second.integration.test");
    expect(viewer.user.id).not.toBe(editor.user.id);
    const viewerWithAdminKey = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: viewer.user.email, key: TEST_ADMIN_ACCESS_KEY })
      .expect(401);
    const editorWithAdminKey = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: editor.user.email, key: TEST_ADMIN_ACCESS_KEY })
      .expect(401);

    const disabledUser = await createAndLogin(context, {
      email: "disabled-login@ucm.integration.test",
      displayName: "Disabled Login",
      role: "viewer",
    });
    await mutation(
      context.adminAgent.patch(`/api/users/${disabledUser.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: disabledUser.user.version,
        status: "disabled",
      })
      .expect(200);
    const disabledEmail = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: disabledUser.user.email,
        key: TEST_MEMBER_ACCESS_KEY,
      })
      .expect(401);

    expect(adminWithMemberKey.body.error).toEqual(wrongKey.body.error);
    expect(unknownEmail.body.error).toEqual(wrongKey.body.error);
    expect(viewerWithAdminKey.body.error).toEqual(wrongKey.body.error);
    expect(editorWithAdminKey.body.error).toEqual(wrongKey.body.error);
    expect(disabledEmail.body.error).toEqual(wrongKey.body.error);
    expect(wrongKey.body.error.code).toBe("invalid-credentials");
  }, 120_000);

  it("permanently revokes sessions when a user's role changes", async () => {
    const transitioning = await createAndLogin(context, {
      email: "role-transition@ucm.integration.test",
      displayName: "Role Transition",
      role: "viewer",
    });
    const activeSessionCount = async () =>
      (
        await context.database.one<{ count: number }>(
          `
            SELECT COUNT(*)::integer AS count
            FROM sessions
            WHERE user_id = $1 AND revoked_at IS NULL
          `,
          [transitioning.user.id],
        )
      ).count;
    const loginAsMember = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_VIEWER_ACCESS_KEY,
      })
      .expect(200);
    const originalMemberCookie = (
      loginAsMember.headers["set-cookie"] as unknown as string[] | undefined
    )?.[0]?.split(";")[0];
    expect(originalMemberCookie).toBeTruthy();

    const promoted = await mutation(
      context.adminAgent.patch(`/api/users/${transitioning.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: transitioning.user.version,
        role: "admin",
      })
      .expect(200);
    expect(await activeSessionCount()).toBe(0);
    await request(context.app)
      .get("/api/auth/me")
      .set("cookie", originalMemberCookie!)
      .expect(401);
    await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_MEMBER_ACCESS_KEY,
      })
      .expect(401);
    const loginAsAdmin = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(200);
    const adminCookie = (
      loginAsAdmin.headers["set-cookie"] as unknown as string[] | undefined
    )?.[0]?.split(";")[0];
    expect(adminCookie).toBeTruthy();

    const demoted = await mutation(
      context.adminAgent.patch(`/api/users/${transitioning.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: promoted.body.user.version,
        role: "editor",
      })
      .expect(200);
    expect(await activeSessionCount()).toBe(0);
    await request(context.app)
      .get("/api/auth/me")
      .set("cookie", adminCookie!)
      .expect(401);
    await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(401);
    const secondMemberLogin = await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_MEMBER_ACCESS_KEY,
      })
      .expect(200);
    const secondMemberCookie = (
      secondMemberLogin.headers[
        "set-cookie"
      ] as unknown as string[] | undefined
    )?.[0]?.split(";")[0];
    expect(secondMemberCookie).toBeTruthy();

    const promotedAgain = await mutation(
      context.adminAgent.patch(`/api/users/${transitioning.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: demoted.body.user.version,
        role: "admin",
      })
      .expect(200);
    expect(await activeSessionCount()).toBe(0);
    for (const staleCookie of [
      originalMemberCookie!,
      adminCookie!,
      secondMemberCookie!,
    ]) {
      const stale = await request(context.app)
        .get("/api/auth/me")
        .set("cookie", staleCookie)
        .expect(401);
      expect(stale.body.error.code).toBe("session-invalid");
    }
    await request(context.app)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({
        email: transitioning.user.email,
        key: TEST_ADMIN_ACCESS_KEY,
      })
      .expect(200);
    await mutation(
      context.adminAgent.patch(`/api/users/${transitioning.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: promotedAgain.body.user.version,
        role: "viewer",
      })
      .expect(200);
  }, 120_000);

  it("returns the ready workspace pinned to verified governing sources", async () => {
    const meta = await context.adminAgent.get("/api/meta").expect(200);
    expect(meta.body).toMatchObject({
      currency: {
        code: "UNIVERSAL_DOLLAR",
        isRealCurrency: false,
      },
      catalogue: {
        releaseId: CATALOGUE_RELEASE_ID,
        revision: "26_R1",
      },
    });
    expect(meta.body.sourceDocuments).toHaveLength(3);

    for (const source of meta.body.sourceDocuments as Array<{
      id: string;
      downloadUrl: string;
      sha256: string;
    }>) {
      const download = await context.adminAgent
        .get(source.downloadUrl)
        .expect(200);
      expect(download.headers["content-disposition"]).toContain("attachment");
      expect(download.headers["x-content-sha256"]).toBe(source.sha256);
      expect(
        Number(download.headers["content-length"]),
      ).toBeGreaterThan(1_000);
    }

    const project = await getTeamWorkspace(context);
    projectId = project.id;
    expect(project).toMatchObject({
      name: "UC Motorsport 2026",
      season: 2026,
      vehicle_type: "electric",
      entry_number: "E13",
      rule_source_document_id: OFFICIAL_RULE_DOCUMENT_ID,
      catalogue_release_id: CATALOGUE_RELEASE_ID,
      catalogue_revision: "26_R1",
      report_setup_confirmed: 0,
      report_setup_confirmation: null,
      version: 0,
    });

    const detail = await context.adminAgent
      .get("/api/workspace")
      .expect(200);
    expect(detail.body.project.id).toBe(projectId);
    expect(detail.body.tree.kind).toBe("vehicle");
    expect(
      detail.body.flatNodes.filter(
        (node: { kind: string }) => node.kind === "system",
      ),
    ).toHaveLength(systemDefinitions.length);
    expect(detail.body.breakdown.total).toBe("0");
  }, 120_000);

  it("preserves an active administrator while team access follows system roles", async () => {
    const users = await context.adminAgent.get("/api/users").expect(200);
    const administrator = users.body.users.find(
      (user: { id: string }) => user.id === context.adminUser.id,
    );
    const lastAdmin = await mutation(
      context.adminAgent.patch(`/api/users/${context.adminUser.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: administrator.version,
        role: "editor",
      })
      .expect(409);
    expect(lastAdmin.body.error.code).toBe(
      "last-active-admin-required",
    );

    await createAndLogin(context, {
      email: "second-admin@ucm.integration.test",
      displayName: "Second Administrator",
      role: "admin",
    });
    const editor = await createAndLogin(context, {
      email: "team-editor@ucm.integration.test",
      displayName: "Team Editor",
      role: "editor",
    });
    const disabledEditor = await mutation(
      context.adminAgent.patch(`/api/users/${editor.user.id}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: editor.user.version,
        status: "disabled",
      })
      .expect(200);
    expect(disabledEditor.body.user.status).toBe("disabled");
  }, 120_000);

  it("records an actor/time/content-hash declaration and invalidates it on setup edits", async () => {
    const before = await projectDetail();
    const setupUpdate = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: before.project.version,
        projectSummary:
          "The UCM26 production vehicle cost report documents the current engineering design and manufacturing plan for competition review.",
        numberingConvention:
          "Numbers use the season, system code, six-digit reference, and controlled revision suffix.",
        bulkMethodSummary:
          "Each costed part records its representative production method, catalogue inputs, and any documented bulk-process deviation.",
      })
      .expect(200);
    expect(setupUpdate.body.project).toMatchObject({
      version: before.project.version + 1,
      report_setup_confirmed: 0,
      report_setup_confirmation: null,
    });

    const confirmed = await mutation(
      context.adminAgent.post(
        "/api/workspace/report-setup-confirmation",
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: setupUpdate.body.project.version,
        attested: true,
      })
      .expect(201);
    expect(confirmed.body.project).toMatchObject({
      version: setupUpdate.body.project.version + 1,
      report_setup_confirmed: 1,
      report_setup_confirmation: {
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        confirmedBy: {
          id: context.adminUser.id,
          displayName: context.adminUser.displayName,
          email: context.adminUser.email,
        },
        projectVersion: setupUpdate.body.project.version + 1,
      },
    });
    expect(
      Date.parse(
        confirmed.body.project.report_setup_confirmation.confirmedAt,
      ),
    ).not.toBeNaN();

    const edited = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: confirmed.body.project.version,
        projectSummary:
          "The UCM26 production vehicle cost report now documents the reviewed current engineering design and manufacturing plan.",
      })
      .expect(200);
    expect(edited.body.project).toMatchObject({
      version: confirmed.body.project.version + 1,
      report_setup_confirmed: 0,
      report_setup_confirmation: null,
    });

    const invalidated = await context.database.one<{
      invalidated_at: string | null;
      invalidated_by: string | null;
      invalidation_reason: string | null;
    }>(
      `
        SELECT invalidated_at, invalidated_by, invalidation_reason
        FROM project_setup_confirmations
        WHERE project_id = $1
      `,
      [projectId],
    );
    expect(invalidated).toMatchObject({
      invalidated_at: expect.any(String),
      invalidated_by: context.adminUser.id,
      invalidation_reason: "report-setup-fields-changed",
    });

    const stale = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: confirmed.body.project.version,
        name: "Stale project overwrite",
      })
      .expect(409);
    expect(stale.body.error.code).toBe("version-conflict");
  });

  it("lists seasons without exposing arbitrary project lifecycle or membership routes", async () => {
    const projects = await context.adminAgent.get("/api/projects").expect(200);
    expect(projects.body.projects).toHaveLength(1);
    expect(projects.body.projects[0].id).toBe(projectId);
    await mutation(
      context.adminAgent.post("/api/projects"),
      context.adminCsrfToken,
    )
      .send({})
      .expect(404);
    await mutation(
      context.adminAgent.delete(`/api/projects/${projectId}`),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 0 })
      .expect(404);
    await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/restore`),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 0 })
      .expect(404);
    await context.adminAgent
      .get(`/api/projects/${projectId}/members`)
      .expect(404);
  });

  it("allows team editors to write and keeps team viewers read-only", async () => {
    const editor = await createAndLogin(context, {
      email: "editor@ucm.integration.test",
      displayName: "Team Editor",
      role: "editor",
    });
    const viewer = await createAndLogin(context, {
      email: "viewer@ucm.integration.test",
      displayName: "Team Viewer",
      role: "viewer",
    });
    await viewer.agent.get("/api/workspace").expect(200);
    const current = await projectDetail();
    const viewerWrite = await mutation(
      viewer.agent.patch("/api/workspace"),
      viewer.csrfToken,
    )
      .send({
        expectedVersion: current.project.version,
        name: "Viewer must not write",
      })
      .expect(403);
    expect(viewerWrite.body.error.code).toBe("permission-denied");

    const editorWrite = await mutation(
      editor.agent.patch("/api/workspace"),
      editor.csrfToken,
    )
      .send({
        expectedVersion: current.project.version,
        name: "UCM26 Production Vehicle — Editor Reviewed",
      })
      .expect(200);
    expect(editorWrite.body.project).toMatchObject({
      name: "UCM26 Production Vehicle — Editor Reviewed",
      updated_by: editor.user.id,
      version: current.project.version + 1,
    });

    const staleAdminWrite = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: current.project.version,
        name: "Stale administrator overwrite",
      })
      .expect(409);
    expect(staleAdminWrite.body.error.code).toBe("version-conflict");
  });

  it("persists import preview history and cancellation only when the dev feature is enabled", async () => {
    const csv = await readFile(
      path.join(
        getAppPaths().repositoryRoot,
        "apps/server/test/fixtures/legacy-master.csv",
      ),
    );
    const preview = await mutation(
      context.adminAgent.post(
        `/api/projects/${projectId}/imports/preview`,
      ),
      context.adminCsrfToken,
    )
      .attach("file", csv, {
        filename: "2025-master-parts.csv",
        contentType: "text/csv",
      })
      .expect(201);
    expect(preview.body).toMatchObject({
      projectId,
      sourceName: "2025-master-parts.csv",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "preview",
      version: 0,
      preview: {
        template: "legacy-master",
        readOnly: true,
      },
      createdBy: {
        id: context.adminUser.id,
      },
    });

    const history = await context.adminAgent
      .get(`/api/projects/${projectId}/imports`)
      .expect(200);
    expect(history.body.batches).toContainEqual(
      expect.objectContaining({
        id: preview.body.id,
        status: "preview",
        version: 0,
      }),
    );
    const recovered = await context.adminAgent
      .get(`/api/imports/${preview.body.id}`)
      .expect(200);
    expect(recovered.body.preview.records).toHaveLength(9);

    const cancelled = await mutation(
      context.adminAgent.delete(`/api/imports/${preview.body.id}`),
      context.adminCsrfToken,
    )
      .send({ expectedVersion: 0 })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      id: preview.body.id,
      status: "cancelled",
      version: 1,
      cancelledAt: expect.any(String),
    });

    const disabledApp = createApp({
      database: context.database,
      paths: context.paths,
      production: false,
      enableLegacyImports: false,
      security: {
        csrfSecret: TEST_CSRF_SECRET,
        auditIpSalt: TEST_AUDIT_IP_SALT,
        sharedAccessKey: TEST_MEMBER_ACCESS_KEY,
        viewerAccessKey: TEST_VIEWER_ACCESS_KEY,
        adminAccessKey: TEST_ADMIN_ACCESS_KEY,
        allowWeakAccessKeys: false,
        secureSessionCookies: false,
        allowedOrigins: [TEST_ORIGIN],
        allowMissingOrigin: false,
        trustedProxyHops: 0,
      },
    });
    const disabledAgent = request.agent(disabledApp);
    await disabledAgent
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);
    await disabledAgent
      .get(`/api/projects/${projectId}/imports`)
      .expect(404);

    const productionApp = createApp({
      database: context.database,
      paths: context.paths,
      production: true,
      enableLegacyImports: true,
      security: {
        csrfSecret: TEST_CSRF_SECRET,
        auditIpSalt: TEST_AUDIT_IP_SALT,
        sharedAccessKey: TEST_MEMBER_ACCESS_KEY,
        viewerAccessKey: TEST_VIEWER_ACCESS_KEY,
        adminAccessKey: TEST_ADMIN_ACCESS_KEY,
        allowWeakAccessKeys: false,
        secureSessionCookies: true,
        allowedOrigins: [TEST_ORIGIN],
        allowMissingOrigin: false,
        trustedProxyHops: 0,
      },
    });
    const productionLogin = await request(productionApp)
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);
    const productionCookie = productionLogin.headers["set-cookie"];
    expect(productionCookie).toBeDefined();
    if (!productionCookie) {
      throw new Error("production-login-cookie-missing");
    }
    const productionRequest = (pathName: string) =>
      request(productionApp).get(pathName).set("Cookie", productionCookie);
    const productionMeta = await productionRequest("/api/meta").expect(200);
    expect(productionMeta.body.features.legacyImports).toBe(false);
    await productionRequest(
      `/api/projects/${projectId}/imports`,
    ).expect(404);
  }, 120_000);

  it("freezes a submitted workspace, preserves reads, and serializes reopen and child mutations", async () => {
    const beforeSubmission = await projectDetail();
    const submitted = await context.database.one<{
      version: number;
    }>(
      `
        UPDATE projects
        SET status = 'submitted',
            updated_by = $1,
            updated_at = clock_timestamp(),
            version = version + 1
        WHERE id = $2
        RETURNING version
      `,
      [context.adminUser.id, projectId],
    );

    const readable = await context.adminAgent
      .get("/api/workspace")
      .expect(200);
    expect(readable.body.project).toMatchObject({
      status: "submitted",
      version: submitted.version,
    });
    await context.adminAgent
      .get(`/api/projects/${projectId}/evidence`)
      .expect(200);
    await context.adminAgent
      .get(`/api/projects/${projectId}/reports`)
      .expect(200);
    await context.adminAgent
      .get(`/api/projects/${projectId}/cairs`)
      .expect(200);

    const implicitProjectEdit = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: submitted.version,
        name: "Submitted projects cannot be edited",
      })
      .expect(409);
    expect(implicitProjectEdit.body.error.code).toBe(
      "submitted-project-reopen-required",
    );
    const mixedReopen = await mutation(
      context.adminAgent.patch("/api/workspace"),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: submitted.version,
        status: "review",
        name: "Reopen and edit must be separate ledger events",
      })
      .expect(409);
    expect(mixedReopen.body.error.code).toBe(
      "submitted-project-reopen-only",
    );

    const parent = (
      readable.body.flatNodes as Array<{
        id: string;
        kind: string;
        version: number;
      }>
    ).find(({ kind }) => kind === "system")!;
    const parentId = parent.id;
    const childMutation = await mutation(
      context.adminAgent.post(`/api/nodes/${parentId}/children`),
      context.adminCsrfToken,
    )
      .send({
        expectedParentVersion: parent.version,
        kind: "assembly",
        name: "Must not be created after submission",
      })
      .expect(409);
    expect(childMutation.body.error.code).toBe(
      "project-submitted-read-only",
    );
    const cairMutation = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/cairs`),
      context.adminCsrfToken,
    )
      .send({
        requestedCatalogueDescription:
          "Must not be created after submission",
        rationale:
          "This request verifies the centralized submitted-state write guard.",
      })
      .expect(409);
    expect(cairMutation.body.error.code).toBe(
      "project-submitted-read-only",
    );
    const evidenceMutation = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/evidence`),
      context.adminCsrfToken,
    )
      .field("kind", "other")
      .field("visibility", "internal")
      .attach("file", Buffer.from("submitted evidence"), {
        filename: "submitted.txt",
        contentType: "text/plain",
      })
      .expect(409);
    expect(evidenceMutation.body.error.code).toBe(
      "project-submitted-read-only",
    );
    const reportMutation = await mutation(
      context.adminAgent.post(`/api/projects/${projectId}/reports`),
      context.adminCsrfToken,
    )
      .send({ mode: "draft" })
      .expect(409);
    expect(reportMutation.body.error.code).toBe(
      "project-submitted-read-only",
    );
    const declarationMutation = await mutation(
      context.adminAgent.post(
        "/api/workspace/report-setup-confirmation",
      ),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: submitted.version,
        attested: true,
      })
      .expect(409);
    expect(declarationMutation.body.error.code).toBe(
      "project-submitted-read-only",
    );
    await expect(
      context.database.query(
        `
          UPDATE cost_nodes
          SET description = 'direct database mutation must fail'
          WHERE id = $1
        `,
        [parentId],
      ),
    ).rejects.toMatchObject({
      code: "55000",
      message: "project-submitted-read-only",
    });

    const reopened = await mutation(
      context.adminAgent.patch(`/api/projects/${projectId}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: submitted.version,
        status: "review",
      })
      .expect(200);
    expect(reopened.body.project).toMatchObject({
      status: "review",
      version: submitted.version + 1,
    });

    const submissionClient = await context.database.pool.connect();
    try {
      await submissionClient.query("BEGIN");
      await submissionClient.query(
        `
          UPDATE projects
          SET status = 'submitted',
              updated_by = $1,
              updated_at = clock_timestamp(),
              version = version + 1
          WHERE id = $2
        `,
        [context.adminUser.id, projectId],
      );
      let mutationSettled = false;
      const concurrentMutation = mutation(
        context.adminAgent.post(`/api/projects/${projectId}/cairs`),
        context.adminCsrfToken,
      )
        .send({
          requestedCatalogueDescription:
            "Concurrent mutation must wait for submission",
          rationale:
            "The project row lock must serialize this request behind the submitted status transition.",
        })
        .then((response) => {
          mutationSettled = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mutationSettled).toBe(false);
      await submissionClient.query("COMMIT");
      const blockedAfterCommit = await concurrentMutation;
      expect(blockedAfterCommit.status).toBe(409);
      expect(blockedAfterCommit.body.error.code).toBe(
        "project-submitted-read-only",
      );
    } catch (error) {
      await submissionClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      submissionClient.release();
    }

    const afterConcurrentSubmission = await projectDetail();
    const reopenedAgain = await mutation(
      context.adminAgent.patch(`/api/projects/${projectId}`),
      context.adminCsrfToken,
    )
      .send({
        expectedVersion: afterConcurrentSubmission.project.version,
        status: "review",
      })
      .expect(200);
    expect(reopenedAgain.body.project.status).toBe("review");
    expect(beforeSubmission.project.id).toBe(projectId);
  }, 120_000);

  it("serves no source bytes after SHA-256 drift", async () => {
    const source = await context.database.one<{
      id: string;
      local_path: string;
    }>(
      `
        SELECT id, local_path
        FROM source_documents
        WHERE id = $1
      `,
      [OFFICIAL_RULE_DOCUMENT_ID],
    );
    const sourcePath = path.join(
      context.paths.repositoryRoot,
      source.local_path,
    );
    const original = await readFile(sourcePath);
    try {
      await writeFile(sourcePath, Buffer.from("altered governing bytes"));
      const rejected = await context.adminAgent
        .get(`/api/source-documents/${source.id}/download`)
        .expect(409);
      expect(rejected.body.error.code).toBe(
        "stored-file-integrity-failed",
      );
      expect(rejected.body.error.message).toContain("SHA-256");
    } finally {
      await writeFile(sourcePath, original);
    }
  });

  it("exposes the real actor ledger, verifies its hash chain, and rejects mutation", async () => {
    const activity = await context.adminAgent
      .get("/api/workspace/activity")
      .expect(200);
    const actions = activity.body.entries.map(
      (entry: { action: string }) => entry.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "workspace.provisioned",
        "project.updated",
        "project.report-setup-confirmed",
        "import.preview-created",
        "import.cancelled",
      ]),
    );
    expect(
      activity.body.entries.find(
        (entry: { action: string }) =>
          entry.action === "project.report-setup-confirmed",
      ).actor,
    ).toMatchObject({
      id: context.adminUser.id,
      email: context.adminUser.email,
    });

    const ledger = await context.database.query<AuditLedgerRow>(
      "SELECT * FROM audit_ledger ORDER BY sequence",
    );
    expect(verifyAuditLedgerRows(ledger.rows)).toEqual({
      ok: true,
      checked: ledger.rows.length,
      error: null,
    });

    const firstSequence = ledger.rows[0]?.sequence;
    expect(firstSequence).toBeDefined();
    await expect(
      context.database.query(
        "UPDATE audit_ledger SET action = 'tampered' WHERE sequence = $1",
        [firstSequence],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      context.database.query(
        "DELETE FROM audit_ledger WHERE sequence = $1",
        [firstSequence],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  async function projectDetail(): Promise<{
    project: {
      id: string;
      version: number;
      [key: string]: unknown;
    };
    tree: Record<string, unknown>;
    flatNodes: Array<Record<string, unknown>>;
  }> {
    const response = await context.adminAgent
      .get("/api/workspace")
      .expect(200);
    return response.body;
  }
  });
