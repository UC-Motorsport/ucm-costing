import type { CostBreakdown } from "@ucm/domain";

import type { AppPaths } from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  buildCostAmendmentSnapshot,
  renderCostAmendmentPreview,
  type CostAmendmentReportInput,
} from "../report/cost-amendment-report";
import { sha256CanonicalJson } from "../security/canonical-json";
import type { ActorContext } from "../security/authorization";
import {
  createArtifact,
  type ArtifactRow,
} from "./artifact-service";
import {
  freezeCostAmendmentPreviewSnapshot,
  getCostAmendmentDetail,
} from "./cost-amendment-service";
import { getReport } from "./report-service";

export async function createCostAmendmentPreviewArtifact(
  database: DatabaseHandle,
  paths: AppPaths,
  actor: ActorContext,
  amendmentId: string,
): Promise<ArtifactRow> {
  const detail = await getCostAmendmentDetail(
    database,
    actor,
    amendmentId,
  );
  if (!detail) {
    throw new Error("cost-amendment-not-found");
  }
  const report = await getReport(
    database,
    actor,
    detail.amendment.base_report_snapshot_id,
  );
  if (
    !report ||
    report.status !== "complete" ||
    !report.pdf_sha256
  ) {
    throw new Error("cost-amendment-base-report-not-complete");
  }
  const input = amendmentReportInput(detail, report.snapshot_json, {
    reportId: report.id,
    reportSha256: report.pdf_sha256,
    createdAt: detail.amendment.updated_at,
  });
  const snapshot = buildCostAmendmentSnapshot(input);
  const frozen = await freezeCostAmendmentPreviewSnapshot(
    database,
    actor,
    amendmentId,
    detail.amendment.version,
    snapshot,
  );
  return await createArtifact(database, paths, actor, {
    projectId: detail.amendment.project_id,
    kind: "cost-amendment",
    reportSnapshotId: report.id,
    filename: `UCM-${detail.amendment.id}-cost-amendment-preview.pdf`,
    mimeType: "application/pdf",
    metadata: {
      amendmentId: detail.amendment.id,
      previewOnly: true,
      submissionEligible: false,
      sourceAmendmentVersion: snapshot.amendmentVersion,
      frozenAmendmentVersion: frozen.amendment.version,
      amendmentSnapshotSha256: frozen.snapshotSha256,
    },
    generate: async () => {
      const preview = await renderCostAmendmentPreview(input);
      if (
        sha256CanonicalJson(preview.snapshot) !==
        frozen.snapshotSha256
      ) {
        throw new Error("cost-amendment-preview-snapshot-changed");
      }
      return {
        bytes: preview.bytes,
        sha256: preview.sha256,
        metadata: {
          pageCount: preview.pageCount,
          issues: preview.snapshot.issues,
          watermark: preview.snapshot.watermark,
          calculation: preview.snapshot.calculation,
          snapshot: preview.snapshot,
          amendmentSnapshotSha256: frozen.snapshotSha256,
        },
      };
    },
  });
}

function amendmentReportInput(
  detail: NonNullable<
    Awaited<ReturnType<typeof getCostAmendmentDetail>>
  >,
  rawSnapshot: Record<string, unknown>,
  options: {
    reportId: string;
    reportSha256: string;
    createdAt: string;
  },
): CostAmendmentReportInput {
  const snapshot = requireSnapshot(rawSnapshot);
  const nodes = flattenNodes(snapshot.tree);
  const parts = new Map<
    string,
    CostAmendmentReportInput["parts"][number]
  >();
  const items: CostAmendmentReportInput["items"] = detail.items.map(
    (item) => {
      const source = item.source_json;
      const node = findPartNode(nodes, source.partIdentity);
      if (!node) {
        throw new Error("cost-amendment-part-not-in-base-report");
      }
      const existing = parts.get(source.partIdentity);
      const part = {
        partIdentity: source.partIdentity,
        partNumber: source.partNumber,
        description: node.name,
        originalQuantity: item.original_quantity,
        revisedQuantity: item.revised_quantity,
        original: node.breakdown,
      };
      if (!existing) {
        parts.set(source.partIdentity, part);
      }
      return {
        id: item.id,
        action: item.action,
        costBox: item.cost_box,
        classification: item.classification,
        changeGroupId: item.change_group_id,
        partIdentity: source.partIdentity,
        originalQuantity: item.original_quantity,
        revisedQuantity: item.revised_quantity,
        nodeId: item.node_id,
        description: item.description,
        quantity: item.quantity,
        unitCost: item.unit_cost,
        subtotal: item.subtotal,
        catalogueReleaseId: source.catalogueReleaseId,
        catalogueItemId: source.catalogueItemId,
        catalogueId: source.catalogueId,
      };
    },
  );

  return {
    schemaVersion: 1,
    amendmentId: detail.amendment.id,
    amendmentVersion: detail.amendment.version,
    eventReference: detail.amendment.event_reference,
    createdAt: options.createdAt,
    project: {
      id: snapshot.project.id,
      name: snapshot.project.name,
      entryNumber: snapshot.project.entry_number,
    },
    baseReport: {
      snapshotId: options.reportId,
      sha256: options.reportSha256,
      breakdown: snapshot.breakdown,
    },
    rulePack: snapshot.sources.rulePack,
    catalogue: snapshot.sources.catalogue,
    parts: [...parts.values()],
    items,
  };
}

interface SnapshotNode {
  id: string;
  full_number: string | null;
  reference_id: string | null;
  name: string;
  breakdown: CostBreakdown;
  children: SnapshotNode[];
}

interface AmendmentSnapshot {
  project: {
    id: string;
    name: string;
    entry_number: string;
  };
  sources: {
    rulePack: { version: string; sha256: string };
    catalogue: {
      releaseId: string;
      revision: string;
      sha256: string;
    };
  };
  breakdown: CostBreakdown;
  tree: SnapshotNode;
}

function requireSnapshot(
  value: Record<string, unknown>,
): AmendmentSnapshot {
  const candidate = value as Partial<AmendmentSnapshot>;
  if (
    !candidate.project?.id ||
    !candidate.project.name ||
    !candidate.project.entry_number ||
    !candidate.sources?.rulePack?.version ||
    !candidate.sources.rulePack.sha256 ||
    !candidate.sources.catalogue?.releaseId ||
    !candidate.sources.catalogue.revision ||
    !candidate.sources.catalogue.sha256 ||
    !candidate.breakdown ||
    !candidate.tree
  ) {
    throw new Error("cost-amendment-base-snapshot-invalid");
  }
  return candidate as AmendmentSnapshot;
}

function flattenNodes(root: SnapshotNode): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const visit = (node: SnapshotNode): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
}

function findPartNode(
  nodes: readonly SnapshotNode[],
  identity: string,
): SnapshotNode | null {
  return (
    nodes.find(
      (node) =>
        node.id === identity ||
        node.full_number === identity ||
        node.reference_id === identity,
    ) ?? null
  );
}
