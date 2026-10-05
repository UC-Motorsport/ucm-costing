import { createHash } from "node:crypto";

import {
  calculateCostAmendmentFromItems,
  costKinds,
  displayUniversalDollars,
  validateAmendmentWorkflow,
  type AmendmentClarifications,
  type AmendmentWorkflowItem,
  type CostAmendmentResult,
  type CostBreakdown,
  type CostKind,
  type RuleWorkflowIssue,
} from "@ucm/domain";
import Decimal from "decimal.js";
import PDFDocument from "pdfkit";

const MAX_AMENDMENT_ITEMS = 20_000;

export interface CostAmendmentReportPart {
  partIdentity: string;
  partNumber: string;
  description: string;
  originalQuantity: string;
  revisedQuantity: string;
  original: CostBreakdown;
}

export interface CostAmendmentReportItem extends AmendmentWorkflowItem {
  nodeId: string | null;
  description: string;
  quantity: string;
  unitCost: string;
  subtotal: string;
  catalogueReleaseId: string;
  catalogueItemId: string;
  catalogueId: string;
}

export interface CostAmendmentReportInput {
  schemaVersion: 1;
  amendmentId: string;
  amendmentVersion?: number;
  eventReference: string;
  createdAt: string;
  project: {
    id: string;
    name: string;
    entryNumber: string;
  };
  baseReport: {
    snapshotId: string;
    sha256: string;
    breakdown: CostBreakdown;
  };
  rulePack: {
    version: string;
    sha256: string;
  };
  catalogue: {
    releaseId: string;
    revision: string;
    sha256: string;
  };
  parts: CostAmendmentReportPart[];
  items: CostAmendmentReportItem[];
  clarifications?: AmendmentClarifications;
}

export interface CostAmendmentPartResult
  extends CostAmendmentReportPart {
  calculation: CostAmendmentResult;
}

export interface CostAmendmentReportSnapshot {
  schemaVersion: 1;
  amendmentId: string;
  amendmentVersion: number;
  eventReference: string;
  createdAt: string;
  project: CostAmendmentReportInput["project"];
  baseReport: CostAmendmentReportInput["baseReport"];
  rulePack: CostAmendmentReportInput["rulePack"];
  catalogue: CostAmendmentReportInput["catalogue"];
  calculation: CostAmendmentResult;
  parts: CostAmendmentPartResult[];
  items: CostAmendmentReportItem[];
  issues: RuleWorkflowIssue[];
  previewOnly: true;
  watermark: "PREVIEW — NOT FOR SUBMISSION";
}

export interface RenderedCostAmendmentPreview {
  bytes: Uint8Array;
  sha256: string;
  byteSize: number;
  pageCount: number;
  snapshot: CostAmendmentReportSnapshot;
}

export class CostAmendmentValidationError extends Error {
  readonly code = "cost-amendment-invalid";

  constructor(readonly issues: RuleWorkflowIssue[]) {
    super(
      `Cost amendment contains ${issues.filter(({ severity }) => severity === "blocker").length} blocking issue(s)`,
    );
  }
}

/**
 * Freezes exact report-wide and per-part amendment math. The result is always
 * marked preview-only because the verified 2026 organizer template is absent.
 */
export function buildCostAmendmentSnapshot(
  input: CostAmendmentReportInput,
): CostAmendmentReportSnapshot {
  if (input.items.length > MAX_AMENDMENT_ITEMS) {
    throw new Error("cost amendment exceeds the item limit");
  }
  const amendmentVersion = input.amendmentVersion ?? 0;
  if (
    !Number.isSafeInteger(amendmentVersion) ||
    amendmentVersion < 0
  ) {
    throw new Error("cost amendment version is invalid");
  }
  const issues = validateAmendmentWorkflow(
    input.items,
    input.clarifications,
  );
  const partByIdentity = new Map(
    input.parts.map((part) => [part.partIdentity, part]),
  );
  if (partByIdentity.size !== input.parts.length) {
    issues.push(blockingIssue(
      "amendment-part-identity-duplicate",
      "Every amendment cover part must have a unique stable identity.",
    ));
  }

  for (const item of input.items) {
    const part = partByIdentity.get(item.partIdentity);
    if (!part) {
      issues.push(blockingIssue(
        "amendment-part-missing",
        `Amendment row ${item.id} does not have a matching cover part.`,
        [item.id],
      ));
    } else if (
      !decimalEqual(part.originalQuantity, item.originalQuantity) ||
      !decimalEqual(part.revisedQuantity, item.revisedQuantity)
    ) {
      issues.push(blockingIssue(
        "amendment-part-quantity-mismatch",
        `Amendment row ${item.id} does not preserve the cover's original/revised quantities.`,
        [item.id],
      ));
    }
    try {
      const calculatedSubtotal = positiveOrZero(
        item.unitCost,
        "unit cost",
      ).times(positive(item.quantity, "quantity"));
      if (!calculatedSubtotal.equals(item.subtotal)) {
        issues.push(blockingIssue(
          "amendment-item-subtotal-mismatch",
          `Amendment row ${item.id} subtotal ${item.subtotal} does not equal unit cost × quantity (${calculatedSubtotal.toString()}).`,
          [item.id],
        ));
      }
    } catch (error) {
      issues.push(blockingIssue(
        "amendment-item-value-invalid",
        error instanceof Error ? error.message : "Invalid amendment value.",
        [item.id],
      ));
    }
    if (
      item.catalogueReleaseId !== input.catalogue.releaseId ||
      !item.catalogueItemId.trim() ||
      !item.catalogueId.trim()
    ) {
      issues.push(blockingIssue(
        "amendment-item-provenance-invalid",
        `Amendment row ${item.id} is not linked to the frozen official catalogue release.`,
        [item.id],
      ));
    }
  }

  const calculation = calculateCostAmendmentFromItems(
    input.baseReport.breakdown,
    amendmentCalculationItems(input.items),
  );
  validateNonNegativeRevised(calculation, issues, "report");

  const parts = input.parts.map((part) => {
    const calculation = calculateCostAmendmentFromItems(
      part.original,
      amendmentCalculationItems(
        input.items.filter(
          ({ partIdentity }) => partIdentity === part.partIdentity,
        ),
      ),
    );
    validateNonNegativeRevised(
      calculation,
      issues,
      `part ${part.partNumber}`,
    );
    return { ...part, calculation };
  });

  return {
    schemaVersion: 1,
    amendmentId: input.amendmentId,
    amendmentVersion,
    eventReference: input.eventReference,
    createdAt: new Date(input.createdAt).toISOString(),
    project: input.project,
    baseReport: input.baseReport,
    rulePack: input.rulePack,
    catalogue: input.catalogue,
    calculation,
    parts,
    items: [...input.items],
    issues,
    previewOnly: true,
    watermark: "PREVIEW — NOT FOR SUBMISSION",
  };
}

/**
 * Renders an honest review artifact. This is deliberately not named or exposed
 * as a final CAR renderer while the promised official template is unavailable.
 */
export async function renderCostAmendmentPreview(
  input: CostAmendmentReportInput,
): Promise<RenderedCostAmendmentPreview> {
  const snapshot = buildCostAmendmentSnapshot(input);
  const { bytes, pageCount } = await renderPreviewPdf(snapshot);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    pageCount,
    snapshot,
  };
}

export function assertCostAmendmentCanLock(
  snapshot: CostAmendmentReportSnapshot,
): void {
  const issues = [
    ...snapshot.issues,
    blockingIssue(
      "amendment-official-renderer-unavailable",
      "The checked-in rule package does not contain the official 2026 CAR template, so this preview cannot be locked or represented as a final submission artifact.",
    ),
  ];
  throw new CostAmendmentValidationError(issues);
}

async function renderPreviewPdf(
  snapshot: CostAmendmentReportSnapshot,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let renderedPageCount = 0;
    const document = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 45, bottom: 42, left: 42, right: 42 },
      autoFirstPage: true,
      bufferPages: true,
      info: {
        Title: `${snapshot.project.name} Cost Amendment Report Preview`,
        Author: "University of Canterbury Motorsport",
        Subject: "Formula SAE-Australasia 2026 CAR review preview",
      },
    });
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => {
      resolve({
        bytes: new Uint8Array(Buffer.concat(chunks)),
        pageCount: renderedPageCount,
      });
    });

    const addPage = (heading: string): void => {
      document.addPage();
      pageHeading(document, heading);
    };
    const ensure = (height: number, heading: string): void => {
      if (document.y + height > document.page.height - 50) {
        addPage(heading);
      }
    };

    pageHeading(document, "Cost Amendment Report — review preview");
    document
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor("#153a5b")
      .text(snapshot.project.name);
    document
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#27313a")
      .moveDown(0.4)
      .text(`Entry number: ${snapshot.project.entryNumber}`)
      .text(`Event reference: ${snapshot.eventReference}`)
      .text(`Base report snapshot: ${snapshot.baseReport.snapshotId}`)
      .text(`Created: ${snapshot.createdAt}`)
      .moveDown(0.8)
      .font("Helvetica-Bold")
      .text(
        "Published equation by cost BoX: delta = 1.05 × additions − 0.95 × removals",
      )
      .font("Helvetica")
      .text(
        "Raw revised = original + additions − removals. Adjusted revised = original + delta. Values are rounded only for display.",
      );

    drawSummaryTable(document, snapshot.calculation);
    document.moveDown(1);
    document.font("Helvetica-Bold").fillColor("#9d1b20").text(
      "Submission blockers / unresolved organizer instructions",
    );
    document.font("Helvetica").fillColor("#27313a");
    const blockers = snapshot.issues.filter(
      ({ severity }) => severity === "blocker",
    );
    if (blockers.length === 0) {
      document.text(
        "The official-template renderer is still unavailable; this artifact remains a preview.",
      );
    } else {
      for (const issue of blockers) {
        ensure(22, "Cost Amendment Report — blockers");
        document.text(`• ${issue.message}`, { indent: 8 });
      }
    }

    addPage("Cost Amendment Report — cover comparison");
    drawPartComparisonHeader(document);
    for (const part of snapshot.parts) {
      ensure(28, "Cost Amendment Report — cover comparison");
      drawPartComparisonRow(document, part);
    }

    addPage("Cost Amendment Report — change rows");
    drawChangeHeader(document);
    for (const item of snapshot.items) {
      ensure(28, "Cost Amendment Report — change rows");
      drawChangeRow(document, item);
    }

    const pageRange = document.bufferedPageRange();
    renderedPageCount = pageRange.count;
    for (
      let pageIndex = pageRange.start;
      pageIndex < pageRange.start + pageRange.count;
      pageIndex += 1
    ) {
      document.switchToPage(pageIndex);
      drawWatermark(document);
      document
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#68717a")
        .text(
          `${snapshot.rulePack.version} · ${snapshot.catalogue.revision} · snapshot ${snapshot.baseReport.snapshotId}`,
          42,
          document.page.height - 70,
          { width: document.page.width - 84, lineBreak: false },
        )
        .text(
          `Page ${pageIndex - pageRange.start + 1} of ${pageRange.count}`,
          42,
          document.page.height - 70,
          {
            width: document.page.width - 84,
            align: "right",
            lineBreak: false,
          },
        );
    }
    document.end();
  });
}

function pageHeading(document: PDFKit.PDFDocument, title: string): void {
  document
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#9d1b20")
    .text("UNIVERSITY OF CANTERBURY MOTORSPORT", { align: "right" })
    .fontSize(18)
    .fillColor("#153a5b")
    .text(title)
    .moveDown(0.5);
}

function drawSummaryTable(
  document: PDFKit.PDFDocument,
  result: CostAmendmentResult,
): void {
  document.moveDown(0.8);
  const x = 42;
  const widths = [90, 75, 75, 75, 80, 80, 85];
  drawTableRow(
    document,
    x,
    document.y,
    widths,
    [
      "Cost BoX",
      "Original",
      "Additions",
      "Removals",
      "Raw revised",
      "Amend. delta",
      "Adjusted",
    ],
    true,
  );
  document.y += 22;
  for (const kind of [...costKinds, "total"] as const) {
    const values =
      kind === "total"
        ? {
            original: result.original.total,
            additions: result.additions.total,
            removals: result.removals.total,
            rawRevised: result.rawRevised.total,
            amendmentDelta: result.amendmentDelta.total,
            adjustedRevised: result.adjustedRevised.total,
          }
        : result.buckets[kind];
    drawTableRow(
      document,
      x,
      document.y,
      widths,
      [
        kind === "total" ? "TOTAL" : titleCase(kind),
        money(values.original),
        money(values.additions),
        money(values.removals),
        money(values.rawRevised),
        money(values.amendmentDelta),
        money(values.adjustedRevised),
      ],
      kind === "total",
    );
    document.y += 20;
  }
}

function drawPartComparisonHeader(document: PDFKit.PDFDocument): void {
  drawTableRow(
    document,
    42,
    document.y,
    [80, 160, 58, 58, 80, 80, 80],
    [
      "Part no.",
      "Description",
      "Orig. QTY",
      "Rev. QTY",
      "Original total",
      "Raw revised",
      "Adjusted total",
    ],
    true,
  );
  document.y += 22;
}

function drawPartComparisonRow(
  document: PDFKit.PDFDocument,
  part: CostAmendmentPartResult,
): void {
  drawTableRow(
    document,
    42,
    document.y,
    [80, 160, 58, 58, 80, 80, 80],
    [
      part.partNumber,
      part.description,
      part.originalQuantity,
      part.revisedQuantity,
      money(part.calculation.original.total),
      money(part.calculation.rawRevised.total),
      money(part.calculation.adjustedRevised.total),
    ],
    false,
  );
  document.y += 25;
}

function drawChangeHeader(document: PDFKit.PDFDocument): void {
  drawTableRow(
    document,
    42,
    document.y,
    [72, 82, 84, 82, 145, 55, 70, 80],
    [
      "Part",
      "Action",
      "Classification",
      "Cost BoX",
      "Description",
      "QTY",
      "Unit cost",
      "Subtotal",
    ],
    true,
  );
  document.y += 22;
}

function drawChangeRow(
  document: PDFKit.PDFDocument,
  item: CostAmendmentReportItem,
): void {
  drawTableRow(
    document,
    42,
    document.y,
    [72, 82, 84, 82, 145, 55, 70, 80],
    [
      item.partIdentity,
      item.action,
      item.classification,
      item.costBox,
      item.description,
      item.quantity,
      money(item.unitCost),
      money(item.subtotal),
    ],
    false,
  );
  document.y += 25;
}

function drawTableRow(
  document: PDFKit.PDFDocument,
  x: number,
  y: number,
  widths: readonly number[],
  values: readonly string[],
  header: boolean,
): void {
  let currentX = x;
  for (const [index, width] of widths.entries()) {
    document
      .rect(currentX, y, width, header ? 22 : 25)
      .fillAndStroke(header ? "#153a5b" : "#ffffff", "#aeb8c1");
    document
      .font(header ? "Helvetica-Bold" : "Helvetica")
      .fontSize(header ? 7.5 : 7)
      .fillColor(header ? "#ffffff" : "#27313a")
      .text(values[index] ?? "", currentX + 3, y + 5, {
        width: width - 6,
        height: header ? 14 : 17,
        ellipsis: true,
        align: index >= values.length - 5 ? "right" : "left",
      });
    currentX += width;
  }
}

function drawWatermark(document: PDFKit.PDFDocument): void {
  document.save();
  document
    .rotate(-28, {
      origin: [document.page.width / 2, document.page.height / 2],
    })
    .font("Helvetica-Bold")
    .fontSize(52)
    .fillColor("#c7cbd0", 0.22)
    .text(
      "PREVIEW — NOT FOR SUBMISSION",
      90,
      document.page.height / 2 - 25,
      {
        width: document.page.width - 180,
        align: "center",
        lineBreak: false,
      },
    );
  document.restore();
}

function validateNonNegativeRevised(
  calculation: CostAmendmentResult,
  issues: RuleWorkflowIssue[],
  context: string,
): void {
  for (const kind of costKinds) {
    if (
      new Decimal(calculation.buckets[kind].rawRevised).isNegative() ||
      new Decimal(calculation.buckets[kind].adjustedRevised).isNegative()
    ) {
      issues.push(blockingIssue(
        "amendment-negative-revised-cost",
        `The ${context} ${kind} revised cost is negative; additions/removals do not reconcile to the frozen original.`,
      ));
    }
  }
}

function positive(value: string, field: string): Decimal {
  const result = positiveOrZero(value, field);
  if (!result.greaterThan(0)) {
    throw new Error(`${field} must be greater than zero`);
  }
  return result;
}

function positiveOrZero(value: string, field: string): Decimal {
  try {
    const result = new Decimal(value);
    if (!result.isFinite() || result.isNegative()) {
      throw new Error();
    }
    return result;
  } catch {
    throw new Error(`${field} must be a finite non-negative decimal`);
  }
}

function decimalEqual(left: string, right: string): boolean {
  try {
    return new Decimal(left).equals(right);
  } catch {
    return false;
  }
}

function blockingIssue(
  code: string,
  message: string,
  itemIds: string[] = [],
): RuleWorkflowIssue {
  return { code, severity: "blocker", message, itemIds };
}

function money(value: string): string {
  return `U$ ${displayUniversalDollars(value)}`;
}

function titleCase(value: CostKind): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function amendmentCalculationItems(
  items: readonly CostAmendmentReportItem[],
): Array<{
  kind: CostKind;
  action: "add" | "remove";
  subtotal: string;
}> {
  return items.map(({ costBox, action, subtotal }) => ({
    kind: costBox,
    action,
    subtotal,
  }));
}
