import type { QueryResultRow } from "pg";

import { appendAuditEntry } from "../audit/audit-ledger";
import {
  LOCAL_ADDENDUM_SHA256,
  LOCAL_ADDENDUM_VERSION,
} from "../config";
import type {
  DatabaseHandle,
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import { systemDefinitions } from "../domain/systems";
import {
  CATALOGUE_RELEASE_ID,
  OFFICIAL_RULE_DOCUMENT_ID,
  stableSeedUuid,
} from "./reference-data-service";

export const TEAM_WORKSPACE_ID = stableSeedUuid(
  "workspace:uc-motorsport:2026",
);

const TEAM_VEHICLE_ID = stableSeedUuid(
  "workspace:uc-motorsport:2026:vehicle",
);
const WORKSPACE_LOCK = "ucm:team-workspaces";

interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  season: number;
  vehicle_type: "electric" | "combustion" | "dual";
  entry_number: string;
  is_historical: boolean;
  archived_at: string | null;
  status: "draft" | "review" | "submitted";
}

export interface CreateSeasonWorkspaceInput {
  id?: string;
  name: string;
  season: number;
  vehicleType: "electric" | "combustion" | "dual";
  entryNumber: string;
  isHistorical?: boolean;
  createdBy?: string | null;
  projectSummary?: string;
  numberingConvention?: string;
  bulkMethodSummary?: string;
  focusSystems?: readonly string[];
  ruleSourceDocumentId?: string;
  rulePackVersion?: string;
  rulePackSha256?: string;
  catalogueReleaseId?: string;
  createHierarchy?: boolean;
}

export interface WorkspaceProvisionResult {
  id: string;
  created: boolean;
}

export async function ensureTeamWorkspace(
  database: DatabaseHandle,
): Promise<WorkspaceProvisionResult> {
  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [WORKSPACE_LOCK],
    );
    const projects = await transaction.query<WorkspaceRow>(
      `
        SELECT id, name, season, vehicle_type, entry_number,
               is_historical, archived_at, status
        FROM projects
        WHERE archived_at IS NULL AND is_historical = false
        ORDER BY season DESC, created_at, id
        FOR UPDATE
      `,
    );

    const existing = projects.rows[0];
    if (existing) {
      await ensureWorkspaceHierarchy(transaction, existing.id);
      return { id: existing.id, created: false };
    }

    await assertPinnedReferencesExist(transaction);
    const workspaceId = await createSeasonWorkspaceRecord(transaction, {
      id: TEAM_WORKSPACE_ID,
      name: "UC Motorsport 2026",
      season: 2026,
      vehicleType: "electric",
      entryNumber: "E13",
      focusSystems: ["DR"],
    });
    await appendAuditEntry(
      transaction,
      {
        actorUserId: null,
        requestId: "startup:team-workspace-provision",
      },
      {
        projectId: workspaceId,
        action: "workspace.provisioned",
        entityType: "workspace",
        entityId: workspaceId,
        after: {
          season: 2026,
          vehicleType: "electric",
          entryNumber: "E13",
          standardSystemCount: systemDefinitions.length,
        },
      },
    );
    return { id: workspaceId, created: true };
  });
}

export async function getTeamWorkspaceId(
  database: DbExecutor,
): Promise<string> {
  const projects = await database.query<{ id: string }>(
    `
      SELECT id
      FROM projects
      WHERE archived_at IS NULL AND is_historical = false
      ORDER BY season DESC, created_at, id
      LIMIT 1
    `,
  );
  if (projects.rows.length === 0) {
    throw new Error("workspace-not-provisioned");
  }
  return projects.rows[0]!.id;
}

export async function createSeasonWorkspaceRecord(
  transaction: TransactionHandle,
  input: CreateSeasonWorkspaceInput,
): Promise<string> {
  await assertPinnedReferencesExist(transaction);
  const id =
    input.id ??
    stableSeedUuid(`workspace:uc-motorsport:${input.season}`);
  await transaction.query(
    `
      INSERT INTO projects(
        id, name, season, vehicle_type, entry_number, status,
        rule_source_document_id, rule_pack_version, rule_pack_sha256,
        catalogue_release_id, cost_model, project_summary,
        numbering_convention, bulk_method_summary, focus_systems_json,
        is_historical, archived_at, created_by, updated_by,
        created_at, updated_at, version
      )
      VALUES (
        $1, $2, $3, $4, $5, 'draft',
        $6, $7, $8, $9, 'competition-universal-dollar', $10, $11, $12,
        $13::jsonb, $14, NULL, $15, $15, now(), now(), 0
      )
    `,
    [
      id,
      input.name,
      input.season,
      input.vehicleType,
      input.entryNumber,
      input.ruleSourceDocumentId ?? OFFICIAL_RULE_DOCUMENT_ID,
      input.rulePackVersion ?? LOCAL_ADDENDUM_VERSION,
      input.rulePackSha256 ?? LOCAL_ADDENDUM_SHA256,
      input.catalogueReleaseId ?? CATALOGUE_RELEASE_ID,
      input.projectSummary ?? "",
      input.numberingConvention ?? "",
      input.bulkMethodSummary ?? "",
      JSON.stringify(input.focusSystems ?? ["DR"]),
      input.isHistorical ?? false,
      input.createdBy ?? null,
    ],
  );
  if (input.createHierarchy !== false) {
    await ensureWorkspaceHierarchy(transaction, id);
  }
  return id;
}

async function assertPinnedReferencesExist(
  database: DbExecutor,
): Promise<void> {
  const references = await database.one<{
    rule_exists: boolean;
    catalogue_exists: boolean;
  }>(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM source_documents
          WHERE id = $1 AND kind = 'governing-rule'
        ) AS rule_exists,
        EXISTS (
          SELECT 1
          FROM catalogue_releases
          WHERE id = $2
        ) AS catalogue_exists
    `,
    [OFFICIAL_RULE_DOCUMENT_ID, CATALOGUE_RELEASE_ID],
  );
  if (!references.rule_exists || !references.catalogue_exists) {
    throw new Error("workspace-pinned-references-missing");
  }
}

export async function ensureWorkspaceHierarchy(
  transaction: TransactionHandle,
  workspaceId: string,
): Promise<void> {
  const workspace = await transaction.maybeOne<WorkspaceRow>(
    `
      SELECT id, name, season, vehicle_type, entry_number,
             is_historical, archived_at, status
      FROM projects
      WHERE id = $1
    `,
    [workspaceId],
  );
  if (!workspace) {
    throw new Error("project-not-found");
  }
  const vehicles = await transaction.query<{ id: string }>(
    `
      SELECT id
      FROM cost_nodes
      WHERE project_id = $1 AND kind = 'vehicle'
      ORDER BY created_at, id
      FOR UPDATE
    `,
    [workspaceId],
  );
  if (vehicles.rows.length > 1) {
    throw new Error("single-workspace-vehicle-root-invariant-violated");
  }

  let vehicleId = vehicles.rows[0]?.id;
  if (!vehicleId) {
    vehicleId =
      workspace.season === 2026 && workspaceId === TEAM_WORKSPACE_ID
        ? TEAM_VEHICLE_ID
        : stableSeedUuid(
            `workspace:uc-motorsport:${workspace.season}:vehicle`,
          );
    const seasonShort = String(workspace.season).slice(-2);
    const vehicleLabel =
      workspace.vehicle_type === "electric"
        ? "Electric Vehicle"
        : workspace.vehicle_type === "combustion"
          ? "Combustion Vehicle"
          : "Dual-Powertrain Vehicle";
    await transaction.query(
      `
        INSERT INTO cost_nodes(
          id, project_id, parent_id, kind, system_code, reference_id,
          full_number, name, description, procurement_type, quantity,
          internal_note, sort_order, version, created_at, updated_at
        )
        VALUES (
          $1, $2, NULL, 'vehicle', NULL, $3,
          $4, $5, $6,
          'made', 1, '', 0, 0, now(), now()
        )
      `,
      [
        vehicleId,
        workspaceId,
        `UCM${seasonShort}`,
        `${workspace.entry_number}-${seasonShort}-UCM-000000-A`,
        `UCM ${workspace.season} ${vehicleLabel}`,
        `Formula SAE-Australasia ${workspace.season} competition vehicle`,
      ],
    );
  }

  const seasonShort = String(workspace.season).slice(-2);
  for (const [sortOrder, system] of systemDefinitions.entries()) {
    await transaction.query(
      `
        INSERT INTO cost_nodes(
          id, project_id, parent_id, kind, system_code, reference_id,
          full_number, name, description, procurement_type, quantity,
          internal_note, sort_order, version, created_at, updated_at
        )
        SELECT
          $1, $2, $3, 'system', $4, $4,
          $5 || '-' || $6 || '-' || $4 || '-000000-A', $7, $7 || ' system',
          'made', 1, '', $8, 0, now(), now()
        WHERE NOT EXISTS (
          SELECT 1
          FROM cost_nodes
          WHERE project_id = $2 AND kind = 'system' AND system_code = $4
        )
      `,
      [
        stableSeedUuid(
          `workspace:uc-motorsport:${workspace.season}:system:${system.code}`,
        ),
        workspaceId,
        vehicleId,
        system.code,
        workspace.entry_number,
        seasonShort,
        system.name,
        sortOrder,
      ],
    );
  }
}
