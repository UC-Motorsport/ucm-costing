import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { QueryResultRow } from "pg";

import { appendAuditEntry } from "../audit/audit-ledger";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import { systemDefinitions } from "../domain/systems";
import { sha256CanonicalJson } from "../security/canonical-json";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";

export interface ProjectSetupConfirmation {
  id: string;
  contentHash: string;
  confirmedAt: string;
  confirmedBy: {
    id: string;
    displayName: string;
    email: string;
  };
  projectVersion: number;
}

export interface ProjectRow extends QueryResultRow {
  id: string;
  name: string;
  season: number;
  vehicle_type: "electric" | "combustion" | "dual";
  entry_number: string;
  status: "draft" | "review" | "submitted";
  rule_source_document_id: string;
  rule_pack_version: string;
  rule_pack_sha256: string;
  catalogue_release_id: string;
  catalogue_revision: string;
  cost_model: "competition-universal-dollar";
  project_summary: string;
  numbering_convention: string;
  bulk_method_summary: string;
  report_setup_confirmed: number;
  report_setup_confirmation: ProjectSetupConfirmation | null;
  focus_systems_json: string;
  is_historical: boolean;
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const projectNameSchema = z.string().trim().min(2).max(120);
const entryNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "Entry number contains unsupported characters");
const projectSummarySchema = z
  .string()
  .trim()
  .min(40)
  .max(12_000)
  .refine((value) => !isPlaceholder(value), "Replace the placeholder cost-management summary");
const numberingConventionSchema = z
  .string()
  .trim()
  .min(10)
  .max(3_000)
  .refine((value) => !isPlaceholder(value), "Replace placeholder numbering convention");
const bulkMethodSummarySchema = z
  .string()
  .trim()
  .min(20)
  .max(8_000)
  .refine((value) => !isPlaceholder(value), "Replace placeholder bulk method summary");

const focusSystemsSchema = z
  .array(z.string().trim().transform((value) => value.toUpperCase()))
  .min(1)
  .max(systemDefinitions.length)
  .transform((values) => [...new Set(values)])
  .refine(
    (values) =>
      values.every((value) =>
        systemDefinitions.some(({ code }) => code === value),
      ),
    "Focus systems contain an unsupported system code",
  );

const updateProjectSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    name: projectNameSchema.optional(),
    season: z.number().int().min(2020).max(2100).optional(),
    vehicleType: z.enum(["electric", "combustion", "dual"]).optional(),
    entryNumber: entryNumberSchema.optional(),
    status: z.enum(["draft", "review"]).optional(),
    ruleSourceDocumentId: z.string().min(1).max(200).optional(),
    catalogueReleaseId: z.string().min(1).max(200).optional(),
    projectSummary: projectSummarySchema.optional(),
    numberingConvention: numberingConventionSchema.optional(),
    bulkMethodSummary: bulkMethodSummarySchema.optional(),
    focusSystems: focusSystemsSchema.optional(),
  })
  .refine(
    ({ expectedVersion: _expectedVersion, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    "At least one workspace field must change",
  );

const confirmSetupSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  attested: z.literal(true),
});

export async function updateProject(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  rawInput: unknown,
): Promise<ProjectRow> {
  const input = updateProjectSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const current = await lockProject(transaction, projectId);
    await assertProjectPermission(
      transaction,
      actor,
      projectId,
      "write",
      { allowSubmitted: current.status === "submitted" },
    );
    assertExpectedVersion(current.version, input.expectedVersion, "Workspace");
    if (current.status === "submitted") {
      if (input.status === undefined) {
        throw new Error("submitted-project-reopen-required");
      }
      const {
        expectedVersion: _expectedVersion,
        status: _status,
        ...otherChanges
      } = input;
      if (
        Object.values(otherChanges).some(
          (value) => value !== undefined,
        )
      ) {
        throw new Error("submitted-project-reopen-only");
      }
    }

    let ruleVersion = current.rule_pack_version;
    let ruleSha256 = current.rule_pack_sha256;
    if (
      input.ruleSourceDocumentId &&
      input.ruleSourceDocumentId !== current.rule_source_document_id
    ) {
      const rule = await resolveRuleSource(
        transaction,
        input.ruleSourceDocumentId,
      );
      ruleVersion = rule.version;
      ruleSha256 = rule.sha256;
    }
    if (
      input.catalogueReleaseId &&
      input.catalogueReleaseId !== current.catalogue_release_id
    ) {
      await resolveCatalogueRelease(transaction, input.catalogueReleaseId);
      const costLineCount = await transaction.one<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM cost_lines cl
          JOIN cost_nodes cn ON cn.id = cl.node_id
          WHERE cn.project_id = $1
        `,
        [projectId],
      );
      if (costLineCount.count > 0) {
        throw new Error("project-catalogue-release-in-use");
      }
    }

    const next = {
      name: input.name ?? current.name,
      season: input.season ?? current.season,
      vehicleType: input.vehicleType ?? current.vehicle_type,
      entryNumber: input.entryNumber ?? current.entry_number,
      status: input.status ?? current.status,
      ruleSourceDocumentId:
        input.ruleSourceDocumentId ?? current.rule_source_document_id,
      ruleVersion,
      ruleSha256,
      catalogueReleaseId:
        input.catalogueReleaseId ?? current.catalogue_release_id,
      projectSummary: input.projectSummary ?? current.project_summary,
      numberingConvention:
        input.numberingConvention ?? current.numbering_convention,
      bulkMethodSummary:
        input.bulkMethodSummary ?? current.bulk_method_summary,
      focusSystems: JSON.stringify(
        withRequiredDrawingFocus(
          input.season ?? current.season,
          input.focusSystems ??
            (JSON.parse(current.focus_systems_json) as string[]),
        ),
      ),
    };
    const setupChanged =
      next.season !== current.season ||
      next.vehicleType !== current.vehicle_type ||
      next.entryNumber !== current.entry_number ||
      next.ruleSourceDocumentId !== current.rule_source_document_id ||
      next.ruleVersion !== current.rule_pack_version ||
      next.ruleSha256 !== current.rule_pack_sha256 ||
      next.catalogueReleaseId !== current.catalogue_release_id ||
      next.projectSummary !== current.project_summary ||
      next.numberingConvention !== current.numbering_convention ||
      next.bulkMethodSummary !== current.bulk_method_summary ||
      next.focusSystems !== current.focus_systems_json;

    const updatedResult = await transaction.query<{ id: string }>(
      `
        UPDATE projects
        SET name = $1, season = $2, vehicle_type = $3, entry_number = $4,
            status = $5, rule_source_document_id = $6,
            rule_pack_version = $7, rule_pack_sha256 = $8,
            catalogue_release_id = $9, project_summary = $10,
            numbering_convention = $11, bulk_method_summary = $12,
            focus_systems_json = $13::jsonb,
            updated_by = $14, updated_at = now(), version = version + 1
        WHERE id = $15 AND version = $16
        RETURNING id
      `,
      [
        next.name,
        next.season,
        next.vehicleType,
        next.entryNumber,
        next.status,
        next.ruleSourceDocumentId,
        next.ruleVersion,
        next.ruleSha256,
        next.catalogueReleaseId,
        next.projectSummary,
        next.numberingConvention,
        next.bulkMethodSummary,
        next.focusSystems,
        actor.actorUserId,
        projectId,
        input.expectedVersion,
      ],
    );
    if (updatedResult.rowCount !== 1) {
      throw new VersionConflictError("Workspace changed while saving");
    }
    if (setupChanged) {
      await invalidateSetupConfirmation(
        transaction,
        projectId,
        actor.actorUserId,
        "report-setup-fields-changed",
      );
    }
    const updated = await getProjectRow(transaction, projectId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "project.updated",
      entityType: "project",
      entityId: projectId,
      before: auditProjectState(current),
      after: auditProjectState(updated),
      metadata: { reportSetupConfirmationInvalidated: setupChanged },
    });
    return updated;
  });
}

export async function confirmProjectSetup(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  rawInput: unknown,
): Promise<ProjectRow> {
  const input = confirmSetupSchema.parse(rawInput);

  return database.transaction(async (transaction) => {
    const current = await lockProject(transaction, projectId);
    await assertProjectPermission(transaction, actor, projectId, "write");
    assertExpectedVersion(current.version, input.expectedVersion, "Workspace");
    const setup = {
      projectSummary: projectSummarySchema.parse(current.project_summary),
      numberingConvention: numberingConventionSchema.parse(
        current.numbering_convention,
      ),
      bulkMethodSummary: bulkMethodSummarySchema.parse(
        current.bulk_method_summary,
      ),
    };
    const contentHash = sha256CanonicalJson(setup);
    await invalidateSetupConfirmation(
      transaction,
      projectId,
      actor.actorUserId,
      "superseded-by-new-confirmation",
    );
    const confirmationId = randomUUID();
    await transaction.query(
      `
        INSERT INTO project_setup_confirmations(
          id, project_id, project_version, setup_json, content_hash,
          confirmed_by, confirmed_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
      `,
      [
        confirmationId,
        projectId,
        current.version + 1,
        JSON.stringify(setup),
        contentHash,
        actor.actorUserId,
      ],
    );
    const projectUpdate = await transaction.query(
      `
        UPDATE projects
        SET updated_by = $1, updated_at = now(), version = version + 1
        WHERE id = $2 AND version = $3
        RETURNING id
      `,
      [actor.actorUserId, projectId, current.version],
    );
    if (projectUpdate.rowCount !== 1) {
      throw new VersionConflictError("Workspace changed while confirming setup");
    }
    const confirmed = await getProjectRow(transaction, projectId);
    await appendAuditEntry(transaction, actor, {
      projectId,
      action: "project.report-setup-confirmed",
      entityType: "project-setup-confirmation",
      entityId: confirmationId,
      before: null,
      after: {
        contentHash,
        projectVersion: confirmed.version,
        confirmedBy: actor.actorUserId,
      },
    });
    return confirmed;
  });
}

export async function getProjectRow(
  database: DbExecutor,
  projectId: string,
): Promise<ProjectRow> {
  const row = await database.maybeOne<ProjectRow>(
    `
      ${PROJECT_SELECT}
      WHERE p.id = $1
    `,
    [projectId],
  );
  if (!row) {
    throw new Error("project-not-found");
  }
  return row;
}

export async function listActiveProjects(
  database: DbExecutor,
): Promise<ProjectRow[]> {
  const result = await database.query<ProjectRow>(
    `
      ${PROJECT_SELECT}
      WHERE p.archived_at IS NULL
      ORDER BY p.season DESC, lower(p.name), p.id
    `,
  );
  return result.rows;
}

export class VersionConflictError extends Error {
  readonly code = "version-conflict";

  constructor(message: string) {
    super(message);
  }
}

const PROJECT_SELECT = `
  SELECT
    p.id, p.name, p.season, p.vehicle_type, p.entry_number, p.status,
    p.rule_source_document_id, p.rule_pack_version, p.rule_pack_sha256,
    p.catalogue_release_id, cr.revision_code AS catalogue_revision,
    p.cost_model, p.project_summary, p.numbering_convention,
    p.bulk_method_summary, p.focus_systems_json::text AS focus_systems_json,
    p.is_historical, p.archived_at, p.created_by, p.updated_by, p.version,
    p.created_at, p.updated_at,
    CASE WHEN confirmation.id IS NULL THEN 0 ELSE 1 END::int
      AS report_setup_confirmed,
    CASE
      WHEN confirmation.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id', confirmation.id,
        'contentHash', confirmation.content_hash,
        'confirmedAt', confirmation.confirmed_at,
        'projectVersion', confirmation.project_version,
        'confirmedBy', jsonb_build_object(
          'id', confirmer.id,
          'displayName', confirmer.display_name,
          'email', confirmer.email
        )
      )
    END AS report_setup_confirmation
  FROM projects p
  JOIN catalogue_releases cr ON cr.id = p.catalogue_release_id
  LEFT JOIN LATERAL (
    SELECT psc.*
    FROM project_setup_confirmations psc
    WHERE psc.project_id = p.id AND psc.invalidated_at IS NULL
    ORDER BY psc.confirmed_at DESC, psc.id DESC
    LIMIT 1
  ) confirmation ON true
  LEFT JOIN users confirmer ON confirmer.id = confirmation.confirmed_by
`;

async function lockProject(
  transaction: TransactionHandle,
  projectId: string,
): Promise<ProjectRow> {
  const lock = await transaction.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
    [projectId],
  );
  if (!lock) {
    throw new Error("project-not-found");
  }
  return await getProjectRow(transaction, projectId);
}

async function resolveRuleSource(
  database: DbExecutor,
  sourceDocumentId: string,
): Promise<{ version: string; sha256: string }> {
  const row = await database.maybeOne<{ version: string; sha256: string }>(
    `
      SELECT version, sha256
      FROM source_documents
      WHERE id = $1 AND kind = 'governing-rule'
    `,
    [sourceDocumentId],
  );
  if (!row) {
    throw new Error("rule-source-not-found");
  }
  return row;
}

async function resolveCatalogueRelease(
  database: DbExecutor,
  catalogueReleaseId: string,
): Promise<{ revision_code: string }> {
  const row = await database.maybeOne<{ revision_code: string }>(
    `
      SELECT revision_code
      FROM catalogue_releases
      WHERE id = $1
    `,
    [catalogueReleaseId],
  );
  if (!row) {
    throw new Error("catalogue-release-not-found");
  }
  return row;
}

async function invalidateSetupConfirmation(
  transaction: TransactionHandle,
  projectId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  await transaction.query(
    `
      UPDATE project_setup_confirmations
      SET invalidated_at = now(), invalidated_by = $1,
          invalidation_reason = $2
      WHERE project_id = $3 AND invalidated_at IS NULL
    `,
    [actorUserId, reason, projectId],
  );
}

function assertExpectedVersion(
  actual: number,
  expected: number,
  entityName: string,
): void {
  if (actual !== expected) {
    throw new VersionConflictError(
      `${entityName} changed from version ${expected} to ${actual}`,
    );
  }
}

function auditProjectState(project: ProjectRow): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    season: project.season,
    vehicleType: project.vehicle_type,
    entryNumber: project.entry_number,
    status: project.status,
    ruleSourceDocumentId: project.rule_source_document_id,
    rulePackVersion: project.rule_pack_version,
    rulePackSha256: project.rule_pack_sha256,
    catalogueReleaseId: project.catalogue_release_id,
    catalogueRevision: project.catalogue_revision,
    projectSummary: project.project_summary,
    numberingConvention: project.numbering_convention,
    bulkMethodSummary: project.bulk_method_summary,
    focusSystems: JSON.parse(project.focus_systems_json) as unknown,
    isHistorical: project.is_historical,
    archivedAt: project.archived_at,
    version: project.version,
  };
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^(todo|tbd|test|demo|placeholder|replace me)[.!]?$/.test(normalized) ||
    normalized.includes("mvp seed is deliberately incomplete") ||
    normalized.includes("synthetic demonstration vehicle")
  );
}

function withRequiredDrawingFocus(
  season: number,
  focusSystems: readonly string[],
): string[] {
  if (season !== 2026 || focusSystems.includes("DR")) {
    return [...focusSystems];
  }
  return ["DR", ...focusSystems];
}
