import type { CostKind, ValidationIssue } from "@ucm/domain";
import { PDFDocument } from "pdf-lib";

import type {
  CostLineRow,
  ProjectDetail,
  ProjectNode,
} from "../services/project-types";

export interface ReportEvidence {
  id: string;
  nodeId: string | null;
  kind: string;
  displayName: string;
  contentSha256: string;
  mimeType: string;
  reportCaption: string;
  /** Bytes read through a SHA-256-verified file handle. Never serialized. */
  verifiedBytes: Uint8Array;
}

export interface PlannedCostSection {
  kind: CostKind;
  lines: CostLineRow[];
  continued: boolean;
  sourceLayout?: HistoricalCostTableLayout;
}

export interface HistoricalImageFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HistoricalCostTableLayout {
  kind: CostKind;
  left: number;
  top: number;
  widths: number[];
  headerHeight: number;
  rowHeight: number;
}

export type PlannedBomRow =
  | {
      type: "node";
      node: ProjectNode;
      lineNumber?: number;
      historicalAssemblyDescription?: string;
      historicalPartDescription?: string;
    }
  | { type: "area-total"; system: ProjectNode };

export type Ucm25PlannedPage =
  | { type: "cover" }
  | { type: "project-summary" }
  | {
      type: "vehicle-drawing";
      evidence: ReportEvidence | null;
      sourcePageIndex: number | null;
    }
  | { type: "cost-summary" }
  | {
      type: "bom";
      rows: PlannedBomRow[];
      first: boolean;
      pageNumberByNode: ReadonlyMap<string, number>;
    }
  | { type: "system-hierarchy"; system: ProjectNode }
  | {
      type: "assembly";
      system: ProjectNode;
      node: ProjectNode;
      evidence: ReportEvidence | null;
      sourcePageIndex: number | null;
      imageFrame?: HistoricalImageFrame;
      children: ProjectNode[];
      showContentsSubtotal: boolean;
    }
  | {
      type: "assembly-contents";
      system: ProjectNode;
      node: ProjectNode;
      children: ProjectNode[];
      showSubtotal: boolean;
      continued: boolean;
    }
  | {
      type: "assembly-cost";
      system: ProjectNode;
      node: ProjectNode;
      sections: PlannedCostSection[];
      continued: boolean;
    }
  | {
      type: "part";
      system: ProjectNode;
      assembly: ProjectNode | null;
      node: ProjectNode;
      sections: PlannedCostSection[];
      continued: boolean;
      evidence: ReportEvidence | null;
      sourcePageIndex: number | null;
      imageFrame?: HistoricalImageFrame;
    }
  | {
      type: "project-drawing";
      system: ProjectNode;
      node: ProjectNode;
      evidence: ReportEvidence | null;
      sourcePageIndex: number | null;
    }
  | {
      type: "evidence";
      evidence: ReportEvidence;
      sourcePageIndex: number | null;
    }
  | {
      type: "validation";
      issues: ValidationIssue[];
      continued: boolean;
    };

export interface Ucm25ReportPlan {
  pages: Ucm25PlannedPage[];
  pageNumberByNode: ReadonlyMap<string, number>;
}

// The accepted UCM25 workbook geometry uses 15-point spreadsheet rows.  Keep
// planning and rendering on the same height so page breaks remain auditable.
export const COST_DATA_ROW_HEIGHT = 15;
export const COST_SECTION_HEADER_HEIGHT = 15;
export const COST_SECTION_SUBTOTAL_HEIGHT = 15;
export const COST_SECTION_GAP = 15;
export const FIRST_PART_COST_START_Y = 200;
export const COST_PAGE_START_Y = 29;
export const COST_PAGE_BOTTOM_Y = 575;
export const VALIDATION_ISSUES_PER_PAGE = 10;

const firstPartPageCapacity =
  COST_PAGE_BOTTOM_Y - FIRST_PART_COST_START_Y;
const continuationPageCapacity =
  COST_PAGE_BOTTOM_Y - COST_PAGE_START_Y;
const assemblyCostPageCapacity = continuationPageCapacity;

export async function buildUcm25ReportPlan(
  detail: ProjectDetail,
  evidence: ReportEvidence[],
): Promise<Ucm25ReportPlan> {
  const historical = buildHistoricalUcm25Plan(detail, evidence);
  if (historical) {
    return historical;
  }
  const evidencePages = await expandEvidencePages(evidence);
  let vehicleVisualIndex = evidencePages.findIndex(
    (page) =>
      page.evidence.nodeId === detail.tree.id &&
      page.evidence.kind === "image",
  );
  if (vehicleVisualIndex < 0) {
    vehicleVisualIndex = evidencePages.findIndex(
      (page) =>
        page.evidence.nodeId === detail.tree.id &&
        page.evidence.kind === "drawing",
    );
  }
  const vehicleVisual =
    vehicleVisualIndex >= 0
      ? evidencePages.splice(vehicleVisualIndex, 1)[0]!
      : null;
  const linkedEvidence = new Map<string, Ucm25PlannedPage[]>();
  const unlinkedEvidence: Ucm25PlannedPage[] = [];

  for (const page of evidencePages) {
    const nodeId = page.evidence.nodeId;
    if (nodeId) {
      const pages = linkedEvidence.get(nodeId) ?? [];
      pages.push(page);
      linkedEvidence.set(nodeId, pages);
    } else {
      unlinkedEvidence.push(page);
    }
  }

  const pages: Ucm25PlannedPage[] = [
    { type: "cover" },
    { type: "project-summary" },
    {
      type: "vehicle-drawing",
      evidence: vehicleVisual?.evidence ?? null,
      sourcePageIndex: vehicleVisual?.sourcePageIndex ?? null,
    },
    { type: "cost-summary" },
  ];

  const bomGroups = chunkBomRows(buildBomRows(detail.tree));
  for (const [index, rows] of bomGroups.entries()) {
    pages.push({
      type: "bom",
      rows,
      first: index === 0,
      pageNumberByNode: new Map(),
    });
  }

  for (const system of detail.tree.children) {
    const reportable = flattenNodes(system).filter(
      (node) =>
        node.kind === "assembly" ||
        node.kind === "subassembly" ||
        node.kind === "part",
    );
    if (reportable.length === 0) {
      continue;
    }

    pages.push({ type: "system-hierarchy", system });
    for (const node of reportable) {
      const nodeEvidence = linkedEvidence.get(node.id) ?? [];
      const summaryVisualIndex = nodeEvidence.findIndex(
        (page) =>
          page.type === "evidence" &&
          page.evidence.kind === "image",
      );
      const summaryVisual =
        summaryVisualIndex >= 0
          ? nodeEvidence.splice(summaryVisualIndex, 1)[0]
          : null;
      const technicalVisualIndex = nodeEvidence.findIndex(
        (page) =>
          page.type === "evidence" &&
          page.evidence.kind === "drawing",
      );
      const technicalVisual =
        technicalVisualIndex >= 0
          ? nodeEvidence.splice(technicalVisualIndex, 1)[0]
          : null;
      const summaryEvidence =
        summaryVisual?.type === "evidence"
          ? summaryVisual.evidence
          : null;
      const summarySourcePageIndex =
        summaryVisual?.type === "evidence"
          ? summaryVisual.sourcePageIndex
          : null;
      const technicalEvidence =
        technicalVisual?.type === "evidence"
          ? technicalVisual.evidence
          : null;
      const technicalSourcePageIndex =
        technicalVisual?.type === "evidence"
          ? technicalVisual.sourcePageIndex
          : null;

      if (node.kind === "assembly" || node.kind === "subassembly") {
        pages.push({
          type: "assembly",
          system,
          node,
          evidence: summaryEvidence,
          sourcePageIndex: summarySourcePageIndex,
          children: node.children,
          showContentsSubtotal: true,
        });
        const costPages = paginateAssemblyCostSections(node.costLines);
        for (const [index, sections] of costPages.entries()) {
          pages.push({
            type: "assembly-cost",
            system,
            node,
            sections,
            continued: index > 0,
          });
        }
      } else {
        const parent = findNode(detail.tree, node.parent_id);
        const assembly =
          parent &&
          (parent.kind === "assembly" || parent.kind === "subassembly")
            ? parent
            : null;
        const costPages = paginateCostSections(
          node.costLines,
          firstPartPageCapacity,
          continuationPageCapacity,
        );
        for (const [index, sections] of costPages.entries()) {
          pages.push({
            type: "part",
            system,
            assembly,
            node,
            sections,
            continued: index > 0,
            evidence: summaryEvidence,
            sourcePageIndex: summarySourcePageIndex,
          });
        }
      }

      if (technicalEvidence) {
        pages.push({
          type: "project-drawing",
          system,
          node,
          evidence: technicalEvidence,
          sourcePageIndex: technicalSourcePageIndex,
        });
      }
      pages.push(...nodeEvidence);
      linkedEvidence.delete(node.id);
    }
  }

  for (const orphaned of linkedEvidence.values()) {
    unlinkedEvidence.push(...orphaned);
  }
  pages.push(...unlinkedEvidence);

  const pageNumberByNode = new Map<string, number>();
  pages.forEach((page, index) => {
    if (
      (page.type === "assembly" || page.type === "part") &&
      !pageNumberByNode.has(page.node.id)
    ) {
      pageNumberByNode.set(page.node.id, index + 1);
    }
  });

  const resolvedPages = pages.map((page) =>
    page.type === "bom"
      ? { ...page, pageNumberByNode }
      : page,
  );
  return { pages: resolvedPages, pageNumberByNode };
}

const UCM25_ACCEPTED_SOURCE_SHA256 =
  "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37";

type HistoricalPageClass =
  | "cover"
  | "project-summary"
  | "vehicle-drawing"
  | "cost-summary"
  | "bom"
  | "hierarchy"
  | "node-detail"
  | "node-detail-with-cost"
  | "assembly-contents"
  | "cost-line-table"
  | "blank-evidence"
  | "technical-or-external-evidence";

interface HistoricalLayoutPage {
  pageNumber: number;
  class: HistoricalPageClass;
  ownerOccurrence: number | null;
  costKinds: string[];
  costTableLayouts: HistoricalCostTableLayout[];
  assemblyRowCount: number;
  imageFrame: HistoricalImageFrame | null;
  renderMode: "generated" | "source";
  sourceEvidence?: {
    displayName: string;
    sourcePageIndex: number;
    contentSha256: string;
    byteSize: number;
  };
}

interface HistoricalLayout {
  schemaVersion: 1;
  sourcePdfSha256: string;
  pageCount: number;
  bom: Array<{
    occurrence: number;
    line_number: number;
    bom_page: number;
    system_code: string;
    expected_detail_page: number | null;
    assembly_description: string;
    part_description: string;
  }>;
  pages: HistoricalLayoutPage[];
}

/** Recreate submitted display quantities/parents without mutating calculation data. */
function historicalDisplayNodes(detail: ProjectDetail): ProjectNode[] {
  const copies = detail.flatNodes.map((node) => ({
    ...node,
    children: [] as ProjectNode[],
  }));
  const byId = new Map(copies.map((node) => [node.id, node]));
  const byOccurrence = new Map<number, ProjectNode>();
  for (const node of copies) {
    const occurrence = historicalOccurrence(node);
    if (occurrence !== null) byOccurrence.set(occurrence, node);
  }
  for (const node of copies) {
    if (historicalOccurrence(node) === null) continue;
    const raw = JSON.parse(node.internal_note) as Record<string, unknown>;
    if (!raw.sourceQuantityCorrection) continue;
    const originalKind = raw.historicalNodeKind;
    const quantity = raw.historicalBomQuantity;
    const parentOccurrence = raw.historicalParentOccurrence;
    const parent = parentOccurrence === null
      ? copies.find((candidate) =>
          candidate.kind === "system" && candidate.system_code === node.system_code,
        )
      : typeof parentOccurrence === "number"
        ? byOccurrence.get(parentOccurrence)
        : undefined;
    if (
      (originalKind !== "assembly" && originalKind !== "part") ||
      typeof quantity !== "string" || !quantity.trim() ||
      !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 ||
      !parent || parent.id === node.id
    ) {
      throw new Error("report-historical-quantity-provenance-invalid");
    }
    node.kind = originalKind;
    node.quantity = quantity;
    node.parent_id = parent.id;
  }
  for (const node of copies) {
    const seen = new Set<string>();
    let ancestor: ProjectNode | undefined = node;
    while (ancestor) {
      if (seen.has(ancestor.id)) {
        throw new Error("report-historical-quantity-provenance-invalid");
      }
      seen.add(ancestor.id);
      ancestor = ancestor.parent_id ? byId.get(ancestor.parent_id) : undefined;
    }
    if (node.parent_id) {
      const parent = byId.get(node.parent_id);
      if (!parent) {
        throw new Error("report-historical-quantity-provenance-invalid");
      }
      parent.children.push(node);
    }
  }
  for (const node of copies) {
    node.children.sort((a, b) => a.sort_order - b.sort_order);
  }
  return copies;
}

function buildHistoricalUcm25Plan(
  detail: ProjectDetail,
  evidence: ReportEvidence[],
): Ucm25ReportPlan | null {
  if (
    detail.project.season !== 2025 ||
    !detail.project.is_historical
  ) {
    return null;
  }
  const layoutEvidence = evidence.find(
    (item) =>
      item.displayName === "ucm25-historical-layout.json" &&
      item.mimeType === "application/json",
  );
  if (!layoutEvidence) {
    return null;
  }
  let layout: HistoricalLayout;
  try {
    layout = JSON.parse(
      new TextDecoder().decode(layoutEvidence.verifiedBytes),
    ) as HistoricalLayout;
  } catch {
    throw new Error("report-historical-layout-invalid");
  }
  if (
    layout.schemaVersion !== 1 ||
    layout.sourcePdfSha256 !== UCM25_ACCEPTED_SOURCE_SHA256 ||
    layout.pageCount !== 1_078 ||
    layout.pages.length !== 1_078
  ) {
    throw new Error("report-historical-layout-invalid");
  }

  const displayNodes = historicalDisplayNodes(detail);
  detail = {
    ...detail,
    flatNodes: displayNodes,
    tree: displayNodes.find((node) => node.id === detail.tree.id)!,
  };

  const nodeByOccurrence = new Map<number, ProjectNode>();
  for (const node of detail.flatNodes) {
    const occurrence = historicalOccurrence(node);
    if (occurrence !== null) {
      nodeByOccurrence.set(occurrence, node);
    }
  }
  const evidenceByName = new Map(
    evidence.map((item) => [item.displayName, item]),
  );
  const imageByNode = new Map(
    evidence
      .filter((item) => item.kind === "image" && item.nodeId)
      .map((item) => [item.nodeId!, item]),
  );
  const vehicleVisual = imageByNode.get(detail.tree.id) ?? null;
  const lastOccurrenceBySystem = new Map<string, number>();
  for (const record of layout.bom) {
    lastOccurrenceBySystem.set(record.system_code, record.occurrence);
  }
  const bomByPage = new Map<number, HistoricalLayout["bom"]>();
  for (const record of layout.bom) {
    const records = bomByPage.get(record.bom_page) ?? [];
    records.push(record);
    bomByPage.set(record.bom_page, records);
  }

  const childOffsetByNode = new Map<string, number>();
  const pages: Ucm25PlannedPage[] = [];
  for (const [layoutIndex, sourcePage] of layout.pages.entries()) {
    if (sourcePage.pageNumber !== layoutIndex + 1) {
      throw new Error("report-historical-layout-invalid");
    }
    if (sourcePage.renderMode === "source") {
      const source = sourcePage.sourceEvidence;
      const item = source ? evidenceByName.get(source.displayName) : null;
      if (
        !source ||
        !item ||
        item.mimeType !== "application/pdf" ||
        source.contentSha256 !== item.contentSha256 ||
        source.byteSize !== item.verifiedBytes.byteLength ||
        source.sourcePageIndex < 0 ||
        !Number.isInteger(source.sourcePageIndex)
      ) {
        throw new Error("report-historical-source-evidence-missing");
      }
      pages.push({
        type: "evidence",
        evidence: item,
        sourcePageIndex: source.sourcePageIndex,
      });
      continue;
    }
    switch (sourcePage.class) {
      case "cover":
        pages.push({ type: "cover" });
        continue;
      case "project-summary":
        pages.push({ type: "project-summary" });
        continue;
      case "vehicle-drawing":
        pages.push({
          type: "vehicle-drawing",
          evidence: vehicleVisual,
          sourcePageIndex: null,
        });
        continue;
      case "cost-summary":
        pages.push({ type: "cost-summary" });
        continue;
      case "bom": {
        const rows: PlannedBomRow[] = [];
        for (const record of bomByPage.get(sourcePage.pageNumber) ?? []) {
          const node = nodeByOccurrence.get(record.occurrence);
          if (!node) {
            throw new Error("report-historical-layout-node-missing");
          }
          rows.push({
            type: "node",
            node,
            lineNumber: record.line_number,
            historicalAssemblyDescription: record.assembly_description,
            historicalPartDescription: record.part_description,
          });
          if (
            lastOccurrenceBySystem.get(record.system_code) ===
            record.occurrence
          ) {
            const system = detail.tree.children.find(
              (candidate) => candidate.system_code === record.system_code,
            );
            if (system) {
              rows.push({ type: "area-total", system });
            }
          }
        }
        pages.push({
          type: "bom",
          rows,
          first: sourcePage.pageNumber === 5,
          pageNumberByNode: new Map(),
        });
        continue;
      }
      case "node-detail":
      case "node-detail-with-cost":
      case "assembly-contents":
      case "cost-line-table": {
        const occurrence = sourcePage.ownerOccurrence;
        const node =
          occurrence === null ? null : nodeByOccurrence.get(occurrence);
        if (!node) {
          throw new Error("report-historical-layout-node-missing");
        }
        const system = detail.tree.children.find(
          (candidate) => candidate.system_code === node.system_code,
        );
        if (!system) {
          throw new Error("report-historical-layout-node-missing");
        }
        const sections = historicalCostSections(
          node,
          sourcePage.pageNumber,
          sourcePage.costKinds,
          sourcePage.costTableLayouts,
        );
        if (sourcePage.class === "assembly-contents") {
          const offset = childOffsetByNode.get(node.id) ?? 0;
          const children = node.children.slice(
            offset,
            offset + sourcePage.assemblyRowCount,
          );
          childOffsetByNode.set(node.id, offset + children.length);
          const hasLaterContents = layout.pages
            .slice(layoutIndex + 1)
            .some(
              (candidate) =>
                candidate.ownerOccurrence === occurrence &&
                candidate.class === "assembly-contents",
            );
          pages.push({
            type: "assembly-contents",
            system,
            node,
            children,
            showSubtotal: !hasLaterContents,
            continued: offset > 0,
          });
          continue;
        }
        if (node.kind === "assembly" || node.kind === "subassembly") {
          if (sourcePage.class === "cost-line-table") {
            pages.push({
              type: "assembly-cost",
              system,
              node,
              sections,
              continued: true,
            });
            continue;
          }
          const offset = childOffsetByNode.get(node.id) ?? 0;
          const children = node.children.slice(
            offset,
            offset + sourcePage.assemblyRowCount,
          );
          childOffsetByNode.set(node.id, offset + children.length);
          const hasLaterContents = layout.pages
            .slice(layoutIndex + 1)
            .some(
              (candidate) =>
                candidate.ownerOccurrence === occurrence &&
                candidate.class === "assembly-contents",
            );
          pages.push({
            type: "assembly",
            system,
            node,
            evidence: imageByNode.get(node.id) ?? null,
            sourcePageIndex: null,
            imageFrame: sourcePage.imageFrame ?? undefined,
            children,
            showContentsSubtotal:
              children.length > 0 && !hasLaterContents,
          });
          continue;
        }
        const parent = findNode(detail.tree, node.parent_id);
        const assembly =
          parent &&
          (parent.kind === "assembly" || parent.kind === "subassembly")
            ? parent
            : null;
        pages.push({
          type: "part",
          system,
          assembly,
          node,
          sections,
          continued: sourcePage.class === "cost-line-table",
          evidence:
            sourcePage.class === "cost-line-table"
              ? null
              : imageByNode.get(node.id) ?? null,
          sourcePageIndex: null,
          imageFrame: sourcePage.imageFrame ?? undefined,
        });
        continue;
      }
      default:
        throw new Error("report-historical-layout-invalid");
    }
  }

  const pageNumberByNode = new Map<string, number>();
  for (const record of layout.bom) {
    const node = nodeByOccurrence.get(record.occurrence);
    if (
      node &&
      typeof record.expected_detail_page === "number" &&
      Number.isInteger(record.expected_detail_page) &&
      record.expected_detail_page > 0
    ) {
      pageNumberByNode.set(node.id, record.expected_detail_page);
    }
  }
  pages.forEach((page, index) => {
    if (
      (page.type === "assembly" || page.type === "part") &&
      !pageNumberByNode.has(page.node.id)
    ) {
      pageNumberByNode.set(page.node.id, index + 1);
    }
  });
  const resolved = pages.map((page) =>
    page.type === "bom"
      ? { ...page, pageNumberByNode }
      : page,
  );
  return { pages: resolved, pageNumberByNode };
}

function historicalOccurrence(node: ProjectNode): number | null {
  if (!node.internal_note) {
    return null;
  }
  try {
    const raw = JSON.parse(node.internal_note) as Record<string, unknown>;
    return raw.sourcePdfSha256 === UCM25_ACCEPTED_SOURCE_SHA256 &&
      typeof raw.sourceBomOccurrence === "number"
      ? raw.sourceBomOccurrence
      : null;
  } catch {
    return null;
  }
}

function historicalLineSourcePage(line: CostLineRow): number | null {
  try {
    const raw = JSON.parse(line.calculation_json) as Record<string, unknown>;
    return typeof raw.sourcePage === "number" ? raw.sourcePage : null;
  } catch {
    return null;
  }
}

function historicalCostSections(
  node: ProjectNode,
  sourcePage: number,
  rawKinds: string[],
  rawLayouts: HistoricalCostTableLayout[],
): PlannedCostSection[] {
  const lines = node.costLines.filter(
    (line) => historicalLineSourcePage(line) === sourcePage,
  );
  const allowed = new Set<CostKind>([
    "material",
    "process",
    "fastener",
    "tooling",
  ]);
  const kinds = rawKinds.filter(
    (kind): kind is CostKind => allowed.has(kind as CostKind),
  );
  if (kinds.length === 0) {
    for (const kind of [
      "material",
      "process",
      "fastener",
      "tooling",
    ] as const) {
      if (lines.some((line) => line.kind === kind)) {
        kinds.push(kind);
      }
    }
  }
  const layoutsByKind = new Map<CostKind, HistoricalCostTableLayout[]>();
  for (const layout of rawLayouts) {
    if (!allowed.has(layout.kind)) continue;
    const layouts = layoutsByKind.get(layout.kind) ?? [];
    layouts.push(layout);
    layoutsByKind.set(layout.kind, layouts);
  }
  return kinds.map((kind) => ({
    kind,
    lines: lines.filter((line) => line.kind === kind),
    continued: false,
    sourceLayout: layoutsByKind.get(kind)?.shift(),
  }));
}

export function appendValidationPages(
  plan: Ucm25ReportPlan,
  issues: ValidationIssue[],
  mode: "draft" | "deadline" | "competition-ready" | "export",
): Ucm25ReportPlan {
  if (
    (mode !== "draft" && mode !== "deadline") ||
    issues.length === 0
  ) {
    return plan;
  }
  const pages = [...plan.pages];
  for (
    let index = 0;
    index < issues.length;
    index += VALIDATION_ISSUES_PER_PAGE
  ) {
    pages.push({
      type: "validation",
      issues: issues.slice(index, index + VALIDATION_ISSUES_PER_PAGE),
      continued: index > 0,
    });
  }
  return { ...plan, pages };
}

function buildBomRows(root: ProjectNode): PlannedBomRow[] {
  const rows: PlannedBomRow[] = [];
  for (const system of root.children) {
    const nodes = flattenNodes(system).filter(
      (node) =>
        node.kind === "assembly" ||
        node.kind === "subassembly" ||
        node.kind === "part",
    );
    rows.push(...nodes.map((node) => ({ type: "node" as const, node })));
    if (nodes.length > 0) {
      rows.push({ type: "area-total", system });
    }
  }
  return rows;
}

function chunkBomRows(rows: PlannedBomRow[]): PlannedBomRow[][] {
  if (rows.length === 0) {
    return [[]];
  }
  const chunks: PlannedBomRow[][] = [];
  chunks.push(rows.slice(0, 28));
  for (let index = 28; index < rows.length; index += 42) {
    chunks.push(rows.slice(index, index + 42));
  }
  return chunks;
}

function paginateCostSections(
  lines: CostLineRow[],
  firstCapacity: number,
  continuationCapacity: number,
  kinds: readonly CostKind[] = [
    "material",
    "process",
    "fastener",
    "tooling",
  ],
  includeEmpty = true,
): PlannedCostSection[][] {
  const byKind = new Map<CostKind, CostLineRow[]>();
  for (const kind of kinds) {
    byKind.set(
      kind,
      lines.filter((line) => line.kind === kind),
    );
  }

  const pages: PlannedCostSection[][] = [];
  let current: PlannedCostSection[] = [];
  let remaining = firstCapacity;

  const flush = (): void => {
    if (current.length > 0) {
      pages.push(current);
    }
    current = [];
    remaining = continuationCapacity;
  };

  for (const kind of kinds) {
    const kindLines = byKind.get(kind) ?? [];
    let offset = 0;
    let continued = false;

    if (kindLines.length === 0) {
      if (!includeEmpty) {
        continue;
      }
      const required =
        COST_SECTION_HEADER_HEIGHT +
        COST_SECTION_SUBTOTAL_HEIGHT +
        COST_SECTION_GAP;
      if (required > remaining && current.length > 0) {
        flush();
      }
      current.push({ kind, lines: [], continued: false });
      remaining -= required;
      continue;
    }

    while (offset < kindLines.length) {
      const sectionFixedHeight =
        COST_SECTION_HEADER_HEIGHT +
        COST_SECTION_SUBTOTAL_HEIGHT +
        COST_SECTION_GAP;
      if (
        remaining < sectionFixedHeight + COST_DATA_ROW_HEIGHT &&
        current.length > 0
      ) {
        flush();
      }
      const availableRows = Math.max(
        1,
        Math.floor(
          (remaining - sectionFixedHeight) / COST_DATA_ROW_HEIGHT,
        ),
      );
      const chunk = kindLines.slice(offset, offset + availableRows);
      current.push({ kind, lines: chunk, continued });
      remaining -=
        sectionFixedHeight + chunk.length * COST_DATA_ROW_HEIGHT;
      offset += chunk.length;
      continued = true;
      if (offset < kindLines.length) {
        flush();
      }
    }
  }
  flush();
  return pages.length > 0 ? pages : [[]];
}

function paginateAssemblyCostSections(
  lines: CostLineRow[],
): PlannedCostSection[][] {
  const pages: PlannedCostSection[][] = [];
  const append = (sections: PlannedCostSection[][]): void => {
    if (
      sections.length === 1 &&
      sections[0]?.length === 0
    ) {
      return;
    }
    pages.push(...sections);
  };

  const materialLines = lines.filter(
    (line) => line.kind === "material",
  );
  if (materialLines.length > 0) {
    append(
      paginateCostSections(
        materialLines,
        assemblyCostPageCapacity,
        assemblyCostPageCapacity,
        ["material"],
        false,
      ),
    );
  }

  const processLines = lines.filter(
    (line) => line.kind === "process",
  );
  if (processLines.length > 0) {
    append(
      paginateCostSections(
        processLines,
        assemblyCostPageCapacity,
        assemblyCostPageCapacity,
        ["process"],
        false,
      ),
    );
  }

  const fastenerAndTooling = lines.filter(
    (line) =>
      line.kind === "fastener" ||
      line.kind === "tooling",
  );
  if (fastenerAndTooling.length > 0) {
    append(
      paginateCostSections(
        fastenerAndTooling,
        assemblyCostPageCapacity,
        assemblyCostPageCapacity,
        ["fastener", "tooling"],
        true,
      ),
    );
  }
  return pages;
}

async function expandEvidencePages(
  evidence: ReportEvidence[],
): Promise<Array<Extract<Ucm25PlannedPage, { type: "evidence" }>>> {
  const result: Array<
    Extract<Ucm25PlannedPage, { type: "evidence" }>
  > = [];
  for (const item of evidence) {
    if (item.mimeType === "application/pdf") {
      const source = await PDFDocument.load(
        item.verifiedBytes,
        { updateMetadata: false },
      );
      for (
        let sourcePageIndex = 0;
        sourcePageIndex < source.getPageCount();
        sourcePageIndex += 1
      ) {
        result.push({
          type: "evidence",
          evidence: item,
          sourcePageIndex,
        });
      }
    } else {
      result.push({
        type: "evidence",
        evidence: item,
        sourcePageIndex: null,
      });
    }
  }
  return result;
}

function flattenNodes(root: ProjectNode): ProjectNode[] {
  const nodes: ProjectNode[] = [];
  const visit = (node: ProjectNode): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
}

function findNode(
  root: ProjectNode,
  nodeId: string | null,
): ProjectNode | null {
  if (!nodeId) {
    return null;
  }
  if (root.id === nodeId) {
    return root;
  }
  for (const child of root.children) {
    const found = findNode(child, nodeId);
    if (found) {
      return found;
    }
  }
  return null;
}
