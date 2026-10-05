import { spawn } from "node:child_process";

export async function runPostgresCommand(
  command,
  arguments_,
  environment,
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", (error) => {
      reject(commandStartError(command, error));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(commandExitError(command, code, signal, stderr));
    });
  });
}

export async function runAtomicPostgresRestore(
  filename,
  environment,
) {
  await new Promise((resolve, reject) => {
    const archive = spawn(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--file=-",
        filename,
      ],
      {
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const database = spawn(
      "psql",
      [
        "--no-psqlrc",
        "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--single-transaction",
        "--file=-",
      ],
      {
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let archiveClosed = false;
    let databaseClosed = false;
    let archiveStderr = "";
    let databaseStderr = "";
    let failure = null;
    let settled = false;

    database.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        fail(error);
      }
    });
    archive.stderr.setEncoding("utf8");
    database.stderr.setEncoding("utf8");
    archive.stderr.on("data", (chunk) => {
      archiveStderr = boundedAppend(archiveStderr, chunk);
    });
    database.stdout.resume();
    database.stderr.on("data", (chunk) => {
      databaseStderr = boundedAppend(databaseStderr, chunk);
    });
    archive.once("error", (error) => {
      fail(commandStartError("pg_restore", error));
    });
    database.once("error", (error) => {
      fail(commandStartError("psql", error));
    });

    database.stdin.write(
      "DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n",
    );
    archive.stdout.pipe(database.stdin, { end: false });

    archive.once("close", (code, signal) => {
      archiveClosed = true;
      if (code !== 0) {
        fail(
          commandExitError(
            "pg_restore",
            code,
            signal,
            archiveStderr,
          ),
        );
      } else if (!failure && !databaseClosed) {
        database.stdin.end();
      }
      finish();
    });
    database.once("close", (code, signal) => {
      databaseClosed = true;
      if (code !== 0) {
        fail(
          commandExitError(
            "psql",
            code,
            signal,
            databaseStderr,
          ),
        );
      } else if (!archiveClosed) {
        fail(
          new Error(
            "psql exited before pg_restore finished streaming the archive.",
          ),
        );
      }
      finish();
    });

    function fail(error) {
      if (!failure) {
        failure = error;
      }
      archive.stdout.unpipe(database.stdin);
      if (!archiveClosed) {
        archive.kill("SIGTERM");
      }
      if (!databaseClosed) {
        database.kill("SIGTERM");
      }
    }

    function finish() {
      if (settled || !archiveClosed || !databaseClosed) {
        return;
      }
      settled = true;
      if (failure) {
        reject(failure);
      } else {
        resolve();
      }
    }
  });
}

function commandStartError(command, error) {
  if (error.code === "ENOENT") {
    return new Error(
      `${command} is required. Install the PostgreSQL client tools.`,
    );
  }
  return error;
}

function commandExitError(command, code, signal, stderr) {
  const detail = stderr.trim() || `signal ${signal ?? "unknown"}`;
  return new Error(
    `${command} failed (${code ?? "no exit code"}): ${detail}`,
  );
}

function boundedAppend(existing, chunk) {
  const maximumCharacters = 32_768;
  const combined = existing + chunk;
  return combined.length <= maximumCharacters
    ? combined
    : combined.slice(combined.length - maximumCharacters);
}
