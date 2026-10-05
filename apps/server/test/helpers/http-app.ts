import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request, { type Agent, type Test } from "supertest";

import { createApp } from "../../src/app";
import {
  getAppPaths,
  type AppPaths,
  type HttpSecurityConfig,
} from "../../src/config";
import { type DatabaseHandle } from "../../src/db/database";
import { bootstrapAdministrator } from "../../src/security/auth-service";
import { installReferenceData } from "../../src/services/reference-data-service";
import { ensureTeamWorkspace } from "../../src/services/workspace-service";
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from "./postgres";

export const TEST_ORIGIN = "http://ucm.integration.test";
export const TEST_CSRF_SECRET =
  "ucm-integration-test-csrf-secret-000000000000000000000000";
export const TEST_AUDIT_IP_SALT =
  "ucm-integration-test-audit-salt-00000000000000000000000";
export const ADMIN_EMAIL = "admin@ucm.integration.test";
export const TEST_MEMBER_ACCESS_KEY =
  "ucm-integration-test-member-access-key-2026";
export const TEST_VIEWER_ACCESS_KEY =
  "ucm-integration-test-viewer-access-key-2026";
export const TEST_ADMIN_ACCESS_KEY =
  "ucm-integration-test-admin-access-key-2026";

const security: HttpSecurityConfig = {
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
};

const repositoryFilesNeededAtRuntime = [
  "docs/Local Addendum 2026 Version 1.2 (1).pdf",
  "docs/references/official/FSAE-A_2026_Local_Addendum_v1.4.pdf",
  "docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx",
] as const;

export interface HttpTestContext {
  postgres: PostgresTestDatabase;
  database: DatabaseHandle;
  temporaryRoot: string;
  paths: AppPaths;
  app: ReturnType<typeof createApp>;
  adminAgent: Agent;
  adminUser: {
    id: string;
    email: string;
    displayName: string;
    role: "admin";
  };
  adminCsrfToken: string;
  close(): Promise<void>;
}

export async function createHttpTestContext(options: {
  enableLegacyImports?: boolean;
} = {}): Promise<HttpTestContext> {
  const postgres = await createPostgresTestDatabase();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "ucm-postgres-http-"),
  );
  const defaultPaths = getAppPaths();
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const dataRoot = path.join(temporaryRoot, "data");
  const paths: AppPaths = {
    repositoryRoot,
    dataRoot,
    uploadRoot: path.join(dataRoot, "uploads"),
    reportRoot: path.join(dataRoot, "reports"),
    outputPdfRoot: path.join(temporaryRoot, "output", "pdf"),
    webDistRoot: path.join(temporaryRoot, "missing-web-dist"),
  };

  try {
    await Promise.all(
      repositoryFilesNeededAtRuntime.map(async (relativePath) => {
        const destination = path.join(repositoryRoot, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(
          path.join(defaultPaths.repositoryRoot, relativePath),
          destination,
        );
      }),
    );
    await installReferenceData(postgres.database);
    await ensureTeamWorkspace(postgres.database);
    const administrator = await bootstrapAdministrator(postgres.database, {
      email: ADMIN_EMAIL,
      displayName: "Integration Administrator",
    });
    const app = createApp({
      database: postgres.database,
      paths,
      security,
      production: false,
      enableLegacyImports: options.enableLegacyImports ?? true,
    });
    const adminAgent = request.agent(app);
    const login = await adminAgent
      .post("/api/auth/login")
      .set("origin", TEST_ORIGIN)
      .send({ email: ADMIN_EMAIL, key: TEST_ADMIN_ACCESS_KEY })
      .expect(200);

    return {
      postgres,
      database: postgres.database,
      temporaryRoot,
      paths,
      app,
      adminAgent,
      adminUser: {
        id: administrator.id,
        email: administrator.email,
        displayName: administrator.display_name,
        role: "admin",
      },
      adminCsrfToken: login.body.csrfToken as string,
      async close(): Promise<void> {
        await postgres.close();
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await postgres.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function mutation(
  operation: Test,
  csrfToken: string,
): Test {
  return operation
    .set("origin", TEST_ORIGIN)
    .set("x-csrf-token", csrfToken);
}

export async function getTeamWorkspace(
  context: HttpTestContext,
  overrides: Partial<{
    name: string;
    season: number;
    vehicleType: "electric" | "combustion" | "dual";
    entryNumber: string;
    focusSystems: string[];
  }> = {},
): Promise<Record<string, unknown> & { id: string; version: number }> {
  const current = await context.adminAgent.get("/api/workspace").expect(200);
  const changes = {
    name: overrides.name,
    season: overrides.season,
    vehicleType: overrides.vehicleType,
    entryNumber: overrides.entryNumber,
    focusSystems: overrides.focusSystems,
  };
  const hasChanges = Object.values(changes).some(
    (value) => value !== undefined,
  );
  if (!hasChanges) {
    return current.body.project as Record<string, unknown> & {
      id: string;
      version: number;
    };
  }
  const response = await mutation(
    context.adminAgent.patch("/api/workspace"),
    context.adminCsrfToken,
  )
    .send({
      expectedVersion: current.body.project.version,
      ...Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      ),
    })
    .expect(200);
  return response.body.project as Record<string, unknown> & {
    id: string;
    version: number;
  };
}

export async function createAndLogin(
  context: HttpTestContext,
  input: {
    email: string;
    displayName: string;
    role: "admin" | "editor" | "viewer";
  },
): Promise<{
  agent: Agent;
  csrfToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "editor" | "viewer";
    version: number;
  };
}> {
  const created = await mutation(
    context.adminAgent.post("/api/users"),
    context.adminCsrfToken,
  )
    .send(input)
    .expect(201);
  if (created.body.activation !== undefined) {
    throw new Error("active-user-creation-returned-obsolete-activation");
  }
  if (created.body.user.status !== "active") {
    throw new Error("created-user-is-not-active");
  }

  const agent = request.agent(context.app);
  const login = await agent
    .post("/api/auth/login")
    .set("origin", TEST_ORIGIN)
    .send({
      email: input.email,
      key:
        input.role === "admin"
          ? TEST_ADMIN_ACCESS_KEY
          : input.role === "viewer"
            ? TEST_VIEWER_ACCESS_KEY
            : TEST_MEMBER_ACCESS_KEY,
    })
    .expect(200);
  return {
    agent,
    csrfToken: login.body.csrfToken as string,
    user: login.body.user,
  };
}
