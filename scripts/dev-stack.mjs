import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import pg from "pg";

import {
  developmentCredentials,
  developmentStackSettings,
} from "./dev-stack-config.mjs";

const composePrefix = [
  "compose",
  "--project-name",
  "ucm-costing-dev",
  "--file",
  "docker-compose.dev.yml",
];
const action = process.argv[2] ?? "up";
const settings = developmentStackSettings(process.env);
const validActions = [
  "up",
  "infra",
  "test",
  "check",
  "doctor",
  "stop",
  "reset",
  "logs",
  "status",
];

switch (action) {
  case "up":
    await runDocker(["up", "--build", "--detach", "--remove-orphans"]);
    await waitForHealth(`${settings.apiUrl}/health`);
    process.stdout.write(
      [
        "",
        "UCM development stack is ready",
        `URL: ${settings.apiUrl}`,
        `Admin email: ${developmentCredentials.adminEmail}`,
        `Admin key: ${developmentCredentials.adminKey}`,
        `Editor key: ${developmentCredentials.sharedKey}`,
        `Viewer key: ${developmentCredentials.viewerKey}`,
        "",
      ].join("\n"),
    );
    break;
  case "infra":
    await runDocker(["stop", "app"]);
    await runDocker(["up", "--detach", "--wait", "postgres"]);
    await waitForTcpPort("127.0.0.1", settings.databasePort);
    await runDocker(["build", "app"]);
    await prepareWatchDatabase();
    process.stdout.write(
      `Docker PostgreSQL is ready on 127.0.0.1:${settings.databasePort}.\n`,
    );
    break;
  case "test":
    await buildTestImage();
    await runDocker(["--profile", "test", "run", "--rm", "test"]);
    break;
  case "check":
    await buildTestImage();
    await runDocker([
      "--profile",
      "test",
      "run",
      "--rm",
      "test",
      "sh",
      "-lc",
      "npm run typecheck && npm run lint && npm test && npm run build",
    ]);
    break;
  case "doctor":
    await runCommand("docker", [
      "version",
      "--format",
      "Docker client {{.Client.Version}}; server {{.Server.Version}}",
    ]);
    await runCommand("docker", ["compose", "version"]);
    await runDocker(["config", "--quiet"]);
    process.stdout.write(
      [
        "Development Compose configuration is valid.",
        `Container app URL: ${settings.apiUrl}`,
        `Hot-reload web URL: ${settings.webUrl}`,
        `Loopback PostgreSQL: 127.0.0.1:${settings.databasePort}`,
        "",
      ].join("\n"),
    );
    break;
  case "stop":
    await runDocker(["down", "--remove-orphans"]);
    break;
  case "reset":
    await runDocker(["down", "--volumes", "--remove-orphans"]);
    break;
  case "logs":
    await runDocker(["logs", "--follow", "--tail", "200"]);
    break;
  case "status":
    await runDocker(["ps", "--all"]);
    break;
  default:
    throw new Error(
      `Unknown dev-stack action "${action}". Use ${validActions.join(", ")}.`,
    );
}

function runDocker(argumentsForCompose) {
  return runCommand("docker", [...composePrefix, ...argumentsForCompose]);
}

function runCommand(command, argumentsForCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsForCommand, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} stopped by ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

async function buildTestImage() {
  await runDocker(["--profile", "test", "build", "test"]);
}

async function prepareWatchDatabase() {
  const databaseName = developmentCredentials.watchDatabaseName;
  const client = new pg.Client({
    host: "127.0.0.1",
    port: settings.databasePort,
    user: developmentCredentials.migratorUser,
    password: developmentCredentials.migratorPassword,
    database: "postgres",
    ssl: false,
  });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount === 0) {
      const quotedDatabase = quoteIdentifier(databaseName);
      const quotedOwner = quoteIdentifier(developmentCredentials.migratorUser);
      await client.query(`CREATE DATABASE ${quotedDatabase} OWNER ${quotedOwner}`);
    }
  } finally {
    await client.end();
  }

  const migrateDatabaseUrl =
    `postgresql://${developmentCredentials.migratorUser}:` +
    `${developmentCredentials.migratorPassword}@postgres:5432/${databaseName}`;
  const applicationDatabaseUrl =
    `postgresql://${developmentCredentials.databaseUser}:` +
    `${developmentCredentials.databasePassword}@postgres:5432/${databaseName}`;
  await runDocker([
    "run",
    "--rm",
    "--no-deps",
    "--env",
    `DATABASE_URL=${migrateDatabaseUrl}`,
    "migrate",
  ]);
  await runDocker([
    "run",
    "--rm",
    "--no-deps",
    "--env",
    `DATABASE_URL=${applicationDatabaseUrl}`,
    "seed",
  ]);
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 120_000;
  let lastError = "service has not responded";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === "ok" && body?.database === "ready") {
          return;
        }
        lastError = `unexpected health response: ${JSON.stringify(body)}`;
      } else {
        lastError = `health returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Development stack did not become healthy: ${lastError}`);
}

async function waitForTcpPort(host, port) {
  const deadline = Date.now() + 30_000;
  let lastError = "port has not accepted a connection";
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host, port });
        const fail = (error) => {
          socket.destroy();
          reject(error);
        };
        socket.setTimeout(1_000);
        socket.once("error", fail);
        socket.once("timeout", () => fail(new Error("connection timed out")));
        socket.once("connect", () => {
          socket.removeListener("error", fail);
          socket.end();
          resolve();
        });
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `PostgreSQL is not reachable at ${host}:${port}: ${lastError}`,
  );
}
