import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createWatchEnvironment,
  developmentStackSettings,
  parsePort,
} from "./dev-stack-config.mjs";

test("parsePort accepts valid TCP ports", () => {
  assert.equal(parsePort("1", "TEST_PORT"), 1);
  assert.equal(parsePort("54329", "TEST_PORT"), 54_329);
  assert.equal(parsePort("65535", "TEST_PORT"), 65_535);
});

test("parsePort rejects invalid TCP ports with the variable name", () => {
  for (const value of ["0", "65536", "1.5", "not-a-port", ""]) {
    assert.throws(
      () => parsePort(value, "TEST_PORT"),
      /TEST_PORT must be an integer from 1 to 65535/,
    );
  }
});

test("developmentStackSettings uses isolated loopback defaults", () => {
  assert.deepEqual(developmentStackSettings({}), {
    httpPort: 8080,
    webPort: 5173,
    databasePort: 54_329,
    apiUrl: "http://127.0.0.1:8080",
    webUrl: "http://127.0.0.1:5173",
    databaseUrl:
      "postgresql://ucm_app:ucm-development-app-password@127.0.0.1:54329/ucm",
    watchDatabaseUrl:
      "postgresql://ucm_app:ucm-development-app-password@127.0.0.1:54329/ucm_watch",
  });
});

test("createWatchEnvironment keeps mutable state under ignored tmp", () => {
  const repositoryRoot = "/workspace/ucm";
  const environment = createWatchEnvironment(
    {
      UCM_DEV_HTTP_PORT: "9080",
      UCM_DEV_WEB_PORT: "6173",
      UCM_DEV_DB_PORT: "64329",
    },
    repositoryRoot,
  );

  assert.equal(environment.PORT, "9080");
  assert.equal(environment.VITE_API_TARGET, "http://127.0.0.1:9080");
  assert.equal(environment.VITE_DEV_PORT, "6173");
  assert.equal(
    environment.DATABASE_URL,
    "postgresql://ucm_app:ucm-development-app-password@127.0.0.1:64329/ucm_watch",
  );
  assert.equal(
    environment.UCM_DATA_ROOT,
    path.join(repositoryRoot, "tmp", "dev-watch", "data"),
  );
  assert.match(environment.UCM_ALLOWED_ORIGINS, /127\.0\.0\.1:6173/);
  assert.match(environment.UCM_ALLOWED_ORIGINS, /127\.0\.0\.1:9080/);
  assert.equal(environment.UCM_ENABLE_DEVELOPMENT_ACCOUNT, "true");
});
