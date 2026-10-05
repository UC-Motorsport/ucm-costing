import { Router, type RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";

import {
  createUser,
  listUsers,
  loginWithAccessKey,
  revokeAllUserSessions,
  revokeSession,
  updateUserAccess,
  type AuthDatabase,
} from "../security/auth-service";
import {
  actorContextFromRequest,
  auditContextFromRequest,
  clearSessionCookie,
  createCsrfToken,
  requireSystemRole,
  setSessionCookie,
} from "../security/http-security";

export interface AuthRouteOptions {
  database: AuthDatabase;
  secureSessionCookies: boolean;
  csrfSecret: string;
  sharedAccessKey: string;
  viewerAccessKey: string;
  adminAccessKey: string;
}

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  key: z.string().min(1).max(1_024),
});

const createUserSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  role: z.enum(["admin", "editor", "viewer"]),
});

const updateUserSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    displayName: z.string().trim().min(2).max(100).optional(),
    role: z.enum(["admin", "editor", "viewer"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    ({ expectedVersion: _expectedVersion, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    "At least one user field must change",
  );

export function createPublicAuthRouter(
  options: AuthRouteOptions,
): Router {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (request) => {
      const rawEmail =
        typeof request.body === "object" &&
        request.body !== null &&
        "email" in request.body &&
        typeof request.body.email === "string"
          ? request.body.email
          : "";
      const normalizedEmail = rawEmail.trim().toLowerCase() || "unknown";
      return `${ipKeyGenerator(request.ip ?? "unknown")}:${normalizedEmail}`;
    },
    message: {
      error: {
        code: "login-rate-limited",
        message: "Too many failed sign-in attempts; try again later",
      },
    },
  });
  router.post(
    "/login",
    loginLimiter,
    asyncRoute(async (request, response) => {
      const input = loginSchema.parse(request.body);
      const result = await loginWithAccessKey(
        options.database,
        auditContextFromRequest(request),
        {
          ...input,
          sharedAccessKey: options.sharedAccessKey,
          viewerAccessKey: options.viewerAccessKey,
          adminAccessKey: options.adminAccessKey,
        },
      );
      setSessionCookie(
        response,
        options.secureSessionCookies,
        result.token,
        result.session.expiresAt,
      );
      response.json({
        user: userForApi(result.session.user),
        expiresAt: result.session.expiresAt,
        csrfToken: createCsrfToken(
          options.csrfSecret,
          result.session.sessionId,
        ),
        capabilities: capabilitiesForRole(result.session.user.role),
      });
    }),
  );
  return router;
}

export function createAuthenticatedAuthRouter(
  options: AuthRouteOptions,
): Router {
  const router = Router();
  router.get("/me", (request, response) => {
    const session = request.auth;
    if (!session) {
      response.status(401).json({
        error: { code: "authentication-required", message: "Sign in required" },
      });
      return;
    }
    response.json({
      user: userForApi(session.user),
      expiresAt: session.expiresAt,
      csrfToken: createCsrfToken(options.csrfSecret, session.sessionId),
      capabilities: capabilitiesForRole(session.user.role),
    });
  });
  router.post(
    "/logout",
    asyncRoute(async (request, response) => {
      const session = request.auth;
      if (session) {
        await revokeSession(
          options.database,
          actorContextFromRequest(request),
          session.sessionId,
        );
      }
      clearSessionCookie(response, options.secureSessionCookies);
      response.status(204).end();
    }),
  );
  return router;
}

export function createUserAdminRouter(options: AuthRouteOptions): Router {
  const router = Router();
  router.use(requireSystemRole("admin"));
  router.get(
    "/",
    asyncRoute(async (_request, response) => {
      response.json({
        users: (await listUsers(options.database)).map(userForApi),
      });
    }),
  );
  router.post(
    "/",
    asyncRoute(async (request, response) => {
      const input = createUserSchema.parse(request.body);
      const user = await createUser(
        options.database,
        actorContextFromRequest(request),
        input,
      );
      response.status(201).json({
        user: userForApi(user),
      });
    }),
  );
  router.patch(
    "/:userId",
    asyncRoute(async (request, response) => {
      const input = updateUserSchema.parse(request.body);
      const user = await updateUserAccess(
        options.database,
        actorContextFromRequest(request),
        routeParam(request.params.userId),
        input,
      );
      response.json({ user: userForApi(user) });
    }),
  );
  router.post(
    "/:userId/revoke-sessions",
    asyncRoute(async (request, response) => {
      const revokedSessions = await revokeAllUserSessions(
        options.database,
        actorContextFromRequest(request),
        routeParam(request.params.userId),
      );
      response.json({ revokedSessions });
    }),
  );
  return router;
}

function userForApi(user: {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "editor" | "viewer";
  status: "invited" | "active" | "disabled";
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    version: user.version,
  };
}

function capabilitiesForRole(role: "admin" | "editor" | "viewer") {
  return {
    canManageUsers: role === "admin",
    canManageImports: role === "admin",
    canManageSources: role === "admin",
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("route-parameter-required");
  }
  return value;
}

function asyncRoute(
  handler: Parameters<typeof wrapAsync>[0],
): RequestHandler {
  return wrapAsync(handler);
}

function wrapAsync(
  handler: (
    request: Parameters<RequestHandler>[0],
    response: Parameters<RequestHandler>[1],
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}
