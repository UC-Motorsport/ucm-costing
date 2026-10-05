import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeAuditEntryHash,
  verifyAuditLedgerRows,
  type AuditLedgerRow,
} from "../src/audit/audit-ledger";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../src/security/canonical-json";
import {
  digestSharedAccessKey,
  verifySharedAccessKey,
} from "../src/security/shared-access-key";
import {
  createOpaqueToken,
  digestOpaqueToken,
} from "../src/security/tokens";
import {
  FileIntegrityError,
  openVerifiedFile,
  sha256File,
} from "../src/integrity/file-integrity";

describe("shared access keys", () => {
  it("creates a deterministic fixed-length fingerprint without retaining the key", () => {
    const key = "team shared access key";
    const first = digestSharedAccessKey(key);
    const second = digestSharedAccessKey(key);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(key);
    expect(digestSharedAccessKey(`${key}!`)).not.toBe(first);
  });

  it("compares the exact configured key", () => {
    const key = "shared-key-with-unicode-\u0101";

    expect(verifySharedAccessKey(key, key)).toBe(true);
    expect(verifySharedAccessKey(key.toUpperCase(), key)).toBe(false);
    expect(verifySharedAccessKey(` ${key}`, key)).toBe(false);
    expect(verifySharedAccessKey(`${key}!`, key)).toBe(false);
  });
});

describe("opaque tokens", () => {
  it("stores a deterministic digest instead of the bearer token", () => {
    const token = createOpaqueToken();
    expect(token).toHaveLength(43);
    expect(digestOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestOpaqueToken(token)).not.toContain(token);
  });
});

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, a: { y: true, x: ["b", "a"] } };
    const right = { a: { x: ["b", "a"], y: true }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256CanonicalJson(left)).toBe(sha256CanonicalJson(right));
  });

  it("rejects values that cannot be represented safely", () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(
      "canonical-json-non-finite-number",
    );
    expect(() => canonicalJson({ value: 1n })).toThrow(
      "canonical-json-unsupported-bigint",
    );
  });
});

describe("audit ledger hashing", () => {
  it("verifies an ordered hash chain and detects altered payloads", () => {
    const occurredAt = "2026-07-30T07:50:00.000Z";
    const firstBase = {
      sequence: "1",
      previousHash: null,
      actorUserId: "user-1",
      projectId: "project-1",
      requestId: "request-1",
      action: "project.created",
      entityType: "project",
      entityId: "project-1",
      before: null,
      after: { name: "UCM 2026" },
      metadata: {},
      occurredAt,
    };
    const firstHash = computeAuditEntryHash(firstBase);
    const secondBase = {
      ...firstBase,
      sequence: "2",
      previousHash: firstHash,
      requestId: "request-2",
      action: "project.updated",
      before: { name: "UCM 2026" },
      after: { name: "UCM 2026 EV" },
    };
    const secondHash = computeAuditEntryHash(secondBase);
    const rows: AuditLedgerRow[] = [
      toLedgerRow(firstBase, firstHash),
      toLedgerRow(secondBase, secondHash),
    ];

    expect(verifyAuditLedgerRows(rows)).toEqual({
      ok: true,
      checked: 2,
      error: null,
    });
    const secondRow = rows[1];
    if (!secondRow) {
      throw new Error("missing-test-ledger-row");
    }
    rows[1] = { ...secondRow, after_json: { name: "tampered" } };
    expect(verifyAuditLedgerRows(rows)).toMatchObject({
      ok: false,
      error: "audit-ledger-entry-hash-mismatch:2",
    });
  });
});

describe("stored file integrity", () => {
  it("opens the verified inode and rejects changed bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ucm-integrity-"));
    const filePath = path.join(root, "evidence.bin");
    try {
      await fs.writeFile(filePath, "original evidence", "utf8");
      const digest = await sha256File(filePath);
      const verified = await openVerifiedFile(filePath, digest);
      expect(verified.stats.size).toBe(Buffer.byteLength("original evidence"));
      await verified.handle.close();

      await fs.writeFile(filePath, "altered evidence", "utf8");
      await expect(openVerifiedFile(filePath, digest)).rejects.toBeInstanceOf(
        FileIntegrityError,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function toLedgerRow(
  input: Parameters<typeof computeAuditEntryHash>[0],
  entryHash: string,
): AuditLedgerRow {
  return {
    sequence: input.sequence,
    previous_hash: input.previousHash,
    entry_hash: entryHash,
    actor_user_id: input.actorUserId,
    project_id: input.projectId,
    request_id: input.requestId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before_json: input.before,
    after_json: input.after,
    metadata_json: input.metadata,
    occurred_at: input.occurredAt,
  };
}
