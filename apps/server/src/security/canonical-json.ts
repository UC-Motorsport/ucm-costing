import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalize(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical-json-non-finite-number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child !== undefined) {
        normalized[key] = normalize(child);
      }
    }
    return normalized;
  }
  throw new Error(`canonical-json-unsupported-${typeof value}`);
}
