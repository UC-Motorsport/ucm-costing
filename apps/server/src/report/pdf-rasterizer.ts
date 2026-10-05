import { spawn } from "node:child_process";

const RASTERIZER_TIMEOUT_MS = 30_000;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export async function rasterizePdfPage(
  bytes: Uint8Array,
  pageIndex: number,
  scaleTo = 2400,
): Promise<Uint8Array> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("report-evidence-page-missing");
  }
  const pageNumber = pageIndex + 1;

  return await new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(
      "pdftoppm",
      [
        "-f",
        String(pageNumber),
        "-l",
        String(pageNumber),
        "-singlefile",
        "-png",
        "-scale-to",
        String(scaleTo),
        "-",
      ],
      {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;

    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RASTERIZER_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PNG_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const bounded = chunk.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.byteLength;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(
          new Error(
            error.code === "ENOENT"
              ? "report-pdf-rasterizer-unavailable"
              : "report-pdf-rasterizer-failed",
          ),
        );
      });
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error("report-pdf-rasterizer-timeout"));
          return;
        }
        if (outputTooLarge) {
          reject(new Error("report-pdf-rasterizer-output-too-large"));
          return;
        }
        const png = Buffer.concat(stdout);
        if (
          code !== 0 ||
          signal !== null ||
          png.byteLength < PNG_SIGNATURE.byteLength ||
          !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
        ) {
          reject(new Error("report-pdf-rasterizer-failed"));
          return;
        }
        resolve(png);
      });
    });
    child.stdin.on("error", () => {
      // A failed converter may close stdin before all verified bytes are
      // written. The close handler above returns the stable application error.
    });
    child.stdin.end(Buffer.from(bytes));
  });
}
