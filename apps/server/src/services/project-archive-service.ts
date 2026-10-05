import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { canCreateChild } from "@ucm/domain";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import {
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../config";
import type { DatabaseHandle, DbExecutor } from "../db/database";
import { canonicalJson, sha256CanonicalJson } from "../security/canonical-json";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import { getProjectRow } from "./project-lifecycle-service";
import type { CostLineRow, NodeRow } from "./project-types";
import { createSeasonWorkspaceRecord } from "./workspace-service";

// ZIP stores a local DOS timestamp and cannot represent a local year before
// 1980. Construct this in local time so negative UTC offsets do not turn the
// minimum timestamp into December 31, 1979 inside fflate.
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0, 0);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_002;
const MAX_EVIDENCE_FILE_BYTES = 100 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const archiveNodeSchema = z.object({
  sourceId: z.string().min(1).max(200),
  sourceParentId: z.string().min(1).max(200).nullable(),
  kind: z.enum(["vehicle", "system", "assembly", "subassembly", "part"]),
  systemCode: z.string().max(30).nullable(),
  rawHla: z.string().max(200).nullable(),
  rawSubassembly: z.string().max(200).nullable(),
  rawPartNumber: z.string().max(200).nullable(),
  referenceId: z.string().max(200).nullable(),
  fullNumber: z.string().max(300).nullable(),
  name: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  revision: z.string().max(100).nullable(),
  procurementType: z.enum(["made", "bought", "unknown"]),
  quantity: z.string().min(1).max(100),
  internalNote: z.string().max(50_000),
  drawingRequired: z.boolean().default(true),
  workStatus: z.enum(["none", "needs-attention", "done"]).default("none"),
  flagComment: z.string().max(2_000).default(""),
  imageRequired: z.boolean().default(true),
  imageRequirementReason: z.string().max(500).default(""),
  sortOrder: z.number().int().nonnegative(),
});

const archiveCostLineSchema = z.object({
  sourceId: z.string().min(1).max(200),
  sourceNodeId: z.string().min(1).max(200),
  kind: z.enum(["material", "process", "fastener", "tooling"]),
  catalogueItemId: z.string().min(1).max(200).nullable(),
  description: z.string().trim().min(1).max(10_000),
  useDescription: z.string().max(10_000),
  unitCost: z.string().min(1).max(100),
  quantity: z.string().min(1).max(100),
  multiplier: z.string().min(1).max(100),
  multiplierName: z.string().max(500).nullable(),
  multiplierCatalogueItemId: z.string().min(1).max(200).nullable(),
  fractionIncluded: z.string().min(1).max(100),
  productionVolumeFactor: z.string().min(1).max(100).nullable(),
  sizeInputs: z.record(z.string(), z.unknown()),
  calculation: z.record(z.string(), z.unknown()),
  subtotal: z.string().min(1).max(100),
  sortOrder: z.number().int().nonnegative(),
});

const archiveEvidenceSchema = z.object({
  sourceId: z.string().min(1).max(200),
  sourceNodeId: z.string().min(1).max(200).nullable(),
  kind: z.enum([
    "drawing",
    "image",
    "datasheet",
    "manufacturing",
    "bulk-deviation",
    "other",
  ]),
  displayName: z.string().trim().min(1).max(500),
  contentSha256: z.string().regex(SHA256),
  byteSize: z.number().int().nonnegative().max(MAX_EVIDENCE_FILE_BYTES),
  mimeType: z.string().trim().min(1).max(300),
  visibility: z.enum(["internal", "report"]),
  reportCaption: z.string().max(500),
  archivePath: z.string().regex(/^evidence\/[0-9a-f]{64}\.blob$/),
});

const projectArchiveManifestSchema = z.object({
  format: z.literal("ucm-project-archive"),
  schemaVersion: z.literal(1),
  source: z.object({
    projectId: z.string().min(1).max(200),
    projectVersion: z.number().int().nonnegative(),
    projectUpdatedAt: z.string().datetime(),
  }),
  project: z.object({
    name: z.string().trim().min(2).max(120),
    season: z.number().int().min(2020).max(2100),
    vehicleType: z.enum(["electric", "combustion", "dual"]),
    entryNumber: z.string().trim().min(1).max(20),
    isHistorical: z.boolean(),
    projectSummary: z.string().max(12_000),
    numberingConvention: z.string().max(3_000),
    bulkMethodSummary: z.string().max(8_000),
    focusSystems: z.array(z.string().min(1).max(30)).max(100),
  }),
  sources: z.object({
    rule: z.object({ version: z.string(), sha256: z.string().regex(SHA256) }),
    catalogue: z.object({ revision: z.string(), sha256: z.string().regex(SHA256) }),
  }),
  nodes: z.array(archiveNodeSchema).min(1).max(100_000),
  costLines: z.array(archiveCostLineSchema).max(500_000),
  evidence: z.array(archiveEvidenceSchema).max(5_000),
});

const booleanField = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const archiveTargetSchema = z.object({
  targetSeason: z.coerce.number().int().min(2020).max(2100),
  targetName: z.string().trim().min(2).max(120),
  targetEntryNumber: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
  targetIsHistorical: booleanField.default(false),
});

const archiveCommitSchema = archiveTargetSchema.extend({
  expectedArchiveSha256: z.string().regex(SHA256),
  previewHash: z.string().regex(SHA256),
  idempotencyKey: z.string().min(8).max(200),
});

export type ProjectArchiveManifest = z.infer<typeof projectArchiveManifestSchema>;

export interface ProjectArchiveExport {
  bytes: Uint8Array;
  filename: string;
  archiveSha256: string;
  manifestSha256: string;
  manifest: ProjectArchiveManifest;
}

export interface ProjectArchivePreview {
  archiveSha256: string;
  manifestSha256: string;
  previewHash: string;
  source: ProjectArchiveManifest["project"] & { projectId: string };
  target: z.infer<typeof archiveTargetSchema>;
  totals: { nodes: number; costLines: number; evidence: number; evidenceBytes: number };
  conflicts: string[];
  warnings: string[];
}

export interface ProjectArchiveCommitResult {
  importId: string;
  projectId: string;
  season: number;
  createdNodes: number;
  createdCostLines: number;
  createdEvidence: number;
  alreadyImported: boolean;
}

interface ArchiveEvidenceRow {
  id: string;
  node_id: string | null;
  kind: ProjectArchiveManifest["evidence"][number]["kind"];
  display_name: string;
  content_sha256: string;
  byte_size: string | null;
  storage_path: string;
  mime_type: string;
  visibility: "internal" | "report";
  report_caption: string;
}

interface ParsedArchive {
  archiveSha256: string;
  manifestSha256: string;
  manifest: ProjectArchiveManifest;
  entries: Record<string, Uint8Array>;
}

export async function exportProjectArchive(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  projectId: string,
): Promise<ProjectArchiveExport> {
  await assertProjectPermission(database, actor, projectId, "read");
  const project = await getProjectRow(database, projectId);
  const [catalogueSource, nodesResult, linesResult, evidenceResult] =
    await Promise.all([
      database.one<{ sha256: string }>(
        `
          SELECT source.sha256
          FROM catalogue_releases release
          JOIN source_documents source ON source.id = release.source_document_id
          WHERE release.id = $1
        `,
        [project.catalogue_release_id],
      ),
      database.query<NodeRow>(
        `
          SELECT * FROM cost_nodes
          WHERE project_id = $1
          ORDER BY kind, parent_id NULLS FIRST, sort_order, lower(name), id
        `,
        [projectId],
      ),
      database.query<CostLineRow>(
        `
          SELECT
            line.id, line.node_id, line.kind, line.catalogue_item_id,
            line.description, line.use_description, line.unit_cost::text,
            line.quantity::text, line.multiplier::text, line.multiplier_name,
            line.multiplier_catalogue_item_id, line.fraction_included::text,
            line.production_volume_factor::text, line.size_inputs_json::text,
            line.calculation_json::text, line.subtotal::text, line.sort_order,
            line.version, line.created_at, line.updated_at
          FROM cost_lines line
          JOIN cost_nodes node ON node.id = line.node_id
          WHERE node.project_id = $1
          ORDER BY line.node_id, line.kind, line.sort_order, line.id
        `,
        [projectId],
      ),
      database.query<ArchiveEvidenceRow>(
        `
          SELECT id, node_id, kind, display_name, content_sha256,
                 byte_size::text, storage_path, mime_type, visibility,
                 report_caption
          FROM evidence
          WHERE project_id = $1
          ORDER BY node_id NULLS FIRST, kind, display_name, id
        `,
        [projectId],
      ),
    ]);

  const evidenceEntries: Array<[string, Uint8Array]> = [];
  const evidence = [] as ProjectArchiveManifest["evidence"];
  for (const item of evidenceResult.rows) {
    const bytes = await readFile(resolveStoredDataPath(item.storage_path, paths));
    const sha256 = digest(bytes);
    if (sha256 !== item.content_sha256) {
      throw new Error("stored-file-integrity-failed");
    }
    if (item.byte_size !== null && bytes.byteLength !== Number(item.byte_size)) {
      throw new Error("stored-file-byte-size-mismatch");
    }
    if (bytes.byteLength > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error("archive-evidence-file-too-large");
    }
    const archivePath = `evidence/${digest(strToU8(item.id))}.blob`;
    evidenceEntries.push([archivePath, bytes]);
    evidence.push({
      sourceId: item.id,
      sourceNodeId: item.node_id,
      kind: item.kind,
      displayName: item.display_name,
      contentSha256: sha256,
      byteSize: bytes.byteLength,
      mimeType: item.mime_type,
      visibility: item.visibility,
      reportCaption: item.report_caption,
      archivePath,
    });
  }

  const manifest = projectArchiveManifestSchema.parse({
    format: "ucm-project-archive",
    schemaVersion: 1,
    source: {
      projectId: project.id,
      projectVersion: project.version,
      projectUpdatedAt: project.updated_at,
    },
    project: {
      name: project.name,
      season: project.season,
      vehicleType: project.vehicle_type,
      entryNumber: project.entry_number,
      isHistorical: project.is_historical,
      projectSummary: project.project_summary,
      numberingConvention: project.numbering_convention,
      bulkMethodSummary: project.bulk_method_summary,
      focusSystems: JSON.parse(project.focus_systems_json) as unknown,
    },
    sources: {
      rule: { version: project.rule_pack_version, sha256: project.rule_pack_sha256 },
      catalogue: { revision: project.catalogue_revision, sha256: catalogueSource.sha256 },
    },
    nodes: nodesResult.rows.map(nodeForArchive),
    costLines: linesResult.rows.map(costLineForArchive),
    evidence,
  });
  assertManifestIntegrity(manifest);
  const manifestBytes = strToU8(`${canonicalJson(manifest)}\n`);
  const entries: Zippable = {
    "manifest.json": [manifestBytes, archiveEntryOptions()],
  };
  for (const [archivePath, bytes] of evidenceEntries.sort(([a], [b]) => a.localeCompare(b))) {
    entries[archivePath] = [bytes, archiveEntryOptions()];
  }
  const bytes = zipSync(entries, { level: 6, mtime: ZIP_EPOCH });
  return {
    bytes,
    filename: `ucm-${project.season}-${safeFilename(project.name)}.ucm.zip`,
    archiveSha256: digest(bytes),
    manifestSha256: digest(manifestBytes),
    manifest,
  };
}

export async function previewProjectArchive(
  database: DatabaseHandle,
  bytes: Uint8Array,
  rawInput: unknown,
): Promise<ProjectArchivePreview> {
  const target = archiveTargetSchema.parse(rawInput);
  const parsed = parseArchive(bytes);
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const duplicate = await database.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE season = $1 AND archived_at IS NULL",
    [target.targetSeason],
  );
  if (duplicate) conflicts.push(`Season ${target.targetSeason} already exists.`);

  const references = await resolveArchiveReferences(database, parsed.manifest);
  if (!references.ruleSourceDocumentId) {
    conflicts.push("The archive rule source is not installed on this UCM instance.");
  }
  if (!references.catalogueReleaseId) {
    conflicts.push("The archive catalogue release is not installed on this UCM instance.");
  }
  const catalogueIds = uniqueCatalogueIds(parsed.manifest.costLines);
  if (references.catalogueReleaseId && catalogueIds.length > 0) {
    const available = await availableCatalogueIds(
      database,
      references.catalogueReleaseId,
      catalogueIds,
    );
    const missing = catalogueIds.filter((id) => !available.has(id));
    if (missing.length > 0) {
      conflicts.push(`${missing.length} catalogue reference(s) are unavailable.`);
    }
  }
  if (parsed.manifest.project.season !== target.targetSeason) {
    warnings.push(
      `The source season ${parsed.manifest.project.season} will be restored as season ${target.targetSeason}; controlled identifiers are retained exactly and require review.`,
    );
  }
  warnings.push("Reports, submissions, activity history, and setup attestations are intentionally excluded.");
  warnings.push("The restored workspace starts in draft status.");

  const unsigned = {
    archiveSha256: parsed.archiveSha256,
    manifestSha256: parsed.manifestSha256,
    source: {
      ...parsed.manifest.project,
      projectId: parsed.manifest.source.projectId,
    },
    target,
    totals: {
      nodes: parsed.manifest.nodes.length,
      costLines: parsed.manifest.costLines.length,
      evidence: parsed.manifest.evidence.length,
      evidenceBytes: parsed.manifest.evidence.reduce((sum, item) => sum + item.byteSize, 0),
    },
    conflicts,
    warnings,
  };
  return { ...unsigned, previewHash: sha256CanonicalJson(unsigned) };
}

export async function commitProjectArchive(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  bytes: Uint8Array,
  rawInput: unknown,
): Promise<ProjectArchiveCommitResult> {
  const input = archiveCommitSchema.parse(rawInput);
  const archiveSha256 = digest(bytes);
  if (archiveSha256 !== input.expectedArchiveSha256) {
    throw new Error("archive-source-changed");
  }
  const prior = await database.maybeOne<{
    source_sha256: string;
    result_json: ProjectArchiveCommitResult;
  }>(
    "SELECT source_sha256, result_json FROM project_archive_imports WHERE idempotency_key = $1",
    [input.idempotencyKey],
  );
  if (prior) {
    if (prior.source_sha256 !== archiveSha256) {
      throw new Error("archive-idempotency-conflict");
    }
    return { ...prior.result_json, alreadyImported: true };
  }
  const preview = await previewProjectArchive(database, bytes, input);
  if (preview.previewHash !== input.previewHash) throw new Error("archive-preview-stale");
  if (preview.conflicts.length > 0) throw new Error("archive-preview-has-conflicts");

  const parsed = parseArchive(bytes);
  const references = await resolveArchiveReferences(database, parsed.manifest);
  if (!references.ruleSourceDocumentId || !references.catalogueReleaseId) {
    throw new Error("archive-preview-has-conflicts");
  }
  const ruleSourceDocumentId = references.ruleSourceDocumentId;
  const catalogueReleaseId = references.catalogueReleaseId;
  const projectId = randomUUID();
  const nodeIdMap = new Map(parsed.manifest.nodes.map((node) => [node.sourceId, randomUUID()]));
  const stagedEvidence = await stageArchiveEvidence(
    paths,
    projectId,
    parsed,
    nodeIdMap,
  );
  const importId = randomUUID();
  try {
    const result = await database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext('ucm:project-seasons'))");
      const existingImport = await transaction.maybeOne<{
        source_sha256: string;
        result_json: ProjectArchiveCommitResult;
      }>(
        "SELECT source_sha256, result_json FROM project_archive_imports WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      if (existingImport) {
        if (existingImport.source_sha256 !== archiveSha256) {
          throw new Error("archive-idempotency-conflict");
        }
        return { ...existingImport.result_json, alreadyImported: true };
      }
      const duplicate = await transaction.maybeOne<{ id: string }>(
        "SELECT id FROM projects WHERE season = $1 AND archived_at IS NULL FOR UPDATE",
        [input.targetSeason],
      );
      if (duplicate) throw new Error("project-season-already-exists");

      await createSeasonWorkspaceRecord(transaction, {
        id: projectId,
        name: input.targetName,
        season: input.targetSeason,
        vehicleType: parsed.manifest.project.vehicleType,
        entryNumber: input.targetEntryNumber,
        isHistorical: input.targetIsHistorical,
        createdBy: actor.actorUserId,
        projectSummary: parsed.manifest.project.projectSummary,
        numberingConvention: parsed.manifest.project.numberingConvention,
        bulkMethodSummary: parsed.manifest.project.bulkMethodSummary,
        focusSystems: parsed.manifest.project.focusSystems,
        ruleSourceDocumentId,
        rulePackVersion: parsed.manifest.sources.rule.version,
        rulePackSha256: parsed.manifest.sources.rule.sha256,
        catalogueReleaseId,
        createHierarchy: false,
      });

      for (const node of topologicalNodes(parsed.manifest.nodes)) {
        await transaction.query(
          `
            INSERT INTO cost_nodes(
              id, project_id, parent_id, kind, system_code, raw_hla,
              raw_subassembly, raw_part_number, reference_id, full_number,
              name, description, revision, procurement_type, quantity,
              internal_note, sort_order, version, created_at, updated_at, drawing_required, work_status, flag_comment, image_required, image_requirement_reason
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15::numeric, $16, $17, 0, now(), now(), $18, $19, $20, $21, $22
            )
          `,
          [
            nodeIdMap.get(node.sourceId),
            projectId,
            node.sourceParentId ? nodeIdMap.get(node.sourceParentId) : null,
            node.kind,
            node.systemCode,
            node.rawHla,
            node.rawSubassembly,
            node.rawPartNumber,
            node.referenceId,
            node.fullNumber,
            node.name,
            node.description,
            node.revision,
            node.procurementType,
            node.quantity,
            node.internalNote,
            node.sortOrder,
            node.drawingRequired,
            node.workStatus,
            node.flagComment,
            node.imageRequired,
            node.imageRequirementReason,
          ],
        );
      }
      for (const line of parsed.manifest.costLines) {
        await transaction.query(
          `
            INSERT INTO cost_lines(
              id, node_id, kind, catalogue_item_id, description,
              use_description, unit_cost, quantity, multiplier,
              multiplier_name, multiplier_catalogue_item_id,
              fraction_included, production_volume_factor,
              size_inputs_json, calculation_json, subtotal,
              sort_order, version, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric,
              $9::numeric, $10, $11, $12::numeric, $13::numeric,
              $14::jsonb, $15::jsonb, $16::numeric, $17, 0, now(), now()
            )
          `,
          [
            randomUUID(),
            nodeIdMap.get(line.sourceNodeId),
            line.kind,
            line.catalogueItemId,
            line.description,
            line.useDescription,
            line.unitCost,
            line.quantity,
            line.multiplier,
            line.multiplierName,
            line.multiplierCatalogueItemId,
            line.fractionIncluded,
            line.productionVolumeFactor,
            JSON.stringify(line.sizeInputs),
            JSON.stringify(line.calculation),
            line.subtotal,
            line.sortOrder,
          ],
        );
      }
      for (const item of stagedEvidence) {
        await transaction.query(
          `
            INSERT INTO evidence(
              id, node_id, project_id, kind, display_name, content_sha256,
              byte_size, storage_path, mime_type, visibility,
              report_caption, version, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, now(), now())
          `,
          [
            item.id,
            item.targetNodeId,
            projectId,
            item.source.kind,
            item.source.displayName,
            item.source.contentSha256,
            item.source.byteSize,
            item.storagePath,
            item.source.mimeType,
            item.source.visibility,
            item.source.reportCaption,
          ],
        );
      }
      const result: ProjectArchiveCommitResult = {
        importId,
        projectId,
        season: input.targetSeason,
        createdNodes: parsed.manifest.nodes.length,
        createdCostLines: parsed.manifest.costLines.length,
        createdEvidence: parsed.manifest.evidence.length,
        alreadyImported: false,
      };
      await transaction.query(
        `
          INSERT INTO project_archive_imports(
            id, target_project_id, source_sha256, idempotency_key,
            result_json, created_by
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [importId, projectId, archiveSha256, input.idempotencyKey, JSON.stringify(result), actor.actorUserId],
      );
      await appendAuditEntry(transaction, actor, {
        projectId,
        action: "project-archive.restored",
        entityType: "project",
        entityId: projectId,
        after: result,
        metadata: {
          sourceProjectId: parsed.manifest.source.projectId,
          sourceSeason: parsed.manifest.project.season,
          archiveSha256,
          manifestSha256: parsed.manifestSha256,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return result;
    });
    if (result.alreadyImported) {
      await cleanupStagedEvidence(stagedEvidence, paths, projectId);
    }
    return result;
  } catch (error) {
    await cleanupStagedEvidence(stagedEvidence, paths, projectId);
    throw error;
  }
}

function parseArchive(bytes: Uint8Array): ParsedArchive {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("archive-size-not-allowed");
  }
  let expandedBytes = 0;
  let entryCount = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        assertSafeArchivePath(file.name);
        entryCount += 1;
        expandedBytes += file.originalSize;
        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          file.originalSize > MAX_EVIDENCE_FILE_BYTES ||
          expandedBytes > MAX_EXPANDED_BYTES
        ) {
          throw new Error("archive-expansion-limit-exceeded");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("archive-")) throw error;
    throw new Error("archive-invalid-zip");
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("archive-manifest-missing");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error("archive-manifest-invalid");
  }
  const parsedManifest = projectArchiveManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new Error("archive-manifest-invalid");
  const manifest = parsedManifest.data;
  assertManifestIntegrity(manifest);
  const expectedPaths = new Set(["manifest.json", ...manifest.evidence.map((item) => item.archivePath)]);
  if (Object.keys(entries).some((name) => !expectedPaths.has(name)) || Object.keys(entries).length !== expectedPaths.size) {
    throw new Error("archive-unexpected-entry");
  }
  for (const item of manifest.evidence) {
    const evidenceBytes = entries[item.archivePath];
    if (
      !evidenceBytes ||
      evidenceBytes.byteLength !== item.byteSize ||
      digest(evidenceBytes) !== item.contentSha256
    ) {
      throw new Error("archive-evidence-integrity-mismatch");
    }
  }
  return {
    archiveSha256: digest(bytes),
    manifestSha256: digest(manifestBytes),
    manifest,
    entries,
  };
}

function assertManifestIntegrity(manifest: ProjectArchiveManifest): void {
  const nodeById = uniqueBy(manifest.nodes, (node) => node.sourceId, "archive-duplicate-node-id");
  uniqueBy(manifest.costLines, (line) => line.sourceId, "archive-duplicate-cost-line-id");
  uniqueBy(manifest.evidence, (item) => item.sourceId, "archive-duplicate-evidence-id");
  uniqueBy(manifest.evidence, (item) => item.archivePath, "archive-duplicate-evidence-path");
  const roots = manifest.nodes.filter((node) => node.sourceParentId === null);
  if (roots.length !== 1 || roots[0]!.kind !== "vehicle") {
    throw new Error("archive-hierarchy-invalid");
  }
  for (const node of manifest.nodes) {
    if (node.sourceParentId === null) continue;
    const parent = nodeById.get(node.sourceParentId);
    if (!parent || !canCreateChild(parent.kind, node.kind)) {
      throw new Error("archive-hierarchy-invalid");
    }
    const visited = new Set([node.sourceId]);
    let cursor: ProjectArchiveManifest["nodes"][number] | undefined = parent;
    while (cursor?.sourceParentId !== null) {
      if (visited.has(cursor.sourceId)) throw new Error("archive-hierarchy-invalid");
      visited.add(cursor.sourceId);
      cursor = nodeById.get(cursor.sourceParentId);
      if (!cursor) throw new Error("archive-hierarchy-invalid");
    }
  }
  for (const line of manifest.costLines) {
    if (!nodeById.has(line.sourceNodeId)) throw new Error("archive-hierarchy-invalid");
  }
  for (const item of manifest.evidence) {
    if (item.sourceNodeId !== null && !nodeById.has(item.sourceNodeId)) {
      throw new Error("archive-hierarchy-invalid");
    }
  }
}

async function resolveArchiveReferences(database: DbExecutor, manifest: ProjectArchiveManifest) {
  const [rule, catalogue] = await Promise.all([
    database.maybeOne<{ id: string }>(
      `SELECT id FROM source_documents WHERE kind = 'governing-rule' AND sha256 = $1 LIMIT 1`,
      [manifest.sources.rule.sha256],
    ),
    database.maybeOne<{ id: string }>(
      `
        SELECT release.id
        FROM catalogue_releases release
        JOIN source_documents source ON source.id = release.source_document_id
        WHERE release.revision_code = $1 AND source.sha256 = $2
        ORDER BY release.imported_at DESC, release.id
        LIMIT 1
      `,
      [manifest.sources.catalogue.revision, manifest.sources.catalogue.sha256],
    ),
  ]);
  return {
    ruleSourceDocumentId: rule?.id ?? null,
    catalogueReleaseId: catalogue?.id ?? null,
  };
}

async function availableCatalogueIds(
  database: DbExecutor,
  releaseId: string,
  ids: string[],
): Promise<Set<string>> {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM catalogue_items WHERE release_id = $1 AND id = ANY($2::text[])",
    [releaseId, ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

function uniqueCatalogueIds(lines: ProjectArchiveManifest["costLines"]): string[] {
  return [...new Set(lines.flatMap((line) => [line.catalogueItemId, line.multiplierCatalogueItemId].filter((id): id is string => Boolean(id))))];
}

async function stageArchiveEvidence(
  paths: AppPaths,
  projectId: string,
  parsed: ParsedArchive,
  nodeIdMap: ReadonlyMap<string, string>,
) {
  const directory = path.join(paths.uploadRoot, projectId);
  await mkdir(directory, { recursive: true });
  const staged: Array<{
    id: string;
    targetNodeId: string | null;
    source: ProjectArchiveManifest["evidence"][number];
    storagePath: string;
    absolutePath: string;
  }> = [];
  try {
    for (const source of parsed.manifest.evidence) {
      const id = randomUUID();
      const extension = safeExtension(source.displayName);
      const absolutePath = path.join(directory, `${id}${extension}`);
      const temporaryPath = path.join(directory, `.${id}.restoring`);
      await writeFile(temporaryPath, parsed.entries[source.archivePath]!, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, absolutePath);
      staged.push({
        id,
        targetNodeId: source.sourceNodeId ? nodeIdMap.get(source.sourceNodeId)! : null,
        source,
        storagePath: toStoredDataPath(absolutePath, paths),
        absolutePath,
      });
    }
    return staged;
  } catch (error) {
    await cleanupStagedEvidence(staged, paths, projectId);
    throw error;
  }
}

async function cleanupStagedEvidence(
  staged: readonly { absolutePath: string }[],
  paths: AppPaths,
  projectId: string,
): Promise<void> {
  await Promise.all(staged.map((item) => unlink(item.absolutePath).catch(() => undefined)));
  await rmdir(path.join(paths.uploadRoot, projectId)).catch(() => undefined);
}

function topologicalNodes(nodes: ProjectArchiveManifest["nodes"]) {
  const depths = new Map<string, number>();
  const byId = new Map(nodes.map((node) => [node.sourceId, node]));
  const depth = (node: ProjectArchiveManifest["nodes"][number]): number => {
    const known = depths.get(node.sourceId);
    if (known !== undefined) return known;
    const value = node.sourceParentId ? depth(byId.get(node.sourceParentId)!) + 1 : 0;
    depths.set(node.sourceId, value);
    return value;
  };
  return [...nodes].sort((left, right) => depth(left) - depth(right) || left.sortOrder - right.sortOrder || left.sourceId.localeCompare(right.sourceId));
}

function nodeForArchive(node: NodeRow): ProjectArchiveManifest["nodes"][number] {
  return {
    sourceId: node.id,
    sourceParentId: node.parent_id,
    kind: node.kind,
    systemCode: node.system_code,
    rawHla: node.raw_hla,
    rawSubassembly: node.raw_subassembly,
    rawPartNumber: node.raw_part_number,
    referenceId: node.reference_id,
    fullNumber: node.full_number,
    name: node.name,
    description: node.description,
    revision: node.revision,
    procurementType: node.procurement_type,
    quantity: node.quantity,
    internalNote: node.internal_note,
    drawingRequired: node.drawing_required ?? true,
    workStatus: node.work_status ?? "none",
    flagComment: node.flag_comment ?? "",
    imageRequired: node.image_required ?? true,
    imageRequirementReason: node.image_requirement_reason ?? "",
    sortOrder: node.sort_order,
  };
}

function costLineForArchive(line: CostLineRow): ProjectArchiveManifest["costLines"][number] {
  return {
    sourceId: line.id,
    sourceNodeId: line.node_id,
    kind: line.kind,
    catalogueItemId: line.catalogue_item_id,
    description: line.description,
    useDescription: line.use_description,
    unitCost: line.unit_cost,
    quantity: line.quantity,
    multiplier: line.multiplier,
    multiplierName: line.multiplier_name,
    multiplierCatalogueItemId: line.multiplier_catalogue_item_id,
    fractionIncluded: line.fraction_included,
    productionVolumeFactor: line.production_volume_factor,
    sizeInputs: JSON.parse(line.size_inputs_json) as Record<string, unknown>,
    calculation: JSON.parse(line.calculation_json) as Record<string, unknown>,
    subtotal: line.subtotal,
    sortOrder: line.sort_order,
  };
}

function uniqueBy<Row, Key>(rows: readonly Row[], keyFor: (row: Row) => Key, code: string): Map<Key, Row> {
  const result = new Map<Key, Row>();
  for (const row of rows) {
    const key = keyFor(row);
    if (result.has(key)) throw new Error(code);
    result.set(key, row);
  }
  return result;
}

function assertSafeArchivePath(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.length > 200 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(name) !== name
  ) {
    throw new Error("archive-path-not-allowed");
  }
}

function archiveEntryOptions() {
  return { level: 6 as const, mtime: ZIP_EPOCH, os: 3, attrs: 0o100644 << 16 };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workspace";
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}
