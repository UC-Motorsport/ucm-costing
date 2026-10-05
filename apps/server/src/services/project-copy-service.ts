import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { canCreateChild, type NodeKind } from "@ucm/domain";
import type { QueryResultRow } from "pg";
import { z } from "zod";

import { appendAuditEntry } from "../audit/audit-ledger";
import {
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../config";
import type { DatabaseHandle, DbExecutor } from "../db/database";
import { sha256CanonicalJson } from "../security/canonical-json";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import type { CostLineRow, NodeRow } from "./project-types";

const copyRequestSchema = z
  .object({
    sourceProjectId: z.string().min(1),
    sourceNodeId: z.string().min(1),
    targetProjectId: z.string().min(1),
    targetParentId: z.string().min(1),
    includeDescendants: z.boolean().default(true),
    copyEvidence: z.boolean().default(false),
  })
  .refine(
    ({ sourceProjectId, targetProjectId }) =>
      sourceProjectId !== targetProjectId,
    "Source and target projects must differ",
  );

const copyCommitSchema = copyRequestSchema.extend({
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().min(8).max(200),
});

interface CopyProjectRow extends QueryResultRow {
  id: string;
  name: string;
  season: number;
  entry_number: string;
  version: number;
  is_historical: boolean;
}

interface CopyNodeRow extends NodeRow {
  depth: number;
}

interface CopyEvidenceRow extends QueryResultRow {
  id: string;
  node_id: string;
  project_id: string;
  kind:
    | "drawing"
    | "image"
    | "datasheet"
    | "manufacturing"
    | "bulk-deviation"
    | "other";
  display_name: string;
  content_sha256: string;
  byte_size: string | null;
  storage_path: string;
  mime_type: string;
  report_caption: string;
}

interface ProposedCopyNode {
  sourceNodeId: string;
  sourceParentId: string | null;
  depth: number;
  kind: NodeKind;
  name: string;
  proposedFullNumber: string | null;
  costLines: number;
  skippedCostLines: number;
  evidence: number;
}

export interface ProjectCopyPreview {
  previewHash: string;
  source: { id: string; name: string; season: number; version: number };
  target: { id: string; name: string; season: number; version: number };
  targetParent: { id: string; name: string; kind: NodeKind; version: number };
  request: z.infer<typeof copyRequestSchema>;
  nodes: ProposedCopyNode[];
  totals: {
    nodes: number;
    costLines: number;
    skippedCostLines: number;
    evidence: number;
  };
  conflicts: string[];
  warnings: string[];
}

export interface ProjectCopyCommitResult {
  operationId: string;
  targetProjectId: string;
  rootNodeId: string;
  createdNodeIds: string[];
  copiedCostLines: number;
  skippedCostLines: number;
  copiedEvidence: number;
  alreadyCommitted: boolean;
}

export async function previewProjectCopy(
  database: DatabaseHandle,
  actor: ActorContext,
  rawInput: unknown,
): Promise<ProjectCopyPreview> {
  const input = copyRequestSchema.parse(rawInput);
  await assertProjectPermission(database, actor, input.sourceProjectId, "read");
  await assertProjectPermission(database, actor, input.targetProjectId, "write");
  const [source, target] = await readProjects(
    database,
    input.sourceProjectId,
    input.targetProjectId,
  );
  const targetParent = await requireNode(
    database,
    input.targetProjectId,
    input.targetParentId,
  );
  const nodes = await readCopyNodes(
    database,
    input.sourceProjectId,
    input.sourceNodeId,
    input.includeDescendants,
  );
  if (nodes.length === 0) throw new Error("node-not-found");
  const root = nodes[0]!;
  if (!["assembly", "subassembly", "part"].includes(root.kind)) {
    throw new Error("copy-source-kind-not-supported");
  }
  if (!canCreateChild(targetParent.kind, root.kind)) {
    throw new Error("invalid-node-hierarchy");
  }

  const nodeIds = nodes.map((node) => node.id);
  const [costLines, evidence] = await readCopyChildren(database, nodeIds);
  const catalogueIds = new Set<string>();
  for (const line of costLines) {
    if (line.catalogue_item_id) catalogueIds.add(line.catalogue_item_id);
    if (line.multiplier_catalogue_item_id) {
      catalogueIds.add(line.multiplier_catalogue_item_id);
    }
  }
  const availableCatalogueIds = await existingCatalogueIds(
    database,
    [...catalogueIds],
  );
  const linesByNode = groupBy(costLines, (line) => line.node_id);
  const evidenceByNode = groupBy(evidence, (item) => item.node_id);
  const targetFullNumbers = await existingFullNumbers(
    database,
    input.targetProjectId,
  );
  const proposedNumbers = new Set<string>();
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const proposals: ProposedCopyNode[] = nodes.map((node) => {
    const proposedFullNumber = remapFullNumber(
      node.full_number,
      target.entry_number,
      target.season,
      targetParent.system_code,
    );
    if (proposedFullNumber) {
      const normalized = proposedFullNumber.toLowerCase();
      if (targetFullNumbers.has(normalized) || proposedNumbers.has(normalized)) {
        conflicts.push(
          `${node.name}: target identifier ${proposedFullNumber} already exists`,
        );
      }
      proposedNumbers.add(normalized);
    }
    const directLines = linesByNode.get(node.id) ?? [];
    const skippedCostLines = directLines.filter(
      (line) =>
        (line.catalogue_item_id &&
          !availableCatalogueIds.has(line.catalogue_item_id)) ||
        (line.multiplier_catalogue_item_id &&
          !availableCatalogueIds.has(line.multiplier_catalogue_item_id)),
    ).length;
    return {
      sourceNodeId: node.id,
      sourceParentId: node.parent_id,
      depth: node.depth,
      kind: node.kind,
      name: node.name,
      proposedFullNumber,
      costLines: directLines.length - skippedCostLines,
      skippedCostLines,
      evidence: input.copyEvidence
        ? (evidenceByNode.get(node.id)?.length ?? 0)
        : 0,
    };
  });
  const duplicateName = await database.maybeOne<{ id: string }>(
    `
      SELECT id
      FROM cost_nodes
      WHERE project_id = $1 AND parent_id = $2 AND lower(name) = lower($3)
      LIMIT 1
    `,
    [input.targetProjectId, input.targetParentId, root.name],
  );
  if (duplicateName) {
    warnings.push(
      `The target parent already has a child named ${root.name}; the copy will remain a separate record.`,
    );
  }
  const skippedCostLines = proposals.reduce(
    (sum, node) => sum + node.skippedCostLines,
    0,
  );
  if (skippedCostLines > 0) {
    warnings.push(
      `${skippedCostLines} cost line(s) reference unavailable catalogue items and will be skipped.`,
    );
  }
  if (input.copyEvidence && evidence.length > 0) {
    warnings.push(
      "Copied evidence will be internal-only until a 2026 owner reviews and explicitly marks it report-visible.",
    );
  }
  warnings.push(
    `Copied records retain lineage to ${source.season} and require target-season review.`,
  );

  const unsigned = {
    source: {
      id: source.id,
      name: source.name,
      season: source.season,
      version: source.version,
    },
    target: {
      id: target.id,
      name: target.name,
      season: target.season,
      version: target.version,
    },
    targetParent: {
      id: targetParent.id,
      name: targetParent.name,
      kind: targetParent.kind,
      version: targetParent.version,
    },
    request: input,
    nodes: proposals,
    totals: {
      nodes: proposals.length,
      costLines: proposals.reduce((sum, node) => sum + node.costLines, 0),
      skippedCostLines,
      evidence: input.copyEvidence ? evidence.length : 0,
    },
    conflicts,
    warnings,
  };
  return { ...unsigned, previewHash: sha256CanonicalJson(unsigned) };
}

export async function commitProjectCopy(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  rawInput: unknown,
): Promise<ProjectCopyCommitResult> {
  const input = copyCommitSchema.parse(rawInput);
  const prior = await database.maybeOne<{ result_json: ProjectCopyCommitResult }>(
    `
      SELECT result_json
      FROM project_copy_operations
      WHERE target_project_id = $1 AND idempotency_key = $2
    `,
    [input.targetProjectId, input.idempotencyKey],
  );
  if (prior) return { ...prior.result_json, alreadyCommitted: true };
  const preview = await previewProjectCopy(database, actor, input);
  if (preview.previewHash !== input.previewHash) {
    throw new Error("copy-preview-stale");
  }
  if (preview.conflicts.length > 0) {
    throw new Error("copy-preview-has-conflicts");
  }

  const nodes = await readCopyNodes(
    database,
    input.sourceProjectId,
    input.sourceNodeId,
    input.includeDescendants,
  );
  const nodeIds = nodes.map((node) => node.id);
  const [costLines, evidence] = await readCopyChildren(database, nodeIds);
  const availableCatalogueIds = await existingCatalogueIds(
    database,
    [
      ...new Set(
        costLines.flatMap((line) =>
          [line.catalogue_item_id, line.multiplier_catalogue_item_id].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ),
    ],
  );
  const compatibleLines = costLines.filter(
    (line) =>
      (!line.catalogue_item_id ||
        availableCatalogueIds.has(line.catalogue_item_id)) &&
      (!line.multiplier_catalogue_item_id ||
        availableCatalogueIds.has(line.multiplier_catalogue_item_id)),
  );
  const targetParentNode = await requireNode(
    database,
    input.targetProjectId,
    input.targetParentId,
  );
  const nodeIdMap = new Map(nodes.map((node) => [node.id, randomUUID()]));
  const stagedEvidence = input.copyEvidence
    ? await copyEvidenceFiles(
        paths,
        input.targetProjectId,
        evidence,
        nodeIdMap,
      )
    : [];
  const operationId = randomUUID();
  try {
    const result = await database.transaction(async (transaction) => {
      for (const projectId of [
        input.sourceProjectId,
        input.targetProjectId,
      ].sort()) {
        await transaction.query(
          "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
          [projectId],
        );
      }
      await assertProjectPermission(
        transaction,
        actor,
        input.sourceProjectId,
        "read",
      );
      await assertProjectPermission(
        transaction,
        actor,
        input.targetProjectId,
        "write",
      );
      const lockedVersions = await transaction.query<{
        id: string;
        version: number;
      }>(
        "SELECT id, version FROM projects WHERE id = ANY($1::text[])",
        [[input.sourceProjectId, input.targetProjectId]],
      );
      const versionById = new Map(
        lockedVersions.rows.map((row) => [row.id, row.version]),
      );
      if (
        versionById.get(input.sourceProjectId) !== preview.source.version ||
        versionById.get(input.targetProjectId) !== preview.target.version
      ) {
        throw new Error("copy-preview-stale");
      }
      const targetParent = await transaction.maybeOne<{
        version: number;
      }>(
        "SELECT version FROM cost_nodes WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [input.targetParentId, input.targetProjectId],
      );
      if (!targetParent || targetParent.version !== preview.targetParent.version) {
        throw new Error("copy-preview-stale");
      }
      const existingOperation = await transaction.maybeOne<{
        result_json: ProjectCopyCommitResult;
      }>(
        `
          SELECT result_json
          FROM project_copy_operations
          WHERE target_project_id = $1 AND idempotency_key = $2
        `,
        [input.targetProjectId, input.idempotencyKey],
      );
      if (existingOperation) {
        return { ...existingOperation.result_json, alreadyCommitted: true };
      }

      for (const node of nodes) {
        const targetId = nodeIdMap.get(node.id)!;
        const targetParentId =
          node.id === input.sourceNodeId
            ? input.targetParentId
            : nodeIdMap.get(node.parent_id!)!;
        const proposed = preview.nodes.find(
          (item) => item.sourceNodeId === node.id,
        )!;
        await transaction.query(
          `
            INSERT INTO cost_nodes(
              id, project_id, parent_id, kind, system_code, raw_hla,
              raw_subassembly, raw_part_number, reference_id, full_number,
              name, description, revision, procurement_type, quantity,
              internal_note, source_import_batch_id, source_import_row,
              sort_order, version, created_at, updated_at, drawing_required, work_status, flag_comment, image_required, image_requirement_reason
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15::numeric, $16, NULL, NULL,
              $17, 0, now(), now(), $18, $19, $20, $21, $22
            )
          `,
          [
            targetId,
            input.targetProjectId,
            targetParentId,
            node.kind,
            targetParentNode.system_code,
            node.raw_hla,
            node.raw_subassembly,
            node.raw_part_number,
            node.reference_id,
            proposed.proposedFullNumber,
            node.name,
            node.description,
            node.revision,
            node.procurement_type,
            node.quantity,
            [
              node.internal_note,
              `Copied from ${preview.source.season} (${node.full_number ?? node.name}); target-season review required.`,
            ]
              .filter(Boolean)
              .join("\n"),
            node.sort_order,
            node.drawing_required ?? true,
            node.work_status ?? "none",
            node.flag_comment ?? "",
            node.image_required ?? true,
            node.image_requirement_reason ?? "",
          ],
        );
        await transaction.query(
          `
            INSERT INTO cost_node_lineage(
              id, source_project_id, source_node_id,
              target_project_id, target_node_id, copied_by, options_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          `,
          [
            randomUUID(),
            input.sourceProjectId,
            node.id,
            input.targetProjectId,
            targetId,
            actor.actorUserId,
            JSON.stringify({
              includeDescendants: input.includeDescendants,
              copiedEvidence: input.copyEvidence,
              sourceSeason: preview.source.season,
              targetSeason: preview.target.season,
            }),
          ],
        );
      }

      for (const line of compatibleLines) {
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
            nodeIdMap.get(line.node_id),
            line.kind,
            line.catalogue_item_id,
            line.description,
            line.use_description,
            line.unit_cost,
            line.quantity,
            line.multiplier,
            line.multiplier_name,
            line.multiplier_catalogue_item_id,
            line.fraction_included,
            line.production_volume_factor,
            line.size_inputs_json,
            line.calculation_json,
            line.subtotal,
            line.sort_order,
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
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              'internal', $10, 0, now(), now()
            )
          `,
          [
            item.id,
            item.targetNodeId,
            input.targetProjectId,
            item.source.kind,
            item.source.display_name,
            item.source.content_sha256,
            item.source.byte_size,
            item.storagePath,
            item.source.mime_type,
            item.source.report_caption,
          ],
        );
      }
      await transaction.query(
        `
          UPDATE cost_nodes
          SET version = version + 1, updated_at = now()
          WHERE id = $1 AND project_id = $2
        `,
        [input.targetParentId, input.targetProjectId],
      );
      await transaction.query(
        `
          UPDATE projects
          SET version = version + 1, updated_by = $1, updated_at = now()
          WHERE id = $2
        `,
        [actor.actorUserId, input.targetProjectId],
      );
      const result: ProjectCopyCommitResult = {
        operationId,
        targetProjectId: input.targetProjectId,
        rootNodeId: nodeIdMap.get(input.sourceNodeId)!,
        createdNodeIds: nodes.map((node) => nodeIdMap.get(node.id)!),
        copiedCostLines: compatibleLines.length,
        skippedCostLines: costLines.length - compatibleLines.length,
        copiedEvidence: stagedEvidence.length,
        alreadyCommitted: false,
      };
      await transaction.query(
        `
          INSERT INTO project_copy_operations(
            id, source_project_id, target_project_id, idempotency_key,
            request_json, result_json, created_by
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
        `,
        [
          operationId,
          input.sourceProjectId,
          input.targetProjectId,
          input.idempotencyKey,
          JSON.stringify(input),
          JSON.stringify(result),
          actor.actorUserId,
        ],
      );
      await appendAuditEntry(transaction, actor, {
        projectId: input.targetProjectId,
        action: "project-subtree.copied",
        entityType: "cost-node",
        entityId: result.rootNodeId,
        after: result,
        metadata: {
          sourceProjectId: input.sourceProjectId,
          sourceNodeId: input.sourceNodeId,
          previewHash: input.previewHash,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return result;
    });
    if (result.alreadyCommitted) {
      await Promise.all(
        stagedEvidence.map((item) =>
          unlink(item.absolutePath).catch(() => undefined),
        ),
      );
    }
    return result;
  } catch (error) {
    await Promise.all(
      stagedEvidence.map((item) => unlink(item.absolutePath).catch(() => undefined)),
    );
    throw error;
  }
}

async function readProjects(
  database: DbExecutor,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<[CopyProjectRow, CopyProjectRow]> {
  const result = await database.query<CopyProjectRow>(
    `
      SELECT id, name, season, entry_number, version, is_historical
      FROM projects
      WHERE id = ANY($1::text[]) AND archived_at IS NULL
    `,
    [[sourceProjectId, targetProjectId]],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const source = byId.get(sourceProjectId);
  const target = byId.get(targetProjectId);
  if (!source || !target) throw new Error("project-not-found");
  return [source, target];
}

async function requireProject(
  database: DbExecutor,
  projectId: string,
): Promise<CopyProjectRow> {
  const project = await database.maybeOne<CopyProjectRow>(
    `
      SELECT id, name, season, entry_number, version, is_historical
      FROM projects WHERE id = $1 AND archived_at IS NULL
    `,
    [projectId],
  );
  if (!project) throw new Error("project-not-found");
  return project;
}

async function requireNode(
  database: DbExecutor,
  projectId: string,
  nodeId: string,
): Promise<NodeRow> {
  const node = await database.maybeOne<NodeRow>(
    "SELECT * FROM cost_nodes WHERE id = $1 AND project_id = $2",
    [nodeId, projectId],
  );
  if (!node) throw new Error("node-not-found");
  return node;
}

async function readCopyNodes(
  database: DbExecutor,
  projectId: string,
  nodeId: string,
  includeDescendants: boolean,
): Promise<CopyNodeRow[]> {
  const result = await database.query<CopyNodeRow>(
    includeDescendants
      ? `
          WITH RECURSIVE subtree AS (
            SELECT node.*, 0::int AS depth
            FROM cost_nodes node
            WHERE node.id = $1 AND node.project_id = $2
            UNION ALL
            SELECT child.*, subtree.depth + 1
            FROM cost_nodes child
            JOIN subtree ON child.parent_id = subtree.id
            WHERE child.project_id = $2
          )
          SELECT * FROM subtree
          ORDER BY depth, sort_order, lower(name), id
        `
      : `
          SELECT node.*, 0::int AS depth
          FROM cost_nodes node
          WHERE node.id = $1 AND node.project_id = $2
        `,
    [nodeId, projectId],
  );
  return result.rows;
}

async function readCopyChildren(
  database: DbExecutor,
  nodeIds: string[],
): Promise<[CostLineRow[], CopyEvidenceRow[]]> {
  if (nodeIds.length === 0) return [[], []];
  const lines = await database.query<CostLineRow>(
    `
      SELECT
        id, node_id, kind, catalogue_item_id, description, use_description,
        unit_cost::text, quantity::text, multiplier::text, multiplier_name,
        multiplier_catalogue_item_id, fraction_included::text,
        production_volume_factor::text, size_inputs_json::text,
        calculation_json::text, subtotal::text, sort_order, version,
        created_at, updated_at
      FROM cost_lines
      WHERE node_id = ANY($1::text[])
      ORDER BY node_id, kind, sort_order, id
    `,
    [nodeIds],
  );
  const evidence = await database.query<CopyEvidenceRow>(
    `
      SELECT id, node_id, project_id, kind, display_name, content_sha256,
             byte_size::text, storage_path, mime_type, report_caption
      FROM evidence
      WHERE node_id = ANY($1::text[])
      ORDER BY node_id, kind, created_at, id
    `,
    [nodeIds],
  );
  return [lines.rows, evidence.rows];
}

async function existingCatalogueIds(
  database: DbExecutor,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await database.query<{ id: string }>(
    "SELECT id FROM catalogue_items WHERE id = ANY($1::text[])",
    [ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function existingFullNumbers(
  database: DbExecutor,
  projectId: string,
): Promise<Set<string>> {
  const result = await database.query<{ full_number: string }>(
    `
      SELECT lower(full_number) AS full_number
      FROM cost_nodes
      WHERE project_id = $1 AND full_number IS NOT NULL
    `,
    [projectId],
  );
  return new Set(result.rows.map((row) => row.full_number));
}

function remapFullNumber(
  fullNumber: string | null,
  targetEntryNumber: string,
  targetSeason: number,
  targetSystemCode: string | null,
): string | null {
  if (!fullNumber) return null;
  const segments = fullNumber.split("-");
  if (segments.length < 5) return null;
  segments[0] = targetEntryNumber;
  segments[1] = String(targetSeason).slice(-2);
  if (targetSystemCode) segments[2] = targetSystemCode;
  return segments.join("-");
}

function groupBy<Row, Key>(
  rows: Row[],
  keyFor: (row: Row) => Key,
): Map<Key, Row[]> {
  const grouped = new Map<Key, Row[]>();
  for (const row of rows) {
    const key = keyFor(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

async function copyEvidenceFiles(
  paths: AppPaths,
  targetProjectId: string,
  evidence: CopyEvidenceRow[],
  nodeIdMap: ReadonlyMap<string, string>,
): Promise<
  Array<{
    id: string;
    targetNodeId: string;
    source: CopyEvidenceRow;
    storagePath: string;
    absolutePath: string;
  }>
> {
  const targetDirectory = path.join(paths.uploadRoot, targetProjectId);
  await mkdir(targetDirectory, { recursive: true });
  const copied: Array<{
    id: string;
    targetNodeId: string;
    source: CopyEvidenceRow;
    storagePath: string;
    absolutePath: string;
  }> = [];
  try {
    for (const source of evidence) {
      const sourcePath = resolveStoredDataPath(source.storage_path, paths);
      const bytes = await readFile(sourcePath);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== source.content_sha256) {
        throw new Error("stored-file-integrity-failed");
      }
      if (source.byte_size !== null && bytes.byteLength !== Number(source.byte_size)) {
        throw new Error("stored-file-byte-size-mismatch");
      }
      const id = randomUUID();
      const extension = path.extname(sourcePath).slice(0, 16);
      const absolutePath = path.join(targetDirectory, `${id}${extension}`);
      const temporaryPath = path.join(targetDirectory, `.${id}.copying`);
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, absolutePath);
      copied.push({
        id,
        targetNodeId: nodeIdMap.get(source.node_id)!,
        source,
        storagePath: toStoredDataPath(absolutePath, paths),
        absolutePath,
      });
    }
    return copied;
  } catch (error) {
    await Promise.all(
      copied.map((item) => unlink(item.absolutePath).catch(() => undefined)),
    );
    throw error;
  }
}
