import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 32 || byteLength > 128) {
    throw new Error("invalid-token-length");
  }
  return randomBytes(byteLength).toString("base64url");
}

export function digestOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
