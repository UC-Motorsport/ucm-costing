import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);

export interface AppPaths {
  repositoryRoot: string;
  dataRoot: string;
  uploadRoot: string;
  reportRoot: string;
  outputPdfRoot: string;
  webDistRoot: string;
}

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statementTimeoutMillis: number;
  lockTimeoutMillis: number;
  idleInTransactionSessionTimeoutMillis: number;
  ssl: false | { rejectUnauthorized: boolean };
}

export interface HttpSecurityConfig {
  csrfSecret: string;
  auditIpSalt: string;
  sharedAccessKey: string;
  viewerAccessKey: string;
  adminAccessKey: string;
  allowWeakAccessKeys: boolean;
  secureSessionCookies: boolean;
  allowedOrigins: readonly string[];
  allowMissingOrigin: boolean;
  /**
   * Exact number of reverse-proxy hops between the browser and Express.
   * Production requires an explicit value so client IP audit/rate-limit keys
   * cannot silently collapse to the proxy address.
   */
  trustedProxyHops: number;
}

export function getAppPaths(): AppPaths {
  const dataRoot = path.resolve(
    process.env.UCM_DATA_ROOT ?? path.join(repositoryRoot, "data"),
  );
  const outputRoot = path.resolve(
    process.env.UCM_OUTPUT_ROOT ?? path.join(repositoryRoot, "output"),
  );

  return {
    repositoryRoot,
    dataRoot,
    uploadRoot: path.join(dataRoot, "uploads"),
    reportRoot: path.join(dataRoot, "reports"),
    outputPdfRoot: path.join(outputRoot, "pdf"),
    webDistRoot: path.join(repositoryRoot, "apps", "web", "dist"),
  };
}

export function getDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  const sslMode = environment.UCM_DATABASE_SSL?.trim().toLowerCase() ?? "disable";
  if (!["disable", "require", "verify-full"].includes(sslMode)) {
    throw new Error(
      "UCM_DATABASE_SSL must be disable, require, or verify-full",
    );
  }

  return {
    connectionString,
    maxConnections: boundedInteger(
      environment.UCM_DB_POOL_MAX,
      10,
      1,
      50,
      "UCM_DB_POOL_MAX",
    ),
    connectionTimeoutMillis: boundedInteger(
      environment.UCM_DB_CONNECT_TIMEOUT_MS,
      5_000,
      250,
      60_000,
      "UCM_DB_CONNECT_TIMEOUT_MS",
    ),
    idleTimeoutMillis: boundedInteger(
      environment.UCM_DB_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      600_000,
      "UCM_DB_IDLE_TIMEOUT_MS",
    ),
    statementTimeoutMillis: boundedInteger(
      environment.UCM_DB_STATEMENT_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
      "UCM_DB_STATEMENT_TIMEOUT_MS",
    ),
    lockTimeoutMillis: boundedInteger(
      environment.UCM_DB_LOCK_TIMEOUT_MS,
      5_000,
      250,
      60_000,
      "UCM_DB_LOCK_TIMEOUT_MS",
    ),
    idleInTransactionSessionTimeoutMillis: boundedInteger(
      environment.UCM_DB_IDLE_TX_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
      "UCM_DB_IDLE_TX_TIMEOUT_MS",
    ),
    ssl:
      sslMode === "disable"
        ? false
        : { rejectUnauthorized: sslMode === "verify-full" },
  };
}

export function getHttpSecurityConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HttpSecurityConfig {
  const production = environment.NODE_ENV === "production";
  const allowInsecureHttp = optionalBoolean(
    environment.UCM_ALLOW_INSECURE_HTTP,
    false,
    "UCM_ALLOW_INSECURE_HTTP",
  );
  const allowWeakAccessKeys = optionalBoolean(
    environment.UCM_ALLOW_WEAK_ACCESS_KEYS,
    false,
    "UCM_ALLOW_WEAK_ACCESS_KEYS",
  );
  if (!production && allowInsecureHttp) {
    throw new Error(
      "UCM_ALLOW_INSECURE_HTTP may be enabled only in production",
    );
  }
  if (!production && allowWeakAccessKeys) {
    throw new Error(
      "UCM_ALLOW_WEAK_ACCESS_KEYS may be enabled only in production",
    );
  }
  const csrfSecret = requiredSecuritySecret(
    environment.UCM_CSRF_SECRET,
    "UCM_CSRF_SECRET",
    production,
    "ucm-development-csrf-secret-do-not-use-outside-local-dev",
  );
  const auditIpSalt = requiredSecuritySecret(
    environment.UCM_AUDIT_IP_SALT,
    "UCM_AUDIT_IP_SALT",
    production,
    "ucm-development-audit-ip-salt-do-not-use-outside-local-dev",
  );
  const sharedAccessKey = requiredAccessKey(
    environment.UCM_SHARED_ACCESS_KEY,
    "UCM_SHARED_ACCESS_KEY",
    production,
    allowWeakAccessKeys,
    "test",
  );
  const adminAccessKey = requiredAccessKey(
    environment.UCM_ADMIN_ACCESS_KEY,
    "UCM_ADMIN_ACCESS_KEY",
    production,
    allowWeakAccessKeys,
    "admin-test",
  );
  const viewerAccessKey = requiredAccessKey(
    environment.UCM_VIEWER_ACCESS_KEY,
    "UCM_VIEWER_ACCESS_KEY",
    production,
    allowWeakAccessKeys,
    "viewer-test",
  );
  if (
    new Set([sharedAccessKey, viewerAccessKey, adminAccessKey]).size !== 3
  ) {
    throw new Error(
      "UCM_SHARED_ACCESS_KEY, UCM_VIEWER_ACCESS_KEY, and UCM_ADMIN_ACCESS_KEY must differ",
    );
  }
  if (
    allowWeakAccessKeys &&
    Buffer.byteLength(sharedAccessKey, "utf8") >= 32 &&
    Buffer.byteLength(viewerAccessKey, "utf8") >= 32 &&
    Buffer.byteLength(adminAccessKey, "utf8") >= 32
  ) {
    throw new Error(
      "UCM_ALLOW_WEAK_ACCESS_KEYS must be false when all access keys contain at least 32 bytes",
    );
  }
  const rawOrigins = environment.UCM_ALLOWED_ORIGINS?.trim();
  if (production && !rawOrigins) {
    throw new Error("UCM_ALLOWED_ORIGINS is required in production");
  }
  const allowedOrigins = rawOrigins
    ? rawOrigins.split(",").map((origin) => canonicalOrigin(origin.trim()))
    : ["http://localhost:5173", "http://localhost:8080"];
  if (
    allowedOrigins.length === 0 ||
    new Set(allowedOrigins).size !== allowedOrigins.length
  ) {
    throw new Error("UCM_ALLOWED_ORIGINS must contain unique origins");
  }
  if (
    production &&
    !allowInsecureHttp &&
    allowedOrigins.some((origin) => !origin.startsWith("https://"))
  ) {
    throw new Error(
      "Production UCM_ALLOWED_ORIGINS must use HTTPS unless UCM_ALLOW_INSECURE_HTTP=true",
    );
  }
  if (
    production &&
    allowInsecureHttp &&
    (allowedOrigins.length !== 1 ||
      !isTailscaleIpv4HttpOrigin(allowedOrigins[0]!))
  ) {
    throw new Error(
      "UCM_ALLOW_INSECURE_HTTP requires exactly one Tailscale IPv4 HTTP origin with an explicit port",
    );
  }
  if (
    production &&
    allowInsecureHttp &&
    environment.UCM_BIND_ADDRESS?.trim() !==
      new URL(allowedOrigins[0]!).hostname
  ) {
    throw new Error(
      "UCM_BIND_ADDRESS must exactly match the Tailscale IPv4 origin when UCM_ALLOW_INSECURE_HTTP=true",
    );
  }
  if (production && !environment.UCM_TRUST_PROXY_HOPS?.trim()) {
    throw new Error("UCM_TRUST_PROXY_HOPS is required in production");
  }
  const trustedProxyHops = boundedInteger(
    environment.UCM_TRUST_PROXY_HOPS,
    0,
    production && !allowInsecureHttp ? 1 : 0,
    5,
    "UCM_TRUST_PROXY_HOPS",
  );
  if (allowInsecureHttp && trustedProxyHops !== 0) {
    throw new Error(
      "UCM_TRUST_PROXY_HOPS must be 0 when UCM_ALLOW_INSECURE_HTTP=true",
    );
  }

  return {
    csrfSecret,
    auditIpSalt,
    sharedAccessKey,
    viewerAccessKey,
    adminAccessKey,
    allowWeakAccessKeys,
    secureSessionCookies: production && !allowInsecureHttp,
    allowedOrigins: Object.freeze(allowedOrigins),
    allowMissingOrigin: !production,
    trustedProxyHops,
  };
}

function requiredAccessKey(
  rawValue: string | undefined,
  name:
    | "UCM_SHARED_ACCESS_KEY"
    | "UCM_VIEWER_ACCESS_KEY"
    | "UCM_ADMIN_ACCESS_KEY",
  production: boolean,
  allowWeakAccessKeys: boolean,
  developmentFallback: string,
): string {
  const value = rawValue ?? (production ? "" : developmentFallback);
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < 1) {
    throw new Error(`${name} must not be empty`);
  }
  if (production && !allowWeakAccessKeys && byteLength < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  if (production && allowWeakAccessKeys && byteLength < 6) {
    throw new Error(
      `${name} must contain at least 6 bytes when UCM_ALLOW_WEAK_ACCESS_KEYS=true`,
    );
  }
  if (byteLength > 1_024) {
    throw new Error(`${name} must contain at most 1024 bytes`);
  }
  return value;
}

export const SERVER_PORT = Number(process.env.PORT ?? 8080);
export const LOCAL_ADDENDUM_V12_VERSION =
  "FSAE-A 2026 Local Addendum v1.2";
export const LOCAL_ADDENDUM_V12_SHA256 =
  "4eee1b95f3c9b11d4a4b93bdcdedfd3273d9ae55278d1bd35afa238102c1b8d9";
export const LOCAL_ADDENDUM_VERSION = "FSAE-A 2026 Local Addendum v1.4";
export const LOCAL_ADDENDUM_SHA256 =
  "1cfd33c17bcf8c7621283b3592633f816c29b0fa60bfc8eab9c1b5eaa9fc6688";
export const CATALOGUE_REVISION = "26_R1";
export const CATALOGUE_SHA256 =
  "392e6a0b4729df6fe43e57af9846859758195f5a80ba926c1a3756824892e070";

export function toStoredDataPath(
  absolutePath: string,
  paths: AppPaths = getAppPaths(),
): string {
  const relative = path.relative(paths.dataRoot, absolutePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("stored-path-outside-data-root");
  }
  return relative.split(path.sep).join("/");
}

export function resolveStoredDataPath(
  storedPath: string,
  paths: AppPaths = getAppPaths(),
): string {
  let portablePath = storedPath;
  if (path.isAbsolute(portablePath)) {
    const normalized = portablePath.split(path.sep).join("/");
    const marker = ["/uploads/", "/reports/"].find((candidate) =>
      normalized.includes(candidate),
    );
    if (!marker) {
      throw new Error("stored-path-outside-data-root");
    }
    portablePath = normalized.slice(
      normalized.indexOf(marker) + 1,
    );
  }

  const resolved = path.resolve(paths.dataRoot, portablePath);
  const relative = path.relative(paths.dataRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("stored-path-outside-data-root");
  }
  return resolved;
}

function boundedInteger(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalBoolean(
  rawValue: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function requiredSecuritySecret(
  rawValue: string | undefined,
  name: string,
  production: boolean,
  developmentFallback: string,
): string {
  const value = rawValue ?? (production ? "" : developmentFallback);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

function canonicalOrigin(rawOrigin: string): string {
  if (!rawOrigin || rawOrigin.includes("*")) {
    throw new Error(
      "UCM_ALLOWED_ORIGINS must not contain blank or wildcard origins",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error(
      `UCM_ALLOWED_ORIGINS contains an invalid origin: ${rawOrigin}`,
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    rawOrigin !== parsed.origin
  ) {
    throw new Error(
      `UCM_ALLOWED_ORIGINS must contain canonical HTTP(S) origins: ${rawOrigin}`,
    );
  }
  return parsed.origin;
}

function isTailscaleIpv4HttpOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.port === "") {
    return false;
  }
  const octets = parsed.hostname.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) =>
        !/^(0|[1-9]\d{0,2})$/.test(octet) ||
        Number(octet) < 0 ||
        Number(octet) > 255,
    )
  ) {
    return false;
  }
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return first === 100 && second >= 64 && second <= 127;
}
