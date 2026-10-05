export const DEFAULT_BACKUP_HOUR = 6;

export function parseBackupHour(rawHour = DEFAULT_BACKUP_HOUR) {
  const hour =
    typeof rawHour === "number" ? rawHour : Number.parseInt(rawHour, 10);
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("The daily backup hour must be an integer from 0 to 23.");
  }
  return hour;
}

export function nextDailyBackupTime(
  now = new Date(),
  hour = DEFAULT_BACKUP_HOUR,
) {
  const parsedHour = parseBackupHour(hour);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date.");
  }

  const next = new Date(now.getTime());
  next.setHours(parsedHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export async function runQuiescedBackup({
  stopApplication,
  createBackup,
  startApplication,
  shouldRestart = () => true,
}) {
  for (const [name, operation] of Object.entries({
    stopApplication,
    createBackup,
    startApplication,
    shouldRestart,
  })) {
    if (typeof operation !== "function") {
      throw new TypeError(`${name} must be a function.`);
    }
  }

  await stopApplication();

  let backupResult;
  let backupError;
  try {
    backupResult = await createBackup();
  } catch (error) {
    backupError = error;
  }

  let restartError;
  if (shouldRestart()) {
    try {
      await startApplication();
    } catch (error) {
      restartError = error;
    }
  }

  if (backupError && restartError) {
    throw new AggregateError(
      [backupError, restartError],
      "The scheduled backup failed and the application could not restart.",
    );
  }
  if (restartError) {
    throw restartError;
  }
  if (backupError) {
    throw backupError;
  }
  return backupResult;
}
