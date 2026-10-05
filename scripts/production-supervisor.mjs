#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBackup } from "./backup-lib.mjs";
import {
  DEFAULT_BACKUP_HOUR,
  nextDailyBackupTime,
  runQuiescedBackup,
} from "./backup-scheduler-lib.mjs";

const NEW_ZEALAND_TIME_ZONE = "Pacific/Auckland";
const SERVER_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/server/dist/index.js",
);

export async function main() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      "The automated backup supervisor may run only with NODE_ENV=production.",
    );
  }
  if (process.env.TZ !== NEW_ZEALAND_TIME_ZONE) {
    throw new Error(
      `The automated backup supervisor requires TZ=${NEW_ZEALAND_TIME_ZONE}.`,
    );
  }

  let application = null;
  let stopPromise = null;
  let scheduledTimer = null;
  let activeCycle = null;
  let shuttingDown = false;
  const expectedStops = new WeakSet();

  const startApplication = async () => {
    if (application) {
      throw new Error("UCM Costing is already running.");
    }
    const child = spawn(process.execPath, [SERVER_ENTRYPOINT], {
      env: process.env,
      stdio: "inherit",
    });
    application = child;
    let unexpectedExitHandled = false;

    child.once("error", (error) => {
      if (unexpectedExitHandled || expectedStops.has(child) || shuttingDown) {
        return;
      }
      unexpectedExitHandled = true;
      process.stderr.write(
        `UCM Costing failed to start under the backup supervisor: ${error.message}\n`,
      );
      clearScheduledTimer();
      process.exit(1);
    });
    child.once("exit", (code, signal) => {
      if (application === child) {
        application = null;
      }
      if (unexpectedExitHandled || expectedStops.has(child) || shuttingDown) {
        return;
      }
      unexpectedExitHandled = true;
      process.stderr.write(
        signal
          ? `UCM Costing exited unexpectedly after signal ${signal}\n`
          : `UCM Costing exited unexpectedly with code ${code ?? "unknown"}\n`,
      );
      clearScheduledTimer();
      process.exit(code && code > 0 ? code : 1);
    });
  };

  const stopApplication = async () => {
    if (stopPromise) {
      return stopPromise;
    }
    const child = application;
    if (!child) {
      return;
    }
    expectedStops.add(child);
    stopPromise = (async () => {
      const exited = once(child, "exit");
      if (!child.kill("SIGTERM")) {
        throw new Error("Could not signal UCM Costing to stop.");
      }
      await exited;
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const clearScheduledTimer = () => {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  };

  const scheduleNextBackup = () => {
    if (shuttingDown) {
      return;
    }
    clearScheduledTimer();
    const now = new Date();
    const next = nextDailyBackupTime(now, DEFAULT_BACKUP_HOUR);
    const delay = next.getTime() - now.getTime();
    process.stdout.write(
      `Automated backups run daily at 06:00 ${NEW_ZEALAND_TIME_ZONE}; next run ${formatNewZealandTime(next)} (${next.toISOString()})\n`,
    );
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      activeCycle = runScheduledBackup()
        .catch((error) => {
          process.stderr.write(
            `Scheduled backup failed: ${errorMessage(error)}\n`,
          );
        })
        .finally(() => {
          activeCycle = null;
          scheduleNextBackup();
        });
    }, delay);
  };

  const runScheduledBackup = async () => {
    process.stdout.write(
      "Starting scheduled backup; UCM Costing will briefly stop accepting requests\n",
    );
    const result = await runQuiescedBackup({
      stopApplication,
      async createBackup() {
        const created = await createBackup();
        process.stdout.write(
          `${JSON.stringify({
            status: "created-and-verified",
            backup: created.backupRoot,
            createdAt: created.manifest.createdAt,
            files: created.manifest.files.length,
            schemaVersion: created.manifest.database.schemaVersion,
            manifestSha256: created.manifestSha256,
          })}\n`,
        );
        return created;
      },
      async startApplication() {
        process.stdout.write(
          "Scheduled backup cycle finished; restarting UCM Costing\n",
        );
        await startApplication();
      },
      shouldRestart: () => !shuttingDown,
    });
    return result;
  };

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearScheduledTimer();
    process.stdout.write(
      `Received ${signal}; stopping the automated backup supervisor\n`,
    );
    try {
      await stopApplication();
      await activeCycle;
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `Backup supervisor shutdown failed: ${errorMessage(error)}\n`,
      );
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await startApplication();
  scheduleNextBackup();
}

function formatNewZealandTime(date) {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: NEW_ZEALAND_TIME_ZONE,
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(errorMessage).join(" ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(
      `Automated backup supervisor failed: ${errorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}
