import { createHash, timingSafeEqual } from "node:crypto";

export function digestSharedAccessKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function verifySharedAccessKey(
  candidate: string,
  configured: string,
): boolean {
  const candidateDigest = Buffer.from(digestSharedAccessKey(candidate), "hex");
  const configuredDigest = Buffer.from(digestSharedAccessKey(configured), "hex");
  return timingSafeEqual(candidateDigest, configuredDigest);
}
