import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export class FileIntegrityError extends Error {
  readonly code = "stored-file-integrity-failed";

  constructor(
    readonly filePath: string,
    readonly expectedSha256: string,
    readonly actualSha256: string | null,
  ) {
    super("Stored file failed its SHA-256 integrity check");
  }
}

export interface VerifiedFile {
  filePath: string;
  handle: FileHandle;
  stats: Stats;
  sha256: string;
}

export async function sha256File(filePath: string): Promise<string> {
  const verified = await hashOpenFile(filePath);
  await verified.handle.close();
  return verified.sha256;
}

export async function openVerifiedFile(
  filePath: string,
  expectedSha256: string,
): Promise<VerifiedFile> {
  assertSha256(expectedSha256);
  let verified: VerifiedFile;
  try {
    verified = await hashOpenFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new FileIntegrityError(filePath, expectedSha256, null);
    }
    throw error;
  }

  if (!safeDigestEqual(verified.sha256, expectedSha256)) {
    await verified.handle.close();
    throw new FileIntegrityError(filePath, expectedSha256, verified.sha256);
  }
  return verified;
}

export function createVerifiedReadStream(verified: VerifiedFile) {
  return verified.handle.createReadStream({
    autoClose: true,
    start: 0,
  });
}

async function hashOpenFile(filePath: string): Promise<VerifiedFile> {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("stored-path-is-not-file");
    }
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, {
      fd: handle.fd,
      autoClose: false,
      start: 0,
    });
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("stored-file-changed-during-integrity-check");
    }
    return {
      filePath,
      handle,
      stats: after,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left.toLowerCase(), "ascii");
  const rightBuffer = Buffer.from(right.toLowerCase(), "ascii");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("invalid-sha256");
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
