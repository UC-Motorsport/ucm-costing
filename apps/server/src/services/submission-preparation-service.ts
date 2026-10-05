import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  TransactionHandle,
} from "../db/database";
import type {
  SubmissionPackageManifest,
} from "../export/submission-package";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  reserveArtifactRecord,
} from "./artifact-service";
import {
  prepareSubmissionRecordInTransaction,
  type SubmissionRow,
} from "./submission-service";

export interface SubmissionPreparationRow extends QueryResultRow {
  id: string;
  project_id: string;
  report_snapshot_id: string;
  supporting_artifact_id: string;
  package_artifact_id: string;
  manifest_artifact_id: string;
  status: "reserved" | "generating" | "failed" | "complete";
  prepared_by: string;
  prepared_at: string;
  attempt_count: number;
  last_attempt_by: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  completed_submission_id: string | null;
  completed_at: string | null;
  version: number;
}

interface ReserveSubmissionPreparationInput {
  projectId: string;
  reportSnapshotId: string;
  supportingArtifactId: string;
  packageFilename: string;
  manifestFilename: string;
}

interface FinalizeSubmissionPreparationInput {
  manifest: SubmissionPackageManifest;
}

export async function reserveSubmissionPreparation(
  database: DatabaseHandle,
  actor: ActorContext,
  input: ReserveSubmissionPreparationInput,
): Promise<SubmissionPreparationRow> {
  return database.transaction(async (transaction) => {
    await lockProject(transaction, input.projectId);
    await assertProjectPermission(
      transaction,
      actor,
      input.projectId,
      "write",
    );
    const existing = await transaction.maybeOne<SubmissionPreparationRow>(
      `
        SELECT *
        FROM submission_preparations
        WHERE project_id = $1
          AND report_snapshot_id = $2
          AND supporting_artifact_id = $3
        FOR UPDATE
      `,
      [
        input.projectId,
        input.reportSnapshotId,
        input.supportingArtifactId,
      ],
    );
    if (existing) {
      return existing;
    }

    await assertPreparationSources(transaction, input);
    const submissionId = randomUUID();
    const packageArtifactId = randomUUID();
    const manifestArtifactId = randomUUID();
    await reserveArtifactRecord(
      transaction,
      actor,
      packageArtifactId,
      {
        projectId: input.projectId,
        kind: "submission-package",
        reportSnapshotId: input.reportSnapshotId,
        filename: input.packageFilename,
        mimeType: "application/zip",
        metadata: {
          submissionId,
          mode: "competition-ready",
          externalSubmissionRecorded: false,
        },
      },
    );
    await reserveArtifactRecord(
      transaction,
      actor,
      manifestArtifactId,
      {
        projectId: input.projectId,
        kind: "submission-manifest",
        reportSnapshotId: input.reportSnapshotId,
        filename: input.manifestFilename,
        mimeType: "application/json",
        metadata: {
          submissionId,
          canonicalJson: true,
        },
      },
    );
    const reserved = await transaction.one<SubmissionPreparationRow>(
      `
        INSERT INTO submission_preparations(
          id, project_id, report_snapshot_id,
          supporting_artifact_id, package_artifact_id,
          manifest_artifact_id, status, prepared_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'reserved', $7)
        RETURNING *
      `,
      [
        submissionId,
        input.projectId,
        input.reportSnapshotId,
        input.supportingArtifactId,
        packageArtifactId,
        manifestArtifactId,
        actor.actorUserId,
      ],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: input.projectId,
      action: "submission.preparation-reserved",
      entityType: "submission-preparation",
      entityId: submissionId,
      after: auditPreparation(reserved),
    });
    return reserved;
  });
}

export async function beginSubmissionPreparation(
  database: DatabaseHandle,
  actor: ActorContext,
  preparationId: string,
): Promise<SubmissionPreparationRow> {
  return database.transaction(async (transaction) => {
    const current = await lockPreparation(
      transaction,
      actor,
      preparationId,
    );
    if (current.status === "complete") {
      return current;
    }
    const started = await transaction.one<SubmissionPreparationRow>(
      `
        UPDATE submission_preparations
        SET status = 'generating',
            attempt_count = attempt_count + 1,
            last_attempt_by = $1,
            last_attempt_at = clock_timestamp(),
            last_error = NULL,
            version = version + 1
        WHERE id = $2 AND status <> 'complete'
        RETURNING *
      `,
      [actor.actorUserId, preparationId],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action:
        current.status === "reserved"
          ? "submission.preparation-started"
          : "submission.preparation-retried",
      entityType: "submission-preparation",
      entityId: preparationId,
      before: auditPreparation(current),
      after: auditPreparation(started),
    });
    return started;
  });
}

export async function failSubmissionPreparation(
  database: DatabaseHandle,
  actor: ActorContext,
  preparationId: string,
  error: unknown,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const current = await lockPreparation(
      transaction,
      actor,
      preparationId,
    );
    if (current.status === "complete") {
      await appendAuditEntry(transaction, actor, {
        projectId: current.project_id,
        action: "submission.preparation-verification-failed",
        entityType: "submission-preparation",
        entityId: preparationId,
        after: auditPreparation(current),
        metadata: { error: errorMessage(error) },
      });
      return;
    }
    const failed = await transaction.one<SubmissionPreparationRow>(
      `
        UPDATE submission_preparations
        SET status = 'failed',
            last_error = $1,
            version = version + 1
        WHERE id = $2 AND status <> 'complete'
        RETURNING *
      `,
      [errorMessage(error), preparationId],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "submission.preparation-failed",
      entityType: "submission-preparation",
      entityId: preparationId,
      before: auditPreparation(current),
      after: auditPreparation(failed),
    });
  });
}

export async function finalizeSubmissionPreparation(
  database: DatabaseHandle,
  actor: ActorContext,
  preparationId: string,
  input: FinalizeSubmissionPreparationInput,
): Promise<SubmissionRow> {
  return database.transaction(async (transaction) => {
    const current = await lockPreparation(
      transaction,
      actor,
      preparationId,
    );
    if (current.status === "complete") {
      return loadCompletedSubmission(transaction, current);
    }
    if (current.status !== "generating") {
      throw new Error("submission-preparation-not-generating");
    }
    const submission = await prepareSubmissionRecordInTransaction(
      transaction,
      actor,
      current.project_id,
      {
        submissionId: current.id,
        reportSnapshotId: current.report_snapshot_id,
        supportingArtifactId: current.supporting_artifact_id,
        manifestArtifactId: current.manifest_artifact_id,
        packageArtifactId: current.package_artifact_id,
        manifest: input.manifest,
      },
      { preparedByUserId: current.prepared_by },
    );
    const complete = await transaction.one<SubmissionPreparationRow>(
      `
        UPDATE submission_preparations
        SET status = 'complete',
            completed_submission_id = $1,
            completed_at = clock_timestamp(),
            last_error = NULL,
            version = version + 1
        WHERE id = $2 AND status = 'generating'
        RETURNING *
      `,
      [submission.id, current.id],
    );
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: "submission.preparation-completed",
      entityType: "submission-preparation",
      entityId: current.id,
      before: auditPreparation(current),
      after: auditPreparation(complete),
    });
    return submission;
  });
}

export async function withSubmissionPreparationLock<T>(
  database: DatabaseHandle,
  preparationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  const lockKey = `ucm:submission-preparation:${preparationId}`;
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
      throw new Error("submission-preparation-in-progress");
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

async function assertPreparationSources(
  transaction: TransactionHandle,
  input: ReserveSubmissionPreparationInput,
): Promise<void> {
  const report = await transaction.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM report_snapshots
      WHERE id = $1 AND project_id = $2
        AND status = 'complete'
        AND mode = 'competition-ready'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            COALESCE(validation_json -> 'issues', '[]'::jsonb)
          ) issue
          WHERE issue ->> 'severity' = 'blocker'
        )
      FOR SHARE
    `,
    [input.reportSnapshotId, input.projectId],
  );
  if (!report) {
    throw new Error("submission-report-not-competition-ready");
  }
  const supporting = await transaction.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM artifacts
      WHERE id = $1 AND project_id = $2
        AND report_snapshot_id = $3
        AND kind = 'supporting-workbook'
        AND status = 'complete'
      FOR SHARE
    `,
    [
      input.supportingArtifactId,
      input.projectId,
      input.reportSnapshotId,
    ],
  );
  if (!supporting) {
    throw new Error("submission-supporting-workbook-invalid");
  }
}

async function lockPreparation(
  transaction: TransactionHandle,
  actor: ActorContext,
  preparationId: string,
): Promise<SubmissionPreparationRow> {
  const preparation =
    await transaction.maybeOne<SubmissionPreparationRow>(
      `
        SELECT *
        FROM submission_preparations
        WHERE id = $1
        FOR UPDATE
      `,
      [preparationId],
    );
  if (!preparation) {
    throw new Error("submission-preparation-not-found");
  }
  await assertProjectPermission(
    transaction,
    actor,
    preparation.project_id,
    "write",
  );
  return preparation;
}

async function loadCompletedSubmission(
  transaction: TransactionHandle,
  preparation: SubmissionPreparationRow,
): Promise<SubmissionRow> {
  if (!preparation.completed_submission_id) {
    throw new Error("submission-preparation-completion-invalid");
  }
  const submission = await transaction.maybeOne<SubmissionRow>(
    "SELECT * FROM submissions WHERE id = $1",
    [preparation.completed_submission_id],
  );
  if (!submission) {
    throw new Error("submission-preparation-completion-invalid");
  }
  return submission;
}

async function lockProject(
  transaction: TransactionHandle,
  projectId: string,
): Promise<void> {
  const project = await transaction.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_000)
    : "Unknown submission preparation error";
}

function auditPreparation(
  preparation: SubmissionPreparationRow,
): Record<string, unknown> {
  return {
    id: preparation.id,
    projectId: preparation.project_id,
    reportSnapshotId: preparation.report_snapshot_id,
    supportingArtifactId: preparation.supporting_artifact_id,
    packageArtifactId: preparation.package_artifact_id,
    manifestArtifactId: preparation.manifest_artifact_id,
    status: preparation.status,
    preparedBy: preparation.prepared_by,
    preparedAt: preparation.prepared_at,
    attemptCount: preparation.attempt_count,
    lastAttemptBy: preparation.last_attempt_by,
    lastAttemptAt: preparation.last_attempt_at,
    lastError: preparation.last_error,
    completedSubmissionId: preparation.completed_submission_id,
    completedAt: preparation.completed_at,
    version: preparation.version,
  };
}
