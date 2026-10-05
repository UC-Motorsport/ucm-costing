import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import type { AuditContext } from "../audit/audit-ledger";
import type { ActorContext } from "./authorization";
import {
  authenticateSession,
  type AuthDatabase,
  type AuthenticatedSession,
  type RoleAccessKeys,
  type SystemRole,
} from "./auth-service";

declare global {
  namespace Express {
    interface Request {
      auth: AuthenticatedSession | null;
      auditIpAddressHash: string;
      requestId: string;
    }
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PRODUCTION_COOKIE = "__Host-ucm_session";
const DEVELOPMENT_COOKIE = "ucm_session";

export interface HttpSecurityOptions {
  production: boolean;
  allowedOrigins: readonly string[];
  csrfSecret: string;
  auditIpSalt: string;
  allowMissingOrigin?: boolean;
}

export function requestContextMiddleware(
  auditIpSalt: string,
): RequestHandler {
  requireSecret(auditIpSalt, "audit-ip-salt");
  return (request, response, next) => {
    request.requestId = randomUUID();
    request.auth = null;
    request.auditIpAddressHash = createHmac("sha256", auditIpSalt)
      .update(request.ip ?? "unknown", "utf8")
      .digest("hex");
    response.setHeader("x-request-id", request.requestId);
    next();
  };
}

export function originGuard(options: {
  allowedOrigins: readonly string[];
  allowMissingOrigin?: boolean;
}): RequestHandler {
  const allowed = new Set(
    options.allowedOrigins
      .map((origin) => normalizeOrigin(origin))
      .filter((origin) => origin.length > 0),
  );
  return (request, response, next) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    const rawOrigin = request.get("origin");
    if (!rawOrigin && options.allowMissingOrigin) {
      next();
      return;
    }
    if (!rawOrigin || !allowed.has(normalizeOrigin(rawOrigin))) {
      response.status(403).json({
        error: {
          code: "origin-not-allowed",
          message: "The request origin is not allowed",
        },
      });
      return;
    }
    next();
  };
}

export function authenticateRequest(
  database: AuthDatabase,
  secureSessionCookies: boolean,
  accessKeys: RoleAccessKeys,
): RequestHandler {
  return asyncHandler(async (request, response, next) => {
    const token = readCookie(
      request.get("cookie") ?? "",
      sessionCookieName(secureSessionCookies),
    );
    if (!token) {
      response.status(401).json({
        error: { code: "authentication-required", message: "Sign in required" },
      });
      return;
    }
    const session = await authenticateSession(
      database,
      token,
      accessKeys,
    );
    if (!session) {
      clearSessionCookie(response, secureSessionCookies);
      response.status(401).json({
        error: {
          code: "session-invalid",
          message: "Your session has expired or was revoked",
        },
      });
      return;
    }
    request.auth = session;
    next();
  });
}

export function requireSystemRole(
  ...allowedRoles: readonly SystemRole[]
): RequestHandler {
  const allowed = new Set(allowedRoles);
  return (request, response, next) => {
    const role = request.auth?.user.role;
    if (!role) {
      response.status(401).json({
        error: { code: "authentication-required", message: "Sign in required" },
      });
      return;
    }
    if (!allowed.has(role)) {
      response.status(403).json({
        error: {
          code: "permission-denied",
          message: "You do not have permission to perform this action",
        },
      });
      return;
    }
    next();
  };
}

export function csrfGuard(secret: string): RequestHandler {
  requireSecret(secret, "csrf-secret");
  return (request, response, next) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    const sessionId = request.auth?.sessionId;
    const supplied = request.get("x-csrf-token");
    if (
      !sessionId ||
      !supplied ||
      !safeStringEqual(supplied, createCsrfToken(secret, sessionId))
    ) {
      response.status(403).json({
        error: {
          code: "csrf-token-invalid",
          message: "Refresh the page and try again",
        },
      });
      return;
    }
    next();
  };
}

export function createCsrfToken(secret: string, sessionId: string): string {
  requireSecret(secret, "csrf-secret");
  return createHmac("sha256", secret)
    .update(`ucm-csrf:${sessionId}`, "utf8")
    .digest("base64url");
}

export function auditContextFromRequest(request: Request): AuditContext {
  if (!request.requestId) {
    throw new Error("request-id-missing");
  }
  return {
    actorUserId: request.auth?.user.id ?? null,
    requestId: request.requestId,
    ipAddressHash: request.auditIpAddressHash,
    userAgent: boundedHeader(request.get("user-agent")),
  };
}

export function actorContextFromRequest(request: Request): ActorContext {
  const user = request.auth?.user;
  if (!user) {
    throw new Error("authentication-required");
  }
  return {
    ...auditContextFromRequest(request),
    actorUserId: user.id,
    systemRole: user.role,
  };
}

export function setSessionCookie(
  response: Response,
  secureSessionCookies: boolean,
  token: string,
  expiresAt: Date | string,
): void {
  response.cookie(sessionCookieName(secureSessionCookies), token, {
    httpOnly: true,
    secure: secureSessionCookies,
    sameSite: "strict",
    path: "/",
    expires: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
  });
}

export function clearSessionCookie(
  response: Response,
  secureSessionCookies: boolean,
): void {
  response.clearCookie(sessionCookieName(secureSessionCookies), {
    httpOnly: true,
    secure: secureSessionCookies,
    sameSite: "strict",
    path: "/",
  });
}

export function sessionCookieName(secureSessionCookies: boolean): string {
  return secureSessionCookies ? PRODUCTION_COOKIE : DEVELOPMENT_COOKIE;
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function requireSecret(value: string, name: string): void {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name}-too-short`);
  }
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function boundedHeader(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, 500);
}

function asyncHandler(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}
