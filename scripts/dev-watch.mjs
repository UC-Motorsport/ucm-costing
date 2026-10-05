import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createWatchEnvironment,
  developmentCredentials,
  developmentStackSettings,
} from "./dev-stack-config.mjs";

const repositoryRoot = process.cwd();
const settings = developmentStackSettings(process.env);
const watchEnvironment = createWatchEnvironment(
  process.env,
  repositoryRoot,
);

await run("node", ["scripts/dev-stack.mjs", "infra"], process.env);
await Promise.all(
  [
    watchEnvironment.UCM_DATA_ROOT,
    watchEnvironment.UCM_OUTPUT_ROOT,
    watchEnvironment.UCM_BACKUP_ROOT,
  ].map((directory) => mkdir(directory, { recursive: true })),
);

process.stdout.write(
  [
    "",
    "UCM hot-reload development is starting",
    `Web: ${settings.webUrl}`,
    `API: ${settings.apiUrl}`,
    `PostgreSQL: 127.0.0.1:${settings.databasePort}`,
    `Admin email: ${developmentCredentials.adminEmail}`,
    `Admin key: ${developmentCredentials.adminKey}`,
    `Editor key: ${developmentCredentials.sharedKey}`,
    `Viewer key: ${developmentCredentials.viewerKey}`,
    "Press Ctrl-C to stop the API and web watchers; PostgreSQL stays ready for the next run.",
    "",
  ].join("\n"),
);

const development = spawn("npm", ["run", "dev"], {
  cwd: repositoryRoot,
  env: { ...process.env, ...watchEnvironment },
  stdio: "inherit",
});

let stopping = false;
const forwardSignal = (signal) => {
  stopping = true;
  if (!development.killed) {
    development.kill(signal);
  }
};
const handleInterrupt = () => forwardSignal("SIGINT");
const handleTermination = () => forwardSignal("SIGTERM");
process.once("SIGINT", handleInterrupt);
process.once("SIGTERM", handleTermination);

const exitCode = await new Promise((resolve, reject) => {
  development.once("error", reject);
  development.once("exit", (code, signal) => {
    if (stopping || signal === "SIGINT" || signal === "SIGTERM") {
      resolve(0);
      return;
    }
    resolve(code ?? 1);
  });
});

process.removeListener("SIGINT", handleInterrupt);
process.removeListener("SIGTERM", handleTermination);
process.exitCode = exitCode;

function run(command, argumentsForCommand, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsForCommand, {
      cwd: path.resolve(repositoryRoot),
      env: environment,
      stdio: "inherit",
    });
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
