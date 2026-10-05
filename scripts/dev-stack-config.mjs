import path from "node:path";

export const developmentCredentials = Object.freeze({
  databaseName: "ucm",
  watchDatabaseName: "ucm_watch",
  databaseUser: "ucm_app",
  databasePassword: "ucm-development-app-password",
  migratorUser: "ucm_migrator",
  migratorPassword: "ucm-development-migrator-password",
  adminEmail: "test@localhost.invalid",
  adminKey: "admin-test",
  sharedKey: "test",
  viewerKey: "viewer-test",
});

export function parsePort(rawValue, variableName) {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${variableName} must be an integer from 1 to 65535`);
  }
  return parsed;
}

export function developmentStackSettings(environment = process.env) {
  const httpPort = parsePort(
    environment.UCM_DEV_HTTP_PORT ?? "8080",
    "UCM_DEV_HTTP_PORT",
  );
  const webPort = parsePort(
    environment.UCM_DEV_WEB_PORT ?? "5173",
    "UCM_DEV_WEB_PORT",
  );
  const databasePort = parsePort(
    environment.UCM_DEV_DB_PORT ?? "54329",
    "UCM_DEV_DB_PORT",
  );
  const apiUrl = `http://127.0.0.1:${httpPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const databaseUrl =
    `postgresql://${developmentCredentials.databaseUser}:` +
    `${developmentCredentials.databasePassword}@127.0.0.1:` +
    `${databasePort}/${developmentCredentials.databaseName}`;
  const watchDatabaseUrl =
    `postgresql://${developmentCredentials.databaseUser}:` +
    `${developmentCredentials.databasePassword}@127.0.0.1:` +
    `${databasePort}/${developmentCredentials.watchDatabaseName}`;

  return {
    httpPort,
    webPort,
    databasePort,
    apiUrl,
    webUrl,
    databaseUrl,
    watchDatabaseUrl,
  };
}

export function createWatchEnvironment(
  environment,
  repositoryRoot,
) {
  const settings = developmentStackSettings(environment);
  const watchRoot = path.join(repositoryRoot, "tmp", "dev-watch");

  return {
    NODE_ENV: "development",
    PORT: String(settings.httpPort),
    DATABASE_URL: settings.watchDatabaseUrl,
    UCM_DATABASE_SSL: "disable",
    UCM_DB_POOL_MAX: "10",
    UCM_ENABLE_DEVELOPMENT_ACCOUNT: "true",
    UCM_SHARED_ACCESS_KEY: developmentCredentials.sharedKey,
    UCM_VIEWER_ACCESS_KEY: developmentCredentials.viewerKey,
    UCM_ADMIN_ACCESS_KEY: developmentCredentials.adminKey,
    UCM_ALLOWED_ORIGINS: [
      `http://localhost:${settings.webPort}`,
      settings.webUrl,
      `http://localhost:${settings.httpPort}`,
      settings.apiUrl,
    ].join(","),
    UCM_TRUST_PROXY_HOPS: "0",
    UCM_DATA_ROOT: path.join(watchRoot, "data"),
    UCM_OUTPUT_ROOT: path.join(watchRoot, "output"),
    UCM_BACKUP_ROOT: path.join(watchRoot, "backups"),
    VITE_API_TARGET: settings.apiUrl,
    VITE_DEV_HOST: "127.0.0.1",
    VITE_DEV_PORT: String(settings.webPort),
    VITE_DEVELOPMENT_ACCOUNT: "true",
  };
}
