import { createHash } from "node:crypto";

import {
  calculateCostLine,
  calculateNodeRollup,
  costKinds,
  type CostBreakdown,
  type CostKind,
  type CostLineResult,
  type NodeKind,
} from "@ucm/domain";
import Decimal from "decimal.js";

import {
  createFormulaFreeWorkbook,
  numericCell,
  textCell,
  type WorkbookCell,
  type WorkbookSheet,
} from "./ooxml";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SupportingCatalogueProvenance {
  releaseId: string;
  revision: string;
  itemId: string;
  catalogueId: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface SupportingCostLine {
  id: string;
  kind: CostKind;
  description: string;
  use_description: string;
  unit_cost: string;
  quantity: string;
  multiplier: string;
  multiplier_name: string | null;
  multiplier_catalogue_item_id: string | null;
  fraction_included: string;
  production_volume_factor: string | null;
  size_inputs_json: string | Record<string, string>;
  subtotal: string;
  catalogue?: SupportingCatalogueProvenance | null;
}

export interface SupportingNode {
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  system_code: string | null;
  full_number: string | null;
  reference_id: string | null;
  name: string;
  description: string;
  revision: string | null;
  procurement_type: "made" | "bought" | "unknown";
  quantity: string;
  breakdown: CostBreakdown;
  costLines: SupportingCostLine[];
  children: SupportingNode[];
}

export interface SupportingWorkbookSnapshot {
  schemaVersion: number;
  snapshotId: string;
  createdAt: string;
  mode: "draft" | "deadline" | "competition-ready" | "export";
  sources: {
    rulePack: { version: string; sha256: string };
    catalogue: {
      releaseId: string;
      revision: string;
      sha256: string;
    };
  };
  project: {
    id: string;
    name: string;
    season: number;
    entry_number: string;
    vehicle_type: string;
    rule_pack_version: string;
    catalogue_revision: string;
  };
  breakdown: CostBreakdown;
  tree: SupportingNode;
}

export interface SupportingWorkbookIssue {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  nodeId?: string;
  costLineId?: string;
}

export interface SupportingWorkbookResult {
  bytes: Uint8Array;
  sha256: string;
  byteSize: number;
  issues: SupportingWorkbookIssue[];
  nodeCount: number;
  costLineCount: number;
}

export class SupportingWorkbookValidationError extends Error {
  readonly code = "supporting-workbook-blocked";

  constructor(readonly issues: SupportingWorkbookIssue[]) {
    super(
      `Supporting workbook is blocked by ${issues.filter(({ severity }) => severity === "blocker").length} validation issue(s)`,
    );
  }
}

interface FlatNode {
  node: SupportingNode;
  parent: SupportingNode | null;
  system: SupportingNode | null;
  assembly: SupportingNode | null;
  path: string;
  direct: CostBreakdown;
}

/**
 * Produces a deterministic, formula-free XLSX from an immutable report graph.
 * Competition-ready output fails closed on calculation or provenance defects;
 * draft output includes those defects on an Issues worksheet.
 */
export function generateSupportingWorkbook(
  snapshot: SupportingWorkbookSnapshot,
): SupportingWorkbookResult {
  const issues = validateSupportingWorkbookSnapshot(snapshot);
  if (
    snapshot.mode === "competition-ready" &&
    issues.some(({ severity }) => severity === "blocker")
  ) {
    throw new SupportingWorkbookValidationError(issues);
  }

  const flat = flatten(snapshot.tree);
  const costLineCount = flat.reduce(
    (sum, { node }) => sum + node.costLines.length,
    0,
  );
  const sheets: WorkbookSheet[] = [
    manifestSheet(snapshot, flat.length, costLineCount, issues.length),
    bomSheet(flat),
    costDataSheet(snapshot, flat),
    reconciliationSheet(snapshot, flat),
  ];
  if (issues.length > 0) {
    sheets.push(issuesSheet(issues));
  }
  const bytes = createFormulaFreeWorkbook(sheets, {
    title: `${snapshot.project.name} supporting cost data`,
    subject:
      "Formula SAE-Australasia cost report supporting workbook; formula-free immutable snapshot",
    creator: "University of Canterbury Motorsport",
    createdAt: snapshot.createdAt,
  });
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    issues,
    nodeCount: flat.length,
    costLineCount,
  };
}

export function validateSupportingWorkbookSnapshot(
  snapshot: SupportingWorkbookSnapshot,
): SupportingWorkbookIssue[] {
  const issues: SupportingWorkbookIssue[] = [];
  const seenNodes = new Set<string>();
  const seenLines = new Set<string>();

  if (!SHA256_PATTERN.test(snapshot.sources.rulePack.sha256)) {
    issues.push(blocker("rule-source-hash-invalid", "Rule-pack SHA-256 is missing or invalid."));
  }
  if (!SHA256_PATTERN.test(snapshot.sources.catalogue.sha256)) {
    issues.push(blocker("catalogue-source-hash-invalid", "Catalogue SHA-256 is missing or invalid."));
  }
  if (!snapshot.project.entry_number.trim()) {
    issues.push(blocker("entry-number-missing", "The project entry number is required."));
  }

  const visit = (
    node: SupportingNode,
    expectedParentId: string | null,
  ): CostBreakdown => {
    if (seenNodes.has(node.id)) {
      issues.push({
        ...blocker("duplicate-node-id", `Duplicate node identifier ${node.id}.`),
        nodeId: node.id,
      });
    }
    seenNodes.add(node.id);
    if (node.parent_id !== expectedParentId) {
      issues.push({
        ...blocker(
          "node-parent-mismatch",
          `Node ${node.id} does not point to its containing parent.`,
        ),
        nodeId: node.id,
      });
    }
    try {
      assertPositive(node.quantity, "node quantity");
    } catch (error) {
      issues.push({
        ...blocker(
          "node-quantity-invalid",
          error instanceof Error ? error.message : "Invalid node quantity.",
        ),
        nodeId: node.id,
      });
    }

    const calculatedLines: CostLineResult[] = [];
    for (const line of node.costLines) {
      if (seenLines.has(line.id)) {
        issues.push({
          ...blocker(
            "duplicate-cost-line-id",
            `Duplicate cost-line identifier ${line.id}.`,
          ),
          nodeId: node.id,
          costLineId: line.id,
        });
      }
      seenLines.add(line.id);
      try {
        const calculated = calculateCostLine({
          kind: line.kind,
          unitCost: line.unit_cost,
          quantity: line.quantity,
          multiplier: line.multiplier,
          fractionIncluded: line.fraction_included,
          productionVolumeFactor:
            line.production_volume_factor ?? undefined,
        });
        calculatedLines.push(calculated);
        if (!decimalEqual(calculated.subtotal, line.subtotal)) {
          issues.push({
            ...blocker(
              "cost-line-subtotal-mismatch",
              `Stored subtotal ${line.subtotal} does not equal calculated subtotal ${calculated.subtotal}.`,
            ),
            nodeId: node.id,
            costLineId: line.id,
          });
        }
      } catch (error) {
        issues.push({
          ...blocker(
            "cost-line-calculation-invalid",
            error instanceof Error ? error.message : "Invalid cost line.",
          ),
          nodeId: node.id,
          costLineId: line.id,
        });
      }

      if (!line.catalogue) {
        issues.push({
          ...blocker(
            "cost-line-provenance-missing",
            "Every supporting-data row requires catalogue release, item, sheet, and source-row provenance.",
          ),
          nodeId: node.id,
          costLineId: line.id,
        });
      } else {
        if (
          line.catalogue.releaseId !== snapshot.sources.catalogue.releaseId ||
          line.catalogue.revision !== snapshot.sources.catalogue.revision
        ) {
          issues.push({
            ...blocker(
              "cost-line-release-mismatch",
              "Cost-line catalogue provenance does not match the snapshot release.",
            ),
            nodeId: node.id,
            costLineId: line.id,
          });
        }
        if (
          !line.catalogue.itemId.trim() ||
          !line.catalogue.catalogueId.trim() ||
          !line.catalogue.sourceSheet.trim() ||
          !Number.isSafeInteger(line.catalogue.sourceRow) ||
          line.catalogue.sourceRow <= 0
        ) {
          issues.push({
            ...blocker(
              "cost-line-provenance-incomplete",
              "Catalogue provenance must include stable IDs, source sheet, and positive source row.",
            ),
            nodeId: node.id,
            costLineId: line.id,
          });
        }
      }
      if (line.kind !== "tooling" && !line.multiplier_catalogue_item_id) {
        issues.push({
          ...blocker(
            "multiplier-provenance-missing",
            "Material, process, and fastener rows require a pinned catalogue multiplier.",
          ),
          nodeId: node.id,
          costLineId: line.id,
        });
      }
    }

    const children = node.children.map((child) => ({
      quantity: child.quantity,
      breakdown: visit(child, node.id),
    }));
    try {
      const calculated = calculateNodeRollup(calculatedLines, children);
      for (const key of [...costKinds, "total"] as const) {
        if (!decimalEqual(calculated[key], node.breakdown[key])) {
          issues.push({
            ...blocker(
              "node-rollup-mismatch",
              `${node.name} ${key} is ${node.breakdown[key]}, but its immutable line/child graph calculates ${calculated[key]}.`,
            ),
            nodeId: node.id,
          });
        }
      }
      return calculated;
    } catch (error) {
      issues.push({
        ...blocker(
          "node-rollup-invalid",
          error instanceof Error ? error.message : "Invalid node rollup.",
        ),
        nodeId: node.id,
      });
      return zeroBreakdown();
    }
  };

  const calculatedRoot = visit(snapshot.tree, null);
  for (const key of [...costKinds, "total"] as const) {
    if (!decimalEqual(calculatedRoot[key], snapshot.breakdown[key])) {
      issues.push(
        blocker(
          "snapshot-reconciliation-mismatch",
          `Snapshot ${key} total ${snapshot.breakdown[key]} does not reconcile to root total ${calculatedRoot[key]}.`,
        ),
      );
    }
  }
  return issues;
}

function manifestSheet(
  snapshot: SupportingWorkbookSnapshot,
  nodeCount: number,
  costLineCount: number,
  issueCount: number,
): WorkbookSheet {
  const rows = [
    header(["Field", "Immutable snapshot value"]),
    row(["Workbook schema", "UCM Supporting Cost Data v1"]),
    row(["Snapshot ID", snapshot.snapshotId]),
    row(["Snapshot created", snapshot.createdAt]),
    row(["Export mode", snapshot.mode]),
    row(["Project ID", snapshot.project.id]),
    row(["University / Team", snapshot.project.name]),
    row(["Entry number", snapshot.project.entry_number]),
    row(["Season", String(snapshot.project.season)]),
    row(["Vehicle type", snapshot.project.vehicle_type]),
    row(["Rule pack", snapshot.sources.rulePack.version]),
    row(["Rule pack SHA-256", snapshot.sources.rulePack.sha256]),
    row(["Catalogue release ID", snapshot.sources.catalogue.releaseId]),
    row(["Catalogue revision", snapshot.sources.catalogue.revision]),
    row(["Catalogue SHA-256", snapshot.sources.catalogue.sha256]),
    row(["Hierarchy records", String(nodeCount)]),
    row(["Cost-data rows", String(costLineCount)]),
    row(["Validation issues", String(issueCount)]),
    row([
      "Calculation policy",
      "Formula-free stored values from the immutable report snapshot. Material/Process/Fastener = unit cost × quantity × pinned multiplier. Tooling = unit cost × quantity × fraction included ÷ explicit production-volume factor. No workbook formula can recalculate a submitted value.",
    ]),
  ];
  return {
    name: "Submission Manifest",
    rows,
    headerRows: 1,
    columnWidths: [28, 105],
  };
}

function bomSheet(flat: readonly FlatNode[]): WorkbookSheet {
  const headings = [
    "Node ID",
    "Parent Node ID",
    "Hierarchy Path",
    "Record Type",
    "System",
    "Assembly / Subassembly",
    "Part / Record Number",
    "Reference ID",
    "Description",
    "Revision",
    "Made / Bought",
    "Quantity",
    "Direct Material",
    "Direct Process",
    "Direct Fastener",
    "Direct Tooling",
    "Direct Total",
    "Rolled Material",
    "Rolled Process",
    "Rolled Fastener",
    "Rolled Tooling",
    "Rolled Total",
    "Extended Rolled Total",
  ];
  const rows: WorkbookCell[][] = [header(headings)];
  for (const entry of flat) {
    const { node, parent, system, assembly, path, direct } = entry;
    rows.push([
      textCell(node.id, 2),
      textCell(parent?.id ?? "", 2),
      textCell(path, 2),
      textCell(node.kind, 2),
      textCell(system?.system_code ?? system?.name ?? "", 2),
      textCell(assembly?.name ?? "", 2),
      textCell(node.full_number ?? node.name, 2),
      textCell(node.reference_id ?? "", 2),
      textCell(node.description || node.name, 2),
      textCell(node.revision ?? "", 2),
      textCell(node.procurement_type, 2),
      decimalCell(node.quantity),
      ...breakdownCells(direct),
      ...breakdownCells(node.breakdown),
      decimalCell(
        new Decimal(node.breakdown.total).times(node.quantity).toString(),
      ),
    ]);
  }
  return {
    name: "BOM",
    rows,
    headerRows: 1,
    autoFilter: true,
    columnWidths: [
      38, 38, 55, 16, 16, 28, 24, 20, 45, 12, 16, 13, 16, 16, 16, 16, 16, 16,
      16, 16, 16, 16, 20,
    ],
  };
}

function costDataSheet(
  snapshot: SupportingWorkbookSnapshot,
  flat: readonly FlatNode[],
): WorkbookSheet {
  const headings = [
    "Snapshot ID",
    "Node ID",
    "Parent Node ID",
    "Hierarchy Path",
    "Record Type",
    "System",
    "Assembly / Subassembly",
    "Part / Record Number",
    "Node Description",
    "Revision",
    "Made / Bought",
    "Node Quantity",
    "Cost Line ID",
    "Cost BoX",
    "Catalogue Release ID",
    "Catalogue Revision",
    "Catalogue Item DB ID",
    "Catalogue Item ID",
    "Catalogue Source Sheet",
    "Catalogue Source Row",
    "Cost Description",
    "Use / Notes",
    "Unit Cost",
    "Cost Quantity",
    "Multiplier Name",
    "Multiplier",
    "Multiplier Catalogue Item ID",
    "Tooling Fraction Included",
    "Tooling Production Volume Factor",
    "Size Inputs",
    "Exact Subtotal",
  ];
  const rows: WorkbookCell[][] = [header(headings)];
  for (const { node, parent, system, assembly, path } of flat) {
    for (const line of node.costLines) {
      rows.push([
        textCell(snapshot.snapshotId, 2),
        textCell(node.id, 2),
        textCell(parent?.id ?? "", 2),
        textCell(path, 2),
        textCell(node.kind, 2),
        textCell(system?.system_code ?? system?.name ?? "", 2),
        textCell(assembly?.name ?? "", 2),
        textCell(node.full_number ?? node.name, 2),
        textCell(node.description || node.name, 2),
        textCell(node.revision ?? "", 2),
        textCell(node.procurement_type, 2),
        decimalCell(node.quantity),
        textCell(line.id, 2),
        textCell(line.kind, 2),
        textCell(line.catalogue?.releaseId ?? "", 2),
        textCell(line.catalogue?.revision ?? "", 2),
        textCell(line.catalogue?.itemId ?? "", 2),
        textCell(line.catalogue?.catalogueId ?? "", 2),
        textCell(line.catalogue?.sourceSheet ?? "", 2),
        line.catalogue
          ? numericCell(String(line.catalogue.sourceRow), 3)
          : textCell("", 2),
        textCell(line.description, 2),
        textCell(line.use_description, 2),
        decimalCell(line.unit_cost),
        decimalCell(line.quantity),
        textCell(line.multiplier_name ?? "", 2),
        decimalCell(line.multiplier),
        textCell(line.multiplier_catalogue_item_id ?? "", 2),
        decimalCell(line.fraction_included),
        line.production_volume_factor === null
          ? textCell("", 2)
          : decimalCell(line.production_volume_factor),
        textCell(canonicalObjectJson(line.size_inputs_json), 2),
        decimalCell(line.subtotal),
      ]);
    }
  }
  return {
    name: "Cost Data",
    rows,
    headerRows: 1,
    autoFilter: true,
    columnWidths: [
      38, 38, 38, 55, 16, 16, 28, 24, 45, 12, 16, 13, 38, 14, 38, 18, 38, 20,
      22, 14, 38, 38, 16, 16, 24, 14, 38, 20, 24, 42, 18,
    ],
  };
}

function reconciliationSheet(
  snapshot: SupportingWorkbookSnapshot,
  flat: readonly FlatNode[],
): WorkbookSheet {
  const rows: WorkbookCell[][] = [
    header([
      "Level",
      "Identifier",
      "Material",
      "Process",
      "Fastener",
      "Tooling",
      "Total",
      "Snapshot ID",
    ]),
    [
      textCell("Project", 2),
      textCell(snapshot.project.id, 2),
      ...breakdownCells(snapshot.breakdown),
      textCell(snapshot.snapshotId, 2),
    ],
  ];
  for (const { node } of flat) {
    rows.push([
      textCell(node.kind, 2),
      textCell(node.id, 2),
      ...breakdownCells(node.breakdown),
      textCell(snapshot.snapshotId, 2),
    ]);
  }
  return {
    name: "Reconciliation",
    rows,
    headerRows: 1,
    autoFilter: true,
    columnWidths: [18, 38, 18, 18, 18, 18, 18, 38],
  };
}

function issuesSheet(
  issues: readonly SupportingWorkbookIssue[],
): WorkbookSheet {
  return {
    name: "Issues",
    rows: [
      header(["Severity", "Code", "Message", "Node ID", "Cost Line ID"]),
      ...issues.map((issue) => [
        textCell(issue.severity, 2),
        textCell(issue.code, 2),
        textCell(issue.message, 2),
        textCell(issue.nodeId ?? "", 2),
        textCell(issue.costLineId ?? "", 2),
      ]),
    ],
    headerRows: 1,
    autoFilter: true,
    columnWidths: [14, 38, 105, 38, 38],
  };
}

function flatten(root: SupportingNode): FlatNode[] {
  const result: FlatNode[] = [];
  const visit = (
    node: SupportingNode,
    parent: SupportingNode | null,
    system: SupportingNode | null,
    assembly: SupportingNode | null,
    pathParts: string[],
  ): void => {
    const resolvedSystem = node.kind === "system" ? node : system;
    const resolvedAssembly =
      node.kind === "assembly" || node.kind === "subassembly"
        ? node
        : assembly;
    const path = [...pathParts, node.name].join(" / ");
    result.push({
      node,
      parent,
      system: resolvedSystem,
      assembly: resolvedAssembly,
      path,
      direct: directBreakdown(node.costLines),
    });
    node.children.forEach((child) =>
      visit(
        child,
        node,
        resolvedSystem,
        resolvedAssembly,
        [...pathParts, node.name],
      ),
    );
  };
  visit(root, null, null, null, []);
  return result;
}

function directBreakdown(lines: readonly SupportingCostLine[]): CostBreakdown {
  const buckets: Record<CostKind, Decimal> = {
    material: new Decimal(0),
    process: new Decimal(0),
    fastener: new Decimal(0),
    tooling: new Decimal(0),
  };
  for (const line of lines) {
    buckets[line.kind] = buckets[line.kind].plus(line.subtotal);
  }
  const total = costKinds.reduce(
    (sum, kind) => sum.plus(buckets[kind]),
    new Decimal(0),
  );
  return {
    material: buckets.material.toString(),
    process: buckets.process.toString(),
    fastener: buckets.fastener.toString(),
    tooling: buckets.tooling.toString(),
    total: total.toString(),
  };
}

function breakdownCells(breakdown: CostBreakdown): WorkbookCell[] {
  return [
    decimalCell(breakdown.material),
    decimalCell(breakdown.process),
    decimalCell(breakdown.fastener),
    decimalCell(breakdown.tooling),
    decimalCell(breakdown.total),
  ];
}

function decimalCell(value: string): WorkbookCell {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) {
    throw new Error(`invalid decimal workbook value: ${value}`);
  }
  return numericCell(decimal.toSignificantDigits(24).toString(), 3);
}

function decimalEqual(left: string, right: string): boolean {
  try {
    return new Decimal(left).equals(new Decimal(right));
  } catch {
    return false;
  }
}

function assertPositive(value: string, field: string): void {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || !decimal.greaterThan(0)) {
    throw new Error(`${field} must be a finite decimal greater than zero`);
  }
}

function blocker(
  code: string,
  message: string,
): SupportingWorkbookIssue {
  return { code, severity: "blocker", message };
}

function zeroBreakdown(): CostBreakdown {
  return {
    material: "0",
    process: "0",
    fastener: "0",
    tooling: "0",
    total: "0",
  };
}

function header(values: readonly string[]): WorkbookCell[] {
  return values.map((value) => textCell(value, 1));
}

function row(values: readonly string[]): WorkbookCell[] {
  return values.map((value) => textCell(value, 2));
}

function canonicalObjectJson(
  value: string | Record<string, string>,
): string {
  let parsed: Record<string, string>;
  if (typeof value === "string") {
    try {
      const candidate: unknown = JSON.parse(value);
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        return value;
      }
      parsed = Object.fromEntries(
        Object.entries(candidate).map(([key, item]) => [key, String(item)]),
      );
    } catch {
      return value;
    }
  } else {
    parsed = value;
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}
