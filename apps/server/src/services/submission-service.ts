import { randomUUID } from "node:crypto";

import {
  assertSubmissionTransition,
  type SubmissionState,
} from "@ucm/domain";
import type { QueryResultRow } from "pg";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";

export interface SubmissionRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: SubmissionState;
  report_snapshot_id: string;
  cost_amendment_id: string | null;
  supporting_artifact_id: string;
  amendment_artifact_id: string | null;
  manifest_artifact_id: string;
  package_artifact_id: string;
  manifest_json: Record<string, unknown>;
  external_reference: string | null;
  prepared_by: string;
  exported_by: string | null;
  submitted_by: string | null;
  prepared_at: string;
  exported_at: string | null;
  submitted_at: string | null;
  version: number;
}

const prepareSubmissionSchema = z.object({
  submissionId: z.string().trim().min(1).default(() => randomUUID()),
  reportSnapshotId: z.string().trim().min(1),
  costAmendmentId: z.string().trim().min(1).nullable().optional(),
  supportingArtifactId: z.string().trim().min(1),
  amendmentArtifactId: z.string().trim().min(1).nullable().optional(),
  manifestArtifactId: z.string().trim().min(1),
  packageArtifactId: z.string().trim().min(1),
  manifest: z.record(z.string(), z.unknown()),
});

/**
 * Transactional boundary used by durable preparation orchestration. Keeping
 * submission insertion here lets the orchestration row and submission record
 * commit atomically.
 */
export async function prepareSubmissionRecordInTransaction(
  transaction: TransactionHandle,
  actor: ActorContext,
  projectId: string,
  rawInput: unknown,
  options: { preparedByUserId?: string } = {},
): Promise<SubmissionRow> {
  const input = prepareSubmissionSchema.parse(rawInput);
  await assertProjectPermission(
    transaction,
    actor,
    projectId,
    "write",
  );
  const report = await transaction.maybeOne<{
    id: string;
    mode: "draft" | "deadline" | "competition-ready" | "export";
    validation_json: {
      issues?: Array<{ severity?: string }>;
    };
  }>(
    `
      SELECT id, mode, validation_json
      FROM report_snapshots
      WHERE id = $1 AND project_id = $2 AND status = 'complete'
      FOR SHARE
    `,
    [input.reportSnapshotId, projectId],
  );
  if (!report) {
    throw new Error("submission-report-not-complete");
  }
  if (
    report.mode !== "competition-ready" ||
    report.validation_json.issues?.some(
      ({ severity }) => severity === "blocker",
    )
  ) {
    throw new Error("submission-report-not-competition-ready");
  }
  await assertArtifact(
    transaction,
    input.supportingArtifactId,
    projectId,
    input.reportSnapshotId,
    "supporting-workbook",
  );
  await assertArtifact(
    transaction,
    input.manifestArtifactId,
    projectId,
    input.reportSnapshotId,
    "submission-manifest",
  );
  await assertArtifact(
    transaction,
    input.packageArtifactId,
    projectId,
    input.reportSnapshotId,
    "submission-package",
  );
  if (
    Boolean(input.costAmendmentId) !==
    Boolean(input.amendmentArtifactId)
  ) {
    throw new Error("submission-amendment-pair-required");
  }
  if (input.costAmendmentId && input.amendmentArtifactId) {
    const amendment = await transaction.maybeOne<{ id: string }>(
      `
        SELECT id
        FROM cost_amendments
        WHERE id = $1 AND project_id = $2
          AND base_report_snapshot_id = $3
          AND status IN ('locked', 'exported')
        FOR SHARE
      `,
      [
        input.costAmendmentId,
        projectId,
        input.reportSnapshotId,
      ],
    );
    if (!amendment) {
      throw new Error("submission-cost-amendment-not-locked");
    }
    await assertArtifact(
      transaction,
      input.amendmentArtifactId,
      projectId,
      input.reportSnapshotId,
      "cost-amendment",
    );
  }
  assertManifestIdentity(
    input.manifest,
    input.submissionId,
    projectId,
    input.reportSnapshotId,
  );
  const prepared = await transaction.one<SubmissionRow>(
    `
      INSERT INTO submissions(
        id, project_id, status, report_snapshot_id,
        cost_amendment_id, supporting_artifact_id,
        amendment_artifact_id, manifest_artifact_id,
        package_artifact_id, manifest_json, prepared_by
      )
      VALUES (
        $1, $2, 'prepared', $3,
        $4, $5,
        $6, $7,
        $8, $9::jsonb, $10
      )
      RETURNING *
    `,
    [
      input.submissionId,
      projectId,
      input.reportSnapshotId,
      input.costAmendmentId ?? null,
      input.supportingArtifactId,
      input.amendmentArtifactId ?? null,
      input.manifestArtifactId,
      input.packageArtifactId,
      JSON.stringify(input.manifest),
      options.preparedByUserId ?? actor.actorUserId,
    ],
  );
  await appendAuditEntry(transaction, actor, {
    projectId,
    action: "submission.prepared",
    entityType: "submission",
    entityId: prepared.id,
    after: auditSubmission(prepared),
  });
  return prepared;
}

export async function markSubmissionExported(
  database: DatabaseHandle,
  actor: ActorContext,
  submissionId: string,
  expectedVersion: number,
): Promise<SubmissionRow> {
  return await transitionSubmission(
    database,
    actor,
    submissionId,
    expectedVersion,
    "exported",
    null,
  );
}

export async function recordManualSubmission(
  database: DatabaseHandle,
  actor: ActorContext,
  submissionId: string,
  expectedVersion: number,
  externalReference: string,
): Promise<SubmissionRow> {
  return await transitionSubmission(
    database,
    actor,
    submissionId,
    expectedVersion,
    "manually-submitted",
    externalReference,
  );
}

export async function getSubmission(
  database: DbExecutor,
  actor: ActorContext,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const submission = await database.maybeOne<SubmissionRow>(
    "SELECT * FROM submissions WHERE id = $1",
    [submissionId],
  );
  if (submission) {
    await assertProjectPermission(
      database,
      actor,
      submission.project_id,
      "read",
    );
  }
  return submission;
}

export async function listSubmissions(
  database: DbExecutor,
  actor: ActorContext,
  projectId: string,
  limit = 100,
  offset = 0,
): Promise<SubmissionRow[]> {
  await assertProjectPermission(database, actor, projectId, "read");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid-submission-pagination");
  }
  const result = await database.query<SubmissionRow>(
    `
      SELECT *
      FROM submissions
      WHERE project_id = $1
      ORDER BY prepared_at DESC, id
      LIMIT $2 OFFSET $3
    `,
    [projectId, limit, offset],
  );
  return result.rows;
}

async function transitionSubmission(
  database: DatabaseHandle,
  actor: ActorContext,
  submissionId: string,
  expectedVersion: number,
  next: Exclude<SubmissionState, "prepared">,
  externalReference: string | null,
): Promise<SubmissionRow> {
  return await database.transaction(async (transaction) => {
    const current = await transaction.maybeOne<SubmissionRow>(
      "SELECT * FROM submissions WHERE id = $1 FOR UPDATE",
      [submissionId],
    );
    if (!current) {
      throw new Error("submission-not-found");
    }
    await lockProjectForSubmission(
      transaction,
      current.project_id,
    );
    await assertProjectPermission(
      transaction,
      actor,
      current.project_id,
      "write",
    );
    if (current.version !== expectedVersion) {
      throw new Error("submission-version-conflict");
    }
    assertSubmissionTransition(
      current.status,
      next,
      externalReference,
    );
    if (next === "manually-submitted") {
      await assertNoMutableProjectWorkflows(
        transaction,
        current.project_id,
      );
    }
    const updated = await transaction.maybeOne<SubmissionRow>(
      `
        UPDATE submissions
        SET status = $1,
            external_reference = CASE
              WHEN $2::text IS NULL THEN external_reference
              ELSE $2
            END,
            exported_by = CASE
              WHEN $1 = 'exported' THEN $3
              ELSE exported_by
            END,
            exported_at = CASE
              WHEN $1 = 'exported' THEN clock_timestamp()
              ELSE exported_at
            END,
            submitted_by = CASE
              WHEN $1 = 'manually-submitted' THEN $3
              ELSE submitted_by
            END,
            submitted_at = CASE
              WHEN $1 = 'manually-submitted' THEN clock_timestamp()
              ELSE submitted_at
            END,
            version = version + 1
        WHERE id = $4 AND version = $5
        RETURNING *
      `,
      [
        next,
        externalReference,
        actor.actorUserId,
        submissionId,
        expectedVersion,
      ],
    );
    if (!updated) {
      throw new Error("submission-version-conflict");
    }
    if (next === "manually-submitted") {
      await markProjectSubmitted(
        transaction,
        actor,
        current.project_id,
        submissionId,
      );
    }
    await appendAuditEntry(transaction, actor, {
      projectId: current.project_id,
      action: `submission.${next}`,
      entityType: "submission",
      entityId: submissionId,
      before: auditSubmission(current),
      after: auditSubmission(updated),
    });
    return updated;
  });
}

async function lockProjectForSubmission(
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

async function assertNoMutableProjectWorkflows(
  transaction: TransactionHandle,
  projectId: string,
): Promise<void> {
  const mutable = await transaction.one<{ present: boolean }>(
    `
      SELECT (
        EXISTS (
          SELECT 1
          FROM report_snapshots
          WHERE project_id = $1 AND status = 'rendering'
        )
        OR EXISTS (
          SELECT 1
          FROM artifacts
          WHERE project_id = $1 AND status = 'reserved'
        )
        OR EXISTS (
          SELECT 1
          FROM submission_preparations
          WHERE project_id = $1 AND status <> 'complete'
        )
      ) AS present
    `,
    [projectId],
  );
  if (mutable.present) {
    throw new Error("project-submission-workflows-in-progress");
  }
}

async function markProjectSubmitted(
  transaction: TransactionHandle,
  actor: ActorContext,
  projectId: string,
  submissionId: string,
): Promise<void> {
  const before = await transaction.maybeOne<{
    status: "draft" | "review" | "submitted";
    version: number;
    updated_by: string | null;
    updated_at: string;
  }>(
    `
      SELECT status, version, updated_by, updated_at
      FROM projects
      WHERE id = $1
      FOR UPDATE
    `,
    [projectId],
  );
  if (!before) {
    throw new Error("project-not-found");
  }
  if (before.status === "submitted") {
    return;
  }
  const after = await transaction.one<{
    status: "submitted";
    version: number;
    updated_by: string;
    updated_at: string;
  }>(
    `
      UPDATE projects
      SET status = 'submitted',
          updated_by = $1,
          updated_at = clock_timestamp(),
          version = version + 1
      WHERE id = $2 AND status <> 'submitted'
      RETURNING status, version, updated_by, updated_at
    `,
    [actor.actorUserId, projectId],
  );
  await appendAuditEntry(transaction, actor, {
    projectId,
    action: "project.status-changed-by-submission",
    entityType: "project",
    entityId: projectId,
    before: {
      status: before.status,
      version: before.version,
      updatedBy: before.updated_by,
      updatedAt: before.updated_at,
    },
    after: {
      status: after.status,
      version: after.version,
      updatedBy: after.updated_by,
      updatedAt: after.updated_at,
    },
    metadata: { submissionId },
  });
}

async function assertArtifact(
  database: TransactionHandle,
  artifactId: string,
  projectId: string,
  reportSnapshotId: string,
  kind: string,
): Promise<void> {
  const artifact = await database.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM artifacts
      WHERE id = $1 AND project_id = $2
        AND report_snapshot_id = $3
        AND kind = $4 AND status = 'complete'
      FOR SHARE
    `,
    [artifactId, projectId, reportSnapshotId, kind],
  );
  if (!artifact) {
    throw new Error(`submission-artifact-not-complete:${kind}`);
  }
}

function assertManifestIdentity(
  manifest: Record<string, unknown>,
  submissionId: string,
  projectId: string,
  reportSnapshotId: string,
): void {
  const project =
    typeof manifest.project === "object" &&
    manifest.project !== null
      ? (manifest.project as Record<string, unknown>)
      : null;
  if (
    manifest.submissionId !== submissionId ||
    manifest.reportSnapshotId !== reportSnapshotId ||
    project?.id !== projectId ||
    manifest.state !== "prepared"
  ) {
    throw new Error("submission-manifest-identity-mismatch");
  }
  const external =
    typeof manifest.externalSubmission === "object" &&
    manifest.externalSubmission !== null
      ? (manifest.externalSubmission as Record<string, unknown>)
      : null;
  if (
    external?.transmittedByApplication !== false ||
    external.status !== "not-recorded"
  ) {
    throw new Error("submission-manifest-external-state-invalid");
  }
}

function auditSubmission(
  submission: SubmissionRow,
): Record<string, unknown> {
  return {
    id: submission.id,
    projectId: submission.project_id,
    status: submission.status,
    reportSnapshotId: submission.report_snapshot_id,
    costAmendmentId: submission.cost_amendment_id,
    supportingArtifactId: submission.supporting_artifact_id,
    amendmentArtifactId: submission.amendment_artifact_id,
    manifestArtifactId: submission.manifest_artifact_id,
    packageArtifactId: submission.package_artifact_id,
    externalReference: submission.external_reference,
    preparedBy: submission.prepared_by,
    exportedBy: submission.exported_by,
    submittedBy: submission.submitted_by,
    preparedAt: submission.prepared_at,
    exportedAt: submission.exported_at,
    submittedAt: submission.submitted_at,
    version: submission.version,
  };
}
