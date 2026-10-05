import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import type { QueryResultRow } from "pg";
import { ZodError } from "zod";

import {
  CATALOGUE_REVISION,
  CATALOGUE_SHA256,
  LOCAL_ADDENDUM_SHA256,
  LOCAL_ADDENDUM_VERSION,
  getAppPaths,
  getHttpSecurityConfig,
  type AppPaths,
  type HttpSecurityConfig,
} from "./config";
import {
  databaseMigrationVersion,
  type DatabaseHandle,
} from "./db/database";
import { systemDefinitions } from "./domain/systems";
import {
  createVerifiedReadStream,
  FileIntegrityError,
  openVerifiedFile,
} from "./integrity/file-integrity";
import {
  createAuthenticatedAuthRouter,
  createPublicAuthRouter,
  createUserAdminRouter,
} from "./routes/auth-routes";
import { createCostDataRouter } from "./routes/cost-data-routes";
import { createEvidenceRouter } from "./routes/evidence-routes";
import { createHistoricalProjectRouter } from "./routes/historical-project-routes";
import { asyncRoute, routeParam } from "./routes/http";
import { createImportRouter } from "./routes/import-routes";
import { createProjectRouter } from "./routes/project-routes";
import { createProjectArchiveRouter } from "./routes/project-archive-routes";
import { createProjectCopyRouter } from "./routes/project-copy-routes";
import { createReportRouter } from "./routes/report-routes";
import { createWorkflowRouter } from "./routes/workflow-routes";
import { createWorkspaceRouter } from "./routes/workspace-routes";
import {
  authenticateRequest,
  csrfGuard,
  originGuard,
  requestContextMiddleware,
} from "./security/http-security";
import { SupportingWorkbookValidationError } from "./export/supporting-workbook";
import {
  CostAmendmentWorkflowBlockedError,
} from "./services/cost-amendment-service";
import {
  CostAmendmentValidationError,
} from "./report/cost-amendment-report";
import {
  getEvidenceFileCleanupStatus,
} from "./services/evidence-service";
import {
  ReportValidationError,
} from "./services/report-service";
import {
  VersionConflictError,
} from "./services/project-lifecycle-service";

interface SourceDocumentRow extends QueryResultRow {
  id: string;
  kind: string;
  title: string;
  version: string;
  originalUrl: string;
  sha256: string;
  applicability: string;
  local_path: string;
}

interface CurrentCatalogueRow extends QueryResultRow {
  id: string;
  revision_code: string;
  sha256: string;
}

export interface AppOptions {
  database: DatabaseHandle;
  paths?: AppPaths;
  security?: HttpSecurityConfig;
  production?: boolean;
  enableLegacyImports?: boolean;
}

export function createApp({
  database,
  paths = getAppPaths(),
  security = getHttpSecurityConfig(),
  production = process.env.NODE_ENV === "production",
  enableLegacyImports =
    process.env.UCM_ENABLE_LEGACY_IMPORTS === "true" ||
    process.env.NODE_ENV !== "production",
}: AppOptions): Express {
  const app = express();
  const productionBuild = process.env.NODE_ENV === "production";
  const legacyImportsEnabled =
    !productionBuild && !production && enableLegacyImports;
  const authOptions = {
    database,
    secureSessionCookies: security.secureSessionCookies,
    csrfSecret: security.csrfSecret,
    sharedAccessKey: security.sharedAccessKey,
    viewerAccessKey: security.viewerAccessKey,
    adminAccessKey: security.adminAccessKey,
  };

  app.disable("x-powered-by");
  app.set("trust proxy", security.trustedProxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "upgrade-insecure-requests": security.secureSessionCookies
            ? []
            : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: security.secureSessionCookies
        ? undefined
        : false,
    }),
  );
  app.use(requestContextMiddleware(security.auditIpSalt));
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(
    originGuard({
      allowedOrigins: security.allowedOrigins,
      allowMissingOrigin: security.allowMissingOrigin,
    }),
  );

  app.get(
    "/health",
    asyncRoute(async (_request, response) => {
      const [migrationVersion, cleanup, projectCount, sourceState] =
        await Promise.all([
          databaseMigrationVersion(database),
          getEvidenceFileCleanupStatus(database),
          database.one<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM projects",
          ),
          verifyInstalledSourceFiles(database, paths),
        ]);
      response.json({
        status: "ok",
        database: "ready",
        databaseEngine: "postgresql",
        migrationVersion,
        sourceIntegrity: sourceState,
        projects: projectCount.count,
        maintenance: { evidenceFileCleanup: cleanup },
      });
    }),
  );

  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60 * 1_000,
      limit: 1_000,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          code: "api-rate-limited",
          message: "Too many requests; try again later",
        },
      },
    }),
  );
  app.use("/api/auth", createPublicAuthRouter(authOptions));

  app.use(
    "/api",
    authenticateRequest(database, security.secureSessionCookies, {
      sharedAccessKey: security.sharedAccessKey,
      viewerAccessKey: security.viewerAccessKey,
      adminAccessKey: security.adminAccessKey,
    }),
  );
  app.use("/api", csrfGuard(security.csrfSecret));
  app.use("/api/auth", createAuthenticatedAuthRouter(authOptions));
  app.use("/api/users", createUserAdminRouter(authOptions));

  app.get(
    "/api/meta",
    asyncRoute(async (_request, response) => {
      const [sources, catalogue] = await Promise.all([
        listSourceDocuments(database),
        currentCatalogue(database),
      ]);
      response.json({
        application: "UCM Costing",
        currency: {
          code: "UNIVERSAL_DOLLAR",
          label: "Universal $",
          isRealCurrency: false,
        },
        rulePack: {
          version: LOCAL_ADDENDUM_VERSION,
          sha256: LOCAL_ADDENDUM_SHA256,
        },
        catalogue: {
          releaseId: catalogue.id,
          revision: catalogue.revision_code,
          sha256: catalogue.sha256,
        },
        systems: systemDefinitions,
        sourceDocuments: sources.map(sourceDocumentForApi),
        features: {
          legacyImports: legacyImportsEnabled,
          supportingWorkbook: true,
          costAmendments: true,
          cair: true,
          submissionPackages: true,
        },
        guardrails: [
          "The 2026 Local Addendum Appendix PDA-2 replaces the complete base S.3 cost rules.",
          "The app does not estimate unpublished D1-D4, A, Pmin, or Pmax scoring values.",
          "Competition costs are universal dollars, not NZD, AUD, or a team budget.",
          "External competition submission is recorded only after a user supplies the organizer receipt or reference.",
        ],
      });
    }),
  );

  app.get(
    "/api/source-documents/:sourceId/download",
    asyncRoute(async (request, response) => {
      const source = await database.maybeOne<SourceDocumentRow>(
        `
          SELECT id, kind, title, version,
                 original_url AS "originalUrl", sha256, applicability,
                 local_path
          FROM source_documents
          WHERE id = $1
        `,
        [routeParam(request, "sourceId")],
      );
      if (!source) {
        throw new Error("source-document-not-found");
      }
      const sourcePath = resolveRepositoryFile(
        paths.repositoryRoot,
        source.local_path,
      );
      const verified = await openVerifiedFile(sourcePath, source.sha256);
      response.status(200);
      response.type(path.extname(sourcePath));
      response.attachment(path.basename(source.local_path));
      response.setHeader("content-length", String(verified.stats.size));
      response.setHeader("x-content-sha256", verified.sha256);
      await pipeline(createVerifiedReadStream(verified), response);
    }),
  );

  app.use("/api/projects", createProjectRouter(database));
  app.use(
    "/api/project-archives",
    createProjectArchiveRouter(database, paths),
  );
  app.use("/api/project-copy", createProjectCopyRouter(database, paths));
  app.use(
    "/api/historical-projects",
    createHistoricalProjectRouter(database),
  );
  app.use("/api/workspace", createWorkspaceRouter(database));
  app.use("/api", createCostDataRouter(database, paths));
  app.use("/api", createEvidenceRouter(database, paths));
  app.use("/api", createReportRouter(database, paths));
  app.use("/api", createWorkflowRouter(database, paths));
  if (legacyImportsEnabled) {
    app.use("/api", createImportRouter(database));
  }

  if (fs.existsSync(path.join(paths.webDistRoot, "index.html"))) {
    app.use(
      express.static(paths.webDistRoot, {
        index: false,
        maxAge: production ? "1h" : 0,
        immutable: false,
      }),
    );
    app.use((request, response, next) => {
      if (
        request.method === "GET" &&
        !request.path.startsWith("/api/") &&
        request.accepts("html")
      ) {
        response.sendFile(path.join(paths.webDistRoot, "index.html"));
        return;
      }
      next();
    });
  }

  app.use((request, response) => {
    response.status(404).json({
      error: {
        code: "not-found",
        message: `No route for ${request.method} ${request.path}`,
      },
    });
  });
  app.use(errorHandler);
  return app;
}

const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "invalid-request",
        message: "Request validation failed",
        issues: error.issues,
      },
    });
    return;
  }
  if (error instanceof VersionConflictError) {
    response.status(409).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ReportValidationError) {
    response.status(422).json({
      error: {
        code: error.code,
        message: error.message,
        validation: error.validation,
      },
    });
    return;
  }
  if (error instanceof SupportingWorkbookValidationError) {
    response.status(422).json({
      error: {
        code: error.code,
        message: error.message,
        issues: error.issues,
      },
    });
    return;
  }
  if (
    error instanceof CostAmendmentWorkflowBlockedError ||
    error instanceof CostAmendmentValidationError
  ) {
    response.status(422).json({
      error: {
        code: error.code,
        message: error.message,
        issues: error.issues,
      },
    });
    return;
  }
  if (error instanceof FileIntegrityError) {
    response.status(409).json({
      error: {
        code: error.code,
        message:
          "Stored bytes no longer match their recorded SHA-256; the file was not served",
      },
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: { code: "upload-rejected", message: error.message },
    });
    return;
  }

  const postgresCode = postgresErrorCode(error);
  if (postgresCode === "23505") {
    response.status(409).json({
      error: {
        code: "record-conflict",
        message: "A record with that unique value already exists",
      },
    });
    return;
  }
  if (postgresCode === "23503" || postgresCode === "23514") {
    response.status(409).json({
      error: {
        code: "record-integrity-conflict",
        message: "The requested change violates a data integrity rule",
      },
    });
    return;
  }

  const code =
    error instanceof Error && error.message
      ? error.message
      : "internal-error";
  const status = statusForCode(code);
  if (status === 500) {
    process.stderr.write(
      `Request ${request.requestId ?? "unknown"} failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
  }
  response.status(status).json({
    error: {
      code: status === 500 ? "internal-error" : normalizeErrorCode(code),
      message:
        status === 500
          ? "Unexpected server error"
          : humanizeCode(code),
    },
  });
};

async function listSourceDocuments(
  database: DatabaseHandle,
): Promise<SourceDocumentRow[]> {
  const result = await database.query<SourceDocumentRow>(
    `
      SELECT id, kind, title, version,
             original_url AS "originalUrl", sha256, applicability,
             local_path
      FROM source_documents
      ORDER BY kind, lower(title), id
    `,
  );
  return result.rows;
}

async function currentCatalogue(
  database: DatabaseHandle,
): Promise<CurrentCatalogueRow> {
  const row = await database.maybeOne<CurrentCatalogueRow>(
    `
      SELECT cr.id, cr.revision_code, source.sha256
      FROM catalogue_releases cr
      JOIN source_documents source ON source.id = cr.source_document_id
      WHERE cr.revision_code = $1 AND source.sha256 = $2
      ORDER BY cr.imported_at DESC, cr.id
      LIMIT 1
    `,
    [CATALOGUE_REVISION, CATALOGUE_SHA256],
  );
  if (!row) {
    throw new Error("verified-catalogue-release-not-found");
  }
  return row;
}

async function verifyInstalledSourceFiles(
  database: DatabaseHandle,
  paths: AppPaths,
): Promise<{ verified: boolean; documents: number }> {
  const sources = await listSourceDocuments(database);
  await Promise.all(
    sources.map(async (source) => {
      const verified = await openVerifiedFile(
        resolveRepositoryFile(paths.repositoryRoot, source.local_path),
        source.sha256,
      );
      await verified.handle.close();
    }),
  );
  return { verified: true, documents: sources.length };
}

function sourceDocumentForApi(source: SourceDocumentRow) {
  const { local_path: _localPath, ...safe } = source;
  return {
    ...safe,
    downloadUrl: `/api/source-documents/${source.id}/download`,
  };
}

function resolveRepositoryFile(
  repositoryRoot: string,
  storedPath: string,
): string {
  const root = path.resolve(repositoryRoot);
  const sourcePath = path.resolve(root, storedPath);
  const relative = path.relative(root, sourcePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("source-document-not-found");
  }
  return sourcePath;
}

function statusForCode(code: string): number {
  if (
    code === "archive-size-not-allowed" ||
    code === "archive-expansion-limit-exceeded" ||
    code === "archive-evidence-file-too-large"
  ) {
    return 413;
  }
  if (
    code === "invalid-credentials" ||
    code === "authentication-required" ||
    code === "session-invalid"
  ) {
    return 401;
  }
  if (
    code === "permission-denied" ||
    code === "origin-not-allowed" ||
    code === "csrf-token-invalid"
  ) {
    return 403;
  }
  if (
    code.endsWith("-not-found") ||
    code === "node-not-found" ||
    code === "user-not-found"
  ) {
    return 404;
  }
  if (
    code.endsWith("-conflict") ||
    code.endsWith("-version-conflict") ||
    code.includes("changed while") ||
    code.includes("changed from version") ||
    code === "version-conflict" ||
    code === "import-has-row-errors" ||
    code === "import-cancelled" ||
    code === "import-already-committed" ||
    code.endsWith("-not-complete") ||
    code.endsWith("-protected") ||
    code === "node-has-children" ||
    code === "node-has-dependent-data" ||
    code === "last-active-admin-required" ||
    code === "project-archived-read-only" ||
    code === "project-historical-read-only" ||
    code === "project-submitted-read-only" ||
    code === "project-catalogue-release-in-use" ||
    code === "submitted-project-reopen-required" ||
    code === "submitted-project-reopen-only" ||
    code === "submission-preparation-in-progress" ||
    code === "project-submission-workflows-in-progress" ||
    code === "submission-preparation-not-generating" ||
    code === "artifact-generation-in-progress" ||
    code === "cair-evidence-already-attached" ||
    code === "cair-evidence-byte-size-unavailable" ||
    code === "cair-evidence-byte-size-mismatch" ||
    code === "cost-amendment-part-not-in-base-report" ||
    code === "cost-amendment-preview-snapshot-changed" ||
    code === "submission-cost-amendment-not-locked" ||
    code === "report-render-lease-lost" ||
    code === "artifact-reservation-lost" ||
    code.endsWith("-not-editable")
    || code === "project-season-already-exists"
    || code === "historical-import-source-changed"
    || code === "copy-preview-stale"
    || code === "copy-preview-has-conflicts"
    || code === "archive-source-changed"
    || code === "archive-preview-stale"
    || code === "archive-preview-has-conflicts"
    || code === "archive-idempotency-conflict"
  ) {
    return 409;
  }
  if (
    code.endsWith("-not-competition-ready") ||
    code.endsWith("-has-blockers")
  ) {
    return 422;
  }
  if (
    code === "historical-cost-selection-invalid" ||
    code === "catalogue-kind-mismatch" ||
    code === "node-move-cycle" ||
    code === "node-move-no-change" ||
    code === "catalogue-cost-unavailable" ||
    code === "catalogue-formula-invalid" ||
    code === "catalogue-formula-evaluation-failed" ||
    code.endsWith("-identity-mismatch") ||
    code.includes("required") ||
    code.startsWith("invalid-") ||
    code.startsWith("unsupported-") ||
    code.endsWith("-unsupported") ||
    code.endsWith("-not-allowed") ||
    code.endsWith("-missing")
    || code.startsWith("archive-")
    || code === "copy-source-kind-not-supported"
    || code === "historical-import-requires-legacy-master"
    || code === "historical-season-must-precede-current"
  ) {
    return 400;
  }
  if (code === "evidence-thumbnail-busy") return 503;
  return 500;
}

function normalizeErrorCode(code: string): string {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)
    ? code
    : "invalid-request";
}

function humanizeCode(code: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) {
    return code;
  }
  return code
    .replaceAll("submitted-project", "submitted-workspace")
    .replaceAll("project-", "workspace-")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function postgresErrorCode(error: unknown): string | null {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string"
  ) {
    return (error as Error & { code: string }).code;
  }
  return null;
}
