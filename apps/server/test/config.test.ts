import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getAppPaths,
  getDatabaseConfig,
  getHttpSecurityConfig,
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../src/config";

describe("portable managed paths", () => {
  const paths: AppPaths = {
    ...getAppPaths(),
    dataRoot: "/srv/ucm/data",
    uploadRoot: "/srv/ucm/data/uploads",
    reportRoot: "/srv/ucm/data/reports",
  };

  it("stores relative paths and resolves them under the current data root", () => {
    expect(
      toStoredDataPath("/srv/ucm/data/uploads/project/evidence.pdf", paths),
    ).toBe("uploads/project/evidence.pdf");
    expect(
      resolveStoredDataPath("reports/snapshot.pdf", paths),
    ).toBe(path.resolve("/srv/ucm/data/reports/snapshot.pdf"));
  });

  it("maps legacy absolute managed paths after a restore to a new root", () => {
    expect(
      resolveStoredDataPath(
        "/Users/team/old-deploy/data/uploads/project/evidence.pdf",
        paths,
      ),
    ).toBe("/srv/ucm/data/uploads/project/evidence.pdf");
  });

  it("rejects traversal and absolute paths outside managed directories", () => {
    expect(() =>
      resolveStoredDataPath("../../etc/passwd", paths),
    ).toThrow("stored-path-outside-data-root");
    expect(() =>
      resolveStoredDataPath("/etc/passwd", paths),
    ).toThrow("stored-path-outside-data-root");
    expect(() =>
      toStoredDataPath("/srv/ucm/other/file", paths),
    ).toThrow("stored-path-outside-data-root");
  });
});

describe("PostgreSQL configuration", () => {
  it("requires a PostgreSQL URL and applies bounded pool defaults", () => {
    expect(() => getDatabaseConfig({})).toThrow("DATABASE_URL is required");
    expect(() =>
      getDatabaseConfig({ DATABASE_URL: "sqlite:///tmp/ucm.sqlite" }),
    ).toThrow("must use postgres:// or postgresql://");

    expect(
      getDatabaseConfig({
        DATABASE_URL: "postgresql://ucm_app:secret@postgres:5432/ucm",
      }),
    ).toMatchObject({
      maxConnections: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statementTimeoutMillis: 30_000,
      lockTimeoutMillis: 5_000,
      idleInTransactionSessionTimeoutMillis: 30_000,
      ssl: false,
    });
  });

  it("rejects unsafe bounds and supports explicit TLS verification", () => {
    const base = {
      DATABASE_URL: "postgresql://ucm_app:secret@db.example.test/ucm",
    };
    expect(() =>
      getDatabaseConfig({ ...base, UCM_DB_POOL_MAX: "0" }),
    ).toThrow("UCM_DB_POOL_MAX");
    expect(() =>
      getDatabaseConfig({ ...base, UCM_DB_STATEMENT_TIMEOUT_MS: "NaN" }),
    ).toThrow("UCM_DB_STATEMENT_TIMEOUT_MS");
    expect(
      getDatabaseConfig({
        ...base,
        UCM_DATABASE_SSL: "verify-full",
        UCM_DB_POOL_MAX: "7",
      }),
    ).toMatchObject({
      maxConnections: 7,
      ssl: { rejectUnauthorized: true },
    });
  });
});

describe("HTTP security configuration", () => {
  it("uses deterministic local-only defaults outside production", () => {
    expect(getHttpSecurityConfig({ NODE_ENV: "development" })).toMatchObject({
      sharedAccessKey: "test",
      viewerAccessKey: "viewer-test",
      adminAccessKey: "admin-test",
      allowWeakAccessKeys: false,
      secureSessionCookies: false,
      allowedOrigins: [
        "http://localhost:5173",
        "http://localhost:8080",
      ],
      allowMissingOrigin: true,
      trustedProxyHops: 0,
    });
  });

  it("requires long secrets and canonical explicit origins in production", () => {
    const valid = {
      NODE_ENV: "production",
      UCM_CSRF_SECRET: "c".repeat(32),
      UCM_AUDIT_IP_SALT: "a".repeat(32),
      UCM_SHARED_ACCESS_KEY: "m".repeat(32),
      UCM_VIEWER_ACCESS_KEY: "v".repeat(32),
      UCM_ADMIN_ACCESS_KEY: "k".repeat(32),
      UCM_ALLOWED_ORIGINS:
        "https://costing.example.org,https://admin.example.org",
      UCM_TRUST_PROXY_HOPS: "1",
    };
    expect(getHttpSecurityConfig(valid)).toEqual({
      csrfSecret: "c".repeat(32),
      auditIpSalt: "a".repeat(32),
      sharedAccessKey: "m".repeat(32),
      viewerAccessKey: "v".repeat(32),
      adminAccessKey: "k".repeat(32),
      allowWeakAccessKeys: false,
      secureSessionCookies: true,
      allowedOrigins: [
        "https://costing.example.org",
        "https://admin.example.org",
      ],
      allowMissingOrigin: false,
      trustedProxyHops: 1,
    });
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_CSRF_SECRET: "too-short",
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_SHARED_ACCESS_KEY: undefined,
      }),
    ).toThrow("UCM_SHARED_ACCESS_KEY");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_SHARED_ACCESS_KEY: "too-short",
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_SHARED_ACCESS_KEY: "k".repeat(1_025),
      }),
    ).toThrow("at most 1024 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: undefined,
      }),
    ).toThrow("UCM_ADMIN_ACCESS_KEY");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: "too-short",
      }),
    ).toThrow("UCM_ADMIN_ACCESS_KEY must contain at least 32 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: "k".repeat(1_025),
      }),
    ).toThrow("UCM_ADMIN_ACCESS_KEY must contain at most 1024 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_VIEWER_ACCESS_KEY: undefined,
      }),
    ).toThrow("UCM_VIEWER_ACCESS_KEY");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: valid.UCM_SHARED_ACCESS_KEY,
      }),
    ).toThrow("must differ");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ALLOW_WEAK_ACCESS_KEYS: "1",
      }),
    ).toThrow("UCM_ALLOW_WEAK_ACCESS_KEYS must be true or false");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ALLOW_WEAK_ACCESS_KEYS: "true",
      }),
    ).toThrow(
      "UCM_ALLOW_WEAK_ACCESS_KEYS must be false when all access keys contain at least 32 bytes",
    );
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ALLOWED_ORIGINS: "*",
      }),
    ).toThrow("wildcard");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ALLOWED_ORIGINS: "https://costing.example.org/",
      }),
    ).toThrow("canonical");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ALLOWED_ORIGINS: "https://costing.example.org/path",
      }),
    ).toThrow("canonical");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_TRUST_PROXY_HOPS: undefined,
      }),
    ).toThrow("UCM_TRUST_PROXY_HOPS is required");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_TRUST_PROXY_HOPS: "0",
      }),
    ).toThrow("from 1 to 5");
  });

  it("allows exact short production keys only behind the explicit override", () => {
    const valid = {
      NODE_ENV: "production",
      UCM_CSRF_SECRET: "c".repeat(32),
      UCM_AUDIT_IP_SALT: "a".repeat(32),
      UCM_SHARED_ACCESS_KEY: "member",
      UCM_VIEWER_ACCESS_KEY: "viewer",
      UCM_ADMIN_ACCESS_KEY: "admin-key",
      UCM_ALLOW_WEAK_ACCESS_KEYS: "true",
      UCM_ALLOWED_ORIGINS: "https://costing.example.org",
      UCM_TRUST_PROXY_HOPS: "1",
    };

    expect(getHttpSecurityConfig(valid)).toMatchObject({
      sharedAccessKey: "member",
      viewerAccessKey: "viewer",
      adminAccessKey: "admin-key",
      allowWeakAccessKeys: true,
    });
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_SHARED_ACCESS_KEY: "",
      }),
    ).toThrow("UCM_SHARED_ACCESS_KEY must not be empty");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_SHARED_ACCESS_KEY: "short",
      }),
    ).toThrow("UCM_SHARED_ACCESS_KEY must contain at least 6 bytes");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: "",
      }),
    ).toThrow("UCM_ADMIN_ACCESS_KEY must not be empty");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        UCM_ADMIN_ACCESS_KEY: valid.UCM_SHARED_ACCESS_KEY,
      }),
    ).toThrow("must differ");
    expect(() =>
      getHttpSecurityConfig({
        ...valid,
        NODE_ENV: "development",
      }),
    ).toThrow(
      "UCM_ALLOW_WEAK_ACCESS_KEYS may be enabled only in production",
    );
  });

  it("allows insecure production cookies only for one exact tailnet HTTP origin", () => {
    const valid = {
      NODE_ENV: "production",
      UCM_CSRF_SECRET: "c".repeat(32),
      UCM_AUDIT_IP_SALT: "a".repeat(32),
      UCM_SHARED_ACCESS_KEY: "m".repeat(32),
      UCM_VIEWER_ACCESS_KEY: "v".repeat(32),
      UCM_ADMIN_ACCESS_KEY: "k".repeat(32),
      UCM_ALLOWED_ORIGINS: "http://100.64.0.10:8080",
      UCM_BIND_ADDRESS: "100.64.0.10",
      UCM_TRUST_PROXY_HOPS: "0",
      UCM_ALLOW_INSECURE_HTTP: "true",
    };

    expect(getHttpSecurityConfig(valid)).toMatchObject({
      allowedOrigins: ["http://100.64.0.10:8080"],
      allowMissingOrigin: false,
      trustedProxyHops: 0,
      secureSessionCookies: false,
    });

    for (const invalid of [
      {
        ...valid,
        UCM_ALLOW_INSECURE_HTTP: "1",
      },
      {
        ...valid,
        UCM_ALLOWED_ORIGINS:
          "http://100.64.0.10:8080,http://100.64.0.11:8080",
      },
      {
        ...valid,
        UCM_ALLOWED_ORIGINS: "https://100.64.0.10:8080",
      },
      {
        ...valid,
        UCM_ALLOWED_ORIGINS: "http://100.64.0.10",
      },
      {
        ...valid,
        UCM_ALLOWED_ORIGINS: "http://100.63.255.255:8080",
      },
      {
        ...valid,
        UCM_ALLOWED_ORIGINS: "http://192.168.1.10:8080",
      },
      {
        ...valid,
        UCM_TRUST_PROXY_HOPS: "1",
      },
      {
        ...valid,
        UCM_BIND_ADDRESS: "100.64.0.11",
      },
      {
        ...valid,
        UCM_BIND_ADDRESS: "0.0.0.0",
      },
    ]) {
      expect(() => getHttpSecurityConfig(invalid)).toThrow();
    }
  });
});
