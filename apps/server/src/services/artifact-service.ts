import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QueryResultRow } from "pg";

import { appendAuditEntry } from "../audit/audit-ledger";
import {
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../config";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  openVerifiedFile,
  sha256File,
} from "../integrity/file-integrity";

export type ArtifactKind =
  | "cost-report"
  | "supporting-workbook"
  | "cost-amendment"
  | "submission-manifest"
  | "submission-package"
  | "other";

export interface ArtifactRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: ArtifactKind;
  status: "reserved" | "complete" | "failed";
  storage_path: string | null;
  content_sha256: string | null;
  byte_size: string | number | null;
  mime_type: string | null;
  report_snapshot_id: string | null;
  metadata_json: Record<string, unknown>;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  version: number;
}

export interface GeneratedArtifact {
  bytes: Uint8Array;
  sha256: string;
  metadata?: Record<string, unknown>;
}

export interface CreateArtifactInput {
  projectId: string;
  kind: ArtifactKind;
  reportSnapshotId?: string | null;
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  /** Permit immutable derivative artifacts from a historical workspace. */
  allowHistorical?: boolean;
  generate(): Promise<GeneratedArtifact> | GeneratedArtifact;
}

export interface GeneratedFileArtifact {
  sha256: string;
  byteSize: number;
  metadata?: Record<string, unknown>;
}

export interface CreateFileArtifactInput
  extends Omit<CreateArtifactInput, "generate"> {
  generate(destination: string):
    | Promise<GeneratedFileArtifact>
    | GeneratedFileArtifact;
}

export type ArtifactReservationInput = Omit<
  CreateArtifactInput,
  "generate"
>;

export interface MaterializeReservedArtifactInput
  extends CreateArtifactInput {
  artifactId: string;
}

export interface MaterializeReservedFileArtifactInput
  extends CreateFileArtifactInput {
  artifactId: string;
}

export async function createArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  input: CreateArtifactInput,
): Promise<ArtifactRow> {
  assertSafeArtifactFilename(input.filename);
  const artifactId = randomUUID();
  await reserveArtifact(database, actor, artifactId, input);
  return generateReservedArtifact(
    database,
    paths,
    actor,
    artifactId,
    input,
  );
}

/**
 * File-backed counterpart for bounded-memory generation such as submission
 * ZIPs. The generator writes exactly once to the supplied staging path; the
 * service verifies its reported size before atomically publishing it.
 */
export async function createFileArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  input: CreateFileArtifactInput,
): Promise<ArtifactRow> {
  assertSafeArtifactFilename(input.filename);
  await assertProjectPermission(
    database,
    actor,
    input.projectId,
    "write",
    { allowHistorical: input.allowHistorical },
  );
  const artifactId = randomUUID();
  await reserveArtifact(database, actor, artifactId, input);
  return generateReservedFileArtifact(
    database,
    paths,
    actor,
    artifactId,
    input,
  );
}

/**
 * Materializes a previously committed reservation. Failed or interrupted
 * attempts reuse the same artifact id; complete artifacts are integrity
 * checked and returned without running the generator again.
 */
export async function materializeReservedArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  input: MaterializeReservedArtifactInput,
): Promise<ArtifactRow> {
  return withArtifactGenerationLock(
    database,
    input.artifactId,
    async () => {
      const current = await prepareReservedArtifact(
        database,
        actor,
        input.artifactId,
        input,
      );
      if (current.status === "complete") {
        await verifyCompleteArtifactFile(current, paths);
        return current;
      }
      return generateReservedArtifact(
        database,
        paths,
        actor,
        input.artifactId,
        input,
      );
    },
  );
}

/**
 * Streaming counterpart to `materializeReservedArtifact`.
 */
export async function materializeReservedFileArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  input: MaterializeReservedFileArtifactInput,
): Promise<ArtifactRow> {
  return withArtifactGenerationLock(
    database,
    input.artifactId,
    async () => {
      const current = await prepareReservedArtifact(
        database,
        actor,
        input.artifactId,
        input,
      );
      if (current.status === "complete") {
        await verifyCompleteArtifactFile(current, paths);
        return current;
      }
      return generateReservedFileArtifact(
        database,
        paths,
        actor,
        input.artifactId,
        input,
      );
    },
  );
}

export async function getArtifactForActor(
  database: DbExecutor,
  actor: ActorContext,
  artifactId: string,
): Promise<ArtifactRow | null> {
  const artifact = await database.maybeOne<ArtifactRow>(
    "SELECT * FROM artifacts WHERE id = $1",
    [artifactId],
  );
  if (!artifact) {
    return null;
  }
  await assertProjectPermission(
    database,
    actor,
    artifact.project_id,
    "read",
  );
  return artifact;
}

export async function listArtifacts(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
  limit = 100,
  offset = 0,
): Promise<ArtifactRow[]> {
  await assertProjectPermission(database, actor, projectId, "read");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid-artifact-pagination");
  }
  const result = await database.query<ArtifactRow>(
    `
      SELECT *
      FROM artifacts
      WHERE project_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
    `,
    [projectId, limit, offset],
  );
  return result.rows;
}

async function generateReservedArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  artifactId: string,
  input: CreateArtifactInput,
): Promise<ArtifactRow> {
  const storage = artifactStoragePaths(
    paths,
    input.projectId,
    artifactId,
    input.filename,
  );
  try {
    await resetUnpublishedFiles(storage);
    const generated = await input.generate();
    assertGeneratedArtifact(generated);
    const expectedByteSize = generated.bytes.byteLength;
    await mkdir(storage.directory, { recursive: true });
    await writeFile(storage.temporaryPath, generated.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const fileStats = await lstat(storage.temporaryPath);
    if (!fileStats.isFile() || fileStats.size !== expectedByteSize) {
      throw new Error("generated-artifact-size-mismatch");
    }
    const actualSha256 = await sha256File(storage.temporaryPath);
    if (actualSha256 !== generated.sha256) {
      throw new Error("generated-artifact-sha256-mismatch");
    }
    await rename(storage.temporaryPath, storage.finalPath);
    return await completeArtifact(
      database,
      actor,
      artifactId,
      input,
      storage.finalPath,
      actualSha256,
      expectedByteSize,
      generated.metadata,
      paths,
    );
  } catch (error) {
    await resetUnpublishedFiles(storage);
    await failArtifact(
      database,
      actor,
      artifactId,
      input.projectId,
      error,
    ).catch(() => undefined);
    throw error;
  }
}

async function generateReservedFileArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  artifactId: string,
  input: CreateFileArtifactInput,
): Promise<ArtifactRow> {
  const storage = artifactStoragePaths(
    paths,
    input.projectId,
    artifactId,
    input.filename,
  );
  try {
    await resetUnpublishedFiles(storage);
    await mkdir(storage.directory, { recursive: true });
    const generated = await input.generate(storage.temporaryPath);
    if (
      !/^[a-f0-9]{64}$/.test(generated.sha256) ||
      !Number.isSafeInteger(generated.byteSize) ||
      generated.byteSize <= 0
    ) {
      throw new Error("generated-file-artifact-invalid");
    }
    const fileStats = await lstat(storage.temporaryPath);
    if (!fileStats.isFile() || fileStats.size !== generated.byteSize) {
      throw new Error("generated-file-artifact-size-mismatch");
    }
    const actualSha256 = await sha256File(storage.temporaryPath);
    if (actualSha256 !== generated.sha256) {
      throw new Error("generated-file-artifact-sha256-mismatch");
    }
    await rename(storage.temporaryPath, storage.finalPath);
    return await completeArtifact(
      database,
      actor,
      artifactId,
      input,
      storage.finalPath,
      actualSha256,
      generated.byteSize,
      generated.metadata,
      paths,
    );
  } catch (error) {
    await resetUnpublishedFiles(storage);
    await failArtifact(
      database,
      actor,
      artifactId,
      input.projectId,
      error,
    ).catch(() => undefined);
    throw error;
  }
}

async function prepareReservedArtifact(
  database: DatabaseHandle,
  actor: ActorContext,
  artifactId: string,
  input: ArtifactReservationInput,
): Promise<ArtifactRow> {
  return database.transaction(async (transaction) => {
    await lockProject(transaction, input.projectId);
    await assertProjectPermission(
      transaction,
      actor,
      input.projectId,
      "write",
      { allowHistorical: input.allowHistorical },
    );
    const current = await transaction.maybeOne<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = $1 FOR UPDATE",
      [artifactId],
    );
    if (!current) {
      throw new Error("artifact-reservation-not-found");
    }
    assertArtifactReservationIdentity(current, input);
    if (current.status === "complete") {
      if (current.mime_type !== input.mimeType) {
        throw new Error("artifact-reservation-identity-mismatch");
      }
      return current;
    }
    if (current.status === "reserved") {
      return current;
    }
    const retried = await transaction.one<ArtifactRow>(
      `
        UPDATE artifacts
        SET status = 'reserved',
            storage_path = NULL,
            content_sha256 = NULL,
            byte_size = NULL,
            mime_type = NULL,
            completed_at = NULL,
            error_message = NULL,
            version = version + 1
        WHERE id = $1 AND status = 'failed'
        RETURNING *
      `,
      [artifactId],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: input.projectId,
      action: "artifact.retried",
      entityType: "artifact",
      entityId: artifactId,
      before: auditArtifact(current),
      after: auditArtifact(retried),
    });
    return retried;
  });
}

async function verifyCompleteArtifactFile(
  artifact: ArtifactRow,
  paths: AppPaths,
): Promise<void> {
  if (
    !artifact.storage_path ||
    !artifact.content_sha256 ||
    artifact.byte_size === null
  ) {
    throw new Error("complete-artifact-storage-contract-invalid");
  }
  const verified = await openVerifiedFile(
    resolveStoredDataPath(artifact.storage_path, paths),
    artifact.content_sha256,
  );
  try {
    if (verified.stats.size !== Number(artifact.byte_size)) {
      throw new Error("complete-artifact-byte-size-mismatch");
    }
  } finally {
    await verified.handle.close();
  }
}

async function withArtifactGenerationLock<T>(
  database: DatabaseHandle,
  artifactId: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  const lockKey = `ucm:artifact-generation:${artifactId}`;
  try {
    const { rows: [row] } = await client.query<{ acquired: boolean }>(
      `
        SELECT pg_try_advisory_lock(
          hashtextextended($1, 0)
        ) AS acquired
      `,
      [lockKey],
    );
    if (!row?.acquired) {
      throw new Error("artifact-generation-in-progress");
    }
    try {
      return await work();
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey],
      );
    }
  } finally {
    client.release();
  }
}

function assertArtifactReservationIdentity(
  artifact: ArtifactRow,
  input: ArtifactReservationInput,
): void {
  if (
    artifact.project_id !== input.projectId ||
    artifact.kind !== input.kind ||
    artifact.report_snapshot_id !== (input.reportSnapshotId ?? null) ||
    artifact.metadata_json.filename !== input.filename
  ) {
    throw new Error("artifact-reservation-identity-mismatch");
  }
}

function artifactStoragePaths(
  paths: AppPaths,
  projectId: string,
  artifactId: string,
  filename: string,
) {
  const directory = path.join(paths.dataRoot, "artifacts", projectId);
  const extension = path.extname(filename).toLowerCase();
  return {
    directory,
    finalPath: path.join(directory, `${artifactId}${extension}`),
    temporaryPath: path.join(
      directory,
      `.${artifactId}${extension}.tmp`,
    ),
  };
}

async function resetUnpublishedFiles(
  storage: {
    finalPath: string;
    temporaryPath: string;
  },
): Promise<void> {
  await Promise.all(
    [storage.temporaryPath, storage.finalPath].map((candidate) =>
      unlink(candidate).catch(() => undefined),
    ),
  );
}

async function failArtifact(
  database: DatabaseHandle,
  actor: ActorContext,
  artifactId: string,
  projectId: string,
  error: unknown,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const failed = await transaction.maybeOne<ArtifactRow>(
      `
        UPDATE artifacts
        SET status = 'failed', error_message = $1,
            completed_at = clock_timestamp(), version = version + 1
        WHERE id = $2 AND status = 'reserved'
        RETURNING *
      `,
      [
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : "Unknown artifact generation error",
        artifactId,
      ],
    );
    if (failed) {
      await appendAuditEntry(transaction, actor, {
        projectId,
        action: "artifact.failed",
        entityType: "artifact",
        entityId: artifactId,
        after: auditArtifact(failed),
      });
    }
  });
}

async function reserveArtifact(
  database: DatabaseHandle,
  actor: ActorContext,
  artifactId: string,
  input: ArtifactReservationInput,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await reserveArtifactRecord(
      transaction,
      actor,
      artifactId,
      input,
    );
  });
}

/**
 * Reserves an artifact inside an existing workflow transaction. The caller can
 * atomically reference the reservation from its own durable orchestration row
 * before any bytes are written.
 */
export async function reserveArtifactRecord(
  transaction: TransactionHandle,
  actor: ActorContext,
  artifactId: string,
  input: ArtifactReservationInput,
): Promise<ArtifactRow> {
  assertSafeArtifactFilename(input.filename);
  await lockProject(transaction, input.projectId);
  await assertProjectPermission(
    transaction,
    actor,
    input.projectId,
    "write",
    { allowHistorical: input.allowHistorical },
  );
  if (input.reportSnapshotId) {
    const report = await transaction.maybeOne<{ id: string }>(
      `
        SELECT id
        FROM report_snapshots
        WHERE id = $1 AND project_id = $2 AND status = 'complete'
      `,
      [input.reportSnapshotId, input.projectId],
    );
    if (!report) {
      throw new Error("artifact-report-not-complete");
    }
  }
  const reserved = await transaction.one<ArtifactRow>(
    `
      INSERT INTO artifacts(
        id, project_id, kind, status, report_snapshot_id,
        metadata_json, created_by
      )
      VALUES ($1, $2, $3, 'reserved', $4, $5::jsonb, $6)
      RETURNING *
    `,
    [
      artifactId,
      input.projectId,
      input.kind,
      input.reportSnapshotId ?? null,
      JSON.stringify({
        ...(input.metadata ?? {}),
        filename: input.filename,
      }),
      actor.actorUserId,
    ],
  );
  await appendAuditEntry(transaction, actor, {
    projectId: input.projectId,
    action: "artifact.reserved",
    entityType: "artifact",
    entityId: artifactId,
    after: auditArtifact(reserved),
  });
  return reserved;
}

async function completeArtifact(
  database: DatabaseHandle,
  actor: ActorContext,
  artifactId: string,
  input: Omit<CreateArtifactInput, "generate">,
  finalPath: string,
  sha256: string,
  byteSize: number,
  generatedMetadata: Record<string, unknown> | undefined,
  paths: AppPaths,
): Promise<ArtifactRow> {
  return await database.transaction(async (transaction) => {
    await lockProject(transaction, input.projectId);
    const artifact = await transaction.maybeOne<ArtifactRow>(
      `
        UPDATE artifacts
        SET status = 'complete', storage_path = $1,
            content_sha256 = $2, byte_size = $3, mime_type = $4,
            metadata_json = metadata_json || $5::jsonb,
            completed_at = clock_timestamp(), version = version + 1
        WHERE id = $6 AND status = 'reserved'
        RETURNING *
      `,
      [
        toStoredDataPath(finalPath, paths),
        sha256,
        byteSize,
        input.mimeType,
        JSON.stringify(generatedMetadata ?? {}),
        artifactId,
      ],
    );
    if (!artifact) {
      throw new Error("artifact-reservation-lost");
    }
    await appendAuditEntry(transaction, actor, {
      projectId: input.projectId,
      action: "artifact.completed",
      entityType: "artifact",
      entityId: artifactId,
      after: auditArtifact(artifact),
    });
    return artifact;
  });
}

async function lockProject(
  database: DbExecutor,
  projectId: string,
): Promise<void> {
  const project = await database.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
}

function assertSafeArtifactFilename(filename: string): void {
  if (
    filename.length < 1 ||
    filename.length > 200 ||
    filename !== path.basename(filename) ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new Error("invalid-artifact-filename");
  }
}

function assertGeneratedArtifact(
  artifact: GeneratedArtifact,
): void {
  if (
    artifact.bytes.byteLength === 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error("generated-artifact-invalid");
  }
}

function auditArtifact(artifact: ArtifactRow) {
  return {
    id: artifact.id,
    projectId: artifact.project_id,
    kind: artifact.kind,
    status: artifact.status,
    reportSnapshotId: artifact.report_snapshot_id,
    storagePath: artifact.storage_path,
    contentSha256: artifact.content_sha256,
    byteSize: artifact.byte_size,
    mimeType: artifact.mime_type,
    metadata: artifact.metadata_json,
    createdBy: artifact.created_by,
    createdAt: artifact.created_at,
    completedAt: artifact.completed_at,
    errorMessage: artifact.error_message,
    version: artifact.version,
  };
}
