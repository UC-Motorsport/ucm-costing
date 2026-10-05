import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  nextDailyBackupTime,
  parseBackupHour,
  runQuiescedBackup,
} from "./backup-scheduler-lib.mjs";

const originalTimeZone = process.env.TZ;

before(() => {
  process.env.TZ = "Pacific/Auckland";
});

after(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

test("schedules 06:00 in New Zealand summer time", () => {
  const now = new Date("2026-01-14T16:30:00.000Z");
  assert.equal(
    nextDailyBackupTime(now, 6).toISOString(),
    "2026-01-14T17:00:00.000Z",
  );
});

test("schedules 06:00 in New Zealand winter time", () => {
  const now = new Date("2026-07-30T19:00:00.000Z");
  assert.equal(
    nextDailyBackupTime(now, 6).toISOString(),
    "2026-07-31T18:00:00.000Z",
  );
});

test("schedules the following day when the current time is exactly 06:00", () => {
  const now = new Date("2026-07-30T18:00:00.000Z");
  assert.equal(
    nextDailyBackupTime(now, 6).toISOString(),
    "2026-07-31T18:00:00.000Z",
  );
});

test("rejects an invalid daily hour", () => {
  assert.throws(() => parseBackupHour("24"), /integer from 0 to 23/);
  assert.throws(() => parseBackupHour("six"), /integer from 0 to 23/);
});

test("stops the application, creates a backup, then restarts it", async () => {
  const operations = [];
  const result = await runQuiescedBackup({
    async stopApplication() {
      operations.push("stop");
    },
    async createBackup() {
      operations.push("backup");
      return "verified-backup";
    },
    async startApplication() {
      operations.push("start");
    },
  });

  assert.equal(result, "verified-backup");
  assert.deepEqual(operations, ["stop", "backup", "start"]);
});

test("restarts the application when backup creation fails", async () => {
  const operations = [];
  await assert.rejects(
    runQuiescedBackup({
      async stopApplication() {
        operations.push("stop");
      },
      async createBackup() {
        operations.push("backup");
        throw new Error("disk unavailable");
      },
      async startApplication() {
        operations.push("start");
      },
    }),
    /disk unavailable/,
  );

  assert.deepEqual(operations, ["stop", "backup", "start"]);
});

test("does not restart during an external supervisor shutdown", async () => {
  const operations = [];
  await runQuiescedBackup({
    async stopApplication() {
      operations.push("stop");
    },
    async createBackup() {
      operations.push("backup");
    },
    async startApplication() {
      operations.push("start");
    },
    shouldRestart: () => false,
  });

  assert.deepEqual(operations, ["stop", "backup"]);
});
