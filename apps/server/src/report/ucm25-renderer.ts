import fs from "node:fs";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fontkit from "@pdf-lib/fontkit";
import {
  costKinds,
  displayUniversalDollars,
  type CostBreakdown,
  type CostKind,
} from "@ucm/domain";
import Decimal from "decimal.js";
import {
  degrees,
  PDFDocument as PDFLibDocument,
  rgb,
} from "pdf-lib";
import PDFDocument from "pdfkit";

import type { AppPaths } from "../config";
import {
  systemDefinitions,
  systemName,
} from "../domain/systems";
import type {
  CostLineRow,
  ProjectDetail,
  ProjectNode,
} from "../services/project-types";
import type { ValidationResult } from "../services/validation-service";
import { rasterizePdfPage } from "./pdf-rasterizer";
import {
  appendValidationPages,
  buildUcm25ReportPlan,
  COST_DATA_ROW_HEIGHT,
  COST_PAGE_START_Y,
  COST_SECTION_GAP,
  COST_SECTION_HEADER_HEIGHT,
  COST_SECTION_SUBTOTAL_HEIGHT,
  FIRST_PART_COST_START_Y,
  type PlannedCostSection,
  type ReportEvidence,
  type Ucm25PlannedPage,
  type Ucm25ReportPlan,
} from "./ucm25-plan";

export type { ReportEvidence } from "./ucm25-plan";

export type ReportMode =
  | "draft"
  | "deadline"
  | "competition-ready"
  | "export";

export interface RenderInput {
  destination: string;
  detail: ProjectDetail;
  validation: ValidationResult;
  mode: ReportMode;
  evidence: ReportEvidence[];
  paths: AppPaths;
  createdAt: string;
}

interface RenderContext extends Omit<RenderInput, "destination"> {
  plan: Ucm25ReportPlan;
  ucmMarkPath: string;
  ucmMarkOnlyPath: string;
  formulaLogoPath: string;
}

const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const REPORT_RED = "#c90018";
const DARK_RED = "#a40016";
const TEXT = "#26272a";
const MUTED = "#505050";
const GRID = "#000000";
const LIGHT_CELL = "#f5f5f5";
const DRAFT_MISSING_NUMBER = "MISSING - DRAFT";
const DRAFT_MISSING_REVISION = "MISSING";
const DEADLINE_MISSING_NUMBER = "MISSING - INCOMPLETE";
const DEADLINE_MISSING_REVISION = "INCOMPLETE";
const CARLITO_REGULAR_PATH = fileURLToPath(
  import.meta.resolve(
    "@fontsource/carlito/files/carlito-latin-400-normal.woff",
  ),
);
const CARLITO_BOLD_PATH = fileURLToPath(
  import.meta.resolve(
    "@fontsource/carlito/files/carlito-latin-700-normal.woff",
  ),
);
const CARLITO_ITALIC_PATH = fileURLToPath(
  import.meta.resolve(
    "@fontsource/carlito/files/carlito-latin-400-italic.woff",
  ),
);
const CARLITO_BOLD_ITALIC_PATH = fileURLToPath(
  import.meta.resolve(
    "@fontsource/carlito/files/carlito-latin-700-italic.woff",
  ),
);

const summaryColors: Record<string, string> = {
  BR: "#8DB4E2",
  DR: "#99FF99",
  CH: "#FF66CC",
  AD: "#F2F2F2",
  EL: "#FCD5B4",
  MS: "#B1A0C7",
  ST: "#F9B739",
  SU: "#FFFF00",
  WT: "#DCE6F1",
  AV: "#00FF00",
};

const sheetColors: Record<string, string> = {
  BR: "#B2B2FF",
  DR: "#D9D9D9",
  CH: "#FFEDED",
  AD: "#D9D9D9",
  EL: "#FFB366",
  MS: "#EDB2C7",
  ST: "#EDD9C7",
  SU: "#FFF28C",
  WT: "#B2B2B2",
  AV: "#D9D9D9",
};

const reportSystemNames: Record<string, string> = {
  BR: "Brake System",
  DR: "Engine/Tractive Path and Drivetrain",
  CH: "Chassis",
  AD: "Aerodynamics",
  EL: "Electrical System",
  MS: "Miscellaneous, Fit, and Finish",
  ST: "Steering System",
  SU: "Suspension",
  WT: "Wheels & Tires",
  AV: "Autonomous Systems",
};

export async function renderUcm25CompatibleReport(
  input: RenderInput,
): Promise<number> {
  assertRendererIdentity(input.detail, input.mode);
  const plan = appendValidationPages(
    await buildUcm25ReportPlan(
      input.detail,
      input.evidence,
    ),
    input.validation.issues,
    input.mode,
  );
  const context: RenderContext = {
    ...input,
    plan,
    ucmMarkPath: path.join(
      input.paths.repositoryRoot,
      "apps",
      "server",
      "assets",
      "ucm-mark.png",
    ),
    ucmMarkOnlyPath: path.join(
      input.paths.repositoryRoot,
      "apps",
      "server",
      "assets",
      "ucm-mark-only.png",
    ),
    formulaLogoPath: path.join(
      input.paths.repositoryRoot,
      "apps",
      "server",
      "assets",
      "formula-sae-australasia-logo.jpg",
    ),
  };
  const basePath = `${input.destination}.base`;
  try {
    await renderBasePdf(basePath, context);
    await replaceEvidencePlaceholders(
      basePath,
      input.destination,
      context,
    );
  } finally {
    await unlink(basePath).catch(() => undefined);
  }
  return plan.pages.length;
}

async function renderBasePdf(
  destination: string,
  context: RenderContext,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(destination, { flags: "wx" });
    const document = new PDFDocument({
      autoFirstPage: false,
      font: CARLITO_REGULAR_PATH,
      margin: 0,
      info: {
        Title: `${context.detail.project.name} Cost Report`,
        Author: "University of Canterbury Motorsport",
        Subject:
          "Formula SAE-Australasia 2026 Cost and Manufacturing Report",
        Keywords:
          "Formula SAE-A, UCM, costing, bill of materials, UCM25-compatible",
        CreationDate: new Date(context.createdAt),
      },
    });
    registerReportFonts(document);
    document.pipe(stream);
    stream.on("error", reject);
    stream.on("finish", resolve);
    document.on("error", reject);

    for (const [index, page] of context.plan.pages.entries()) {
      const orientation = pageOrientation(page);
      document.addPage({
        size: "A4",
        layout: orientation,
        margin: 0,
      });
      drawPlannedPage(document, page, index + 1, context);
    }
    document.end();
  });
}

function registerReportFonts(document: PDFKit.PDFDocument): void {
  document
    .registerFont("Carlito", CARLITO_REGULAR_PATH)
    .registerFont("Carlito-Bold", CARLITO_BOLD_PATH)
    .registerFont("Carlito-Oblique", CARLITO_ITALIC_PATH)
    .registerFont("Carlito-BoldOblique", CARLITO_BOLD_ITALIC_PATH);
}

function pageOrientation(
  page: Ucm25PlannedPage,
): "portrait" | "landscape" {
  if (
    page.type === "cover" ||
    page.type === "project-summary" ||
    page.type === "cost-summary"
  ) {
    return "portrait";
  }
  return "landscape";
}

function drawPlannedPage(
  document: PDFKit.PDFDocument,
  page: Ucm25PlannedPage,
  pageNumber: number,
  context: RenderContext,
): void {
  switch (page.type) {
    case "cover":
      drawCover(document, context);
      return;
    case "project-summary":
      drawProjectSummary(document, context);
      return;
    case "vehicle-drawing":
      drawVehicleDrawing(document, context, page.evidence);
      return;
    case "cost-summary":
      drawCostSummary(document, context);
      return;
    case "bom":
      drawBomPage(document, page, context);
      return;
    case "system-hierarchy":
      drawHierarchyPage(document, page.system, context);
      return;
    case "assembly":
      drawAssemblyPage(
        document,
        page.system,
        page.node,
        page.evidence,
        page.children,
        page.showContentsSubtotal,
        context,
      );
      return;
    case "assembly-contents":
      drawAssemblyContentsPage(
        document,
        page.node,
        page.children,
        page.showSubtotal,
      );
      return;
    case "assembly-cost":
      drawAssemblyCostPage(
        document,
        page.system,
        page.node,
        page.sections,
        page.continued,
      );
      return;
    case "part":
      drawPartPage(
        document,
        page.system,
        page.assembly,
        page.node,
        page.sections,
        page.continued,
        page.evidence,
        context,
      );
      return;
    case "project-drawing":
      drawProjectTechnicalFrame(
        document,
        page.system,
        page.node,
        page.evidence,
        context,
      );
      return;
    case "evidence":
      drawEvidencePlaceholder(document, page, pageNumber);
      return;
    case "validation":
      drawValidationPage(document, page, context);
  }
}

function drawValidationPage(
  document: PDFKit.PDFDocument,
  page: Extract<Ucm25PlannedPage, { type: "validation" }>,
  context: RenderContext,
): void {
  const deadline = context.mode === "deadline";
  document
    .font("Carlito-Bold")
    .fontSize(18)
    .fillColor(deadline ? DARK_RED : TEXT)
    .text(
      deadline
        ? `Deadline fallback — incomplete${page.continued ? " (continued)" : ""}`
        : `Draft validation findings${page.continued ? " (continued)" : ""}`,
      34,
      28,
      { width: 774 },
    )
    .font("Carlito")
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(
      deadline
        ? "This immutable fallback records the work completed by the deadline. It is not competition-ready and cannot be used to prepare a submission package."
        : "These findings were frozen with this draft snapshot. Resolve blockers before generating a competition-ready report.",
      34,
      55,
      { width: 774 },
    )
    .font("Carlito-Bold")
    .fontSize(8)
    .fillColor(TEXT)
    .text(
      `${context.validation.blockers} blocker${context.validation.blockers === 1 ? "" : "s"} · ${context.validation.warnings} warning${context.validation.warnings === 1 ? "" : "s"} · ${context.validation.notices} notice${context.validation.notices === 1 ? "" : "s"}`,
      34,
      77,
      { width: 774 },
    );

  page.issues.forEach((issue, index) => {
    const y = 98 + index * 44;
    const severityColor =
      issue.severity === "blocker"
        ? DARK_RED
        : issue.severity === "warning"
          ? "#9a5b00"
          : "#41606f";
    document
      .save()
      .lineWidth(0.45)
      .strokeColor("#d7d7d7")
      .rect(34, y, 774, 38)
      .stroke()
      .fillColor(severityColor)
      .rect(34, y, 58, 38)
      .fill()
      .font("Carlito-Bold")
      .fontSize(7)
      .fillColor("#ffffff")
      .text(issue.severity.toUpperCase(), 38, y + 15, {
        width: 50,
        align: "center",
      })
      .font("Carlito-Bold")
      .fontSize(7.2)
      .fillColor(TEXT)
      .text(issue.code, 100, y + 5, { width: 270, height: 10 })
      .font("Carlito")
      .fontSize(6.8)
      .fillColor(MUTED)
      .text(issue.ruleReference ?? "No rule reference", 590, y + 5, {
        width: 208,
        height: 10,
        align: "right",
      })
      .font("Carlito-Bold")
      .fontSize(8)
      .fillColor(TEXT)
      .text(issue.title, 100, y + 16, {
        width: 698,
        height: 10,
        ellipsis: true,
      })
      .font("Carlito")
      .fontSize(6.9)
      .fillColor(MUTED)
      .text(issue.detail, 100, y + 27, {
        width: 698,
        height: 9,
        ellipsis: true,
      })
      .restore();
  });

  document
    .font("Carlito")
    .fontSize(7)
    .fillColor(MUTED)
    .text(
      `Validation frozen ${new Date(context.validation.checkedAt).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" })}`,
      34,
      564,
      { width: 774, align: "right" },
    );
}

function drawCover(
  document: PDFKit.PDFDocument,
  context: RenderContext,
): void {
  drawUcmLockup(document, context, 336, 19, 242, true);
  document
    .font("Carlito-Bold")
    .fontSize(19)
    .fillColor(REPORT_RED)
    .strokeColor(REPORT_RED)
    .lineWidth(0.22)
    .text("Cost Report", 54, 540, {
      fill: true,
      lineBreak: false,
      stroke: true,
    });
  document
    .font("Carlito-Bold")
    .fontSize(18)
    .fillColor("#111111")
    .strokeColor("#111111")
    .lineWidth(0.18)
    .text("University of Canterbury Motorsport", 54, 572, {
      fill: true,
      lineBreak: false,
      stroke: true,
    })
    .text(`Formula SAE Australasia ${context.detail.project.season}`, 54, 605, {
      fill: true,
      lineBreak: false,
      stroke: true,
    })
    .text(
      `Car Number: ${entryNumber(context.detail)}`,
      54,
      638,
      { fill: true, lineBreak: false, stroke: true },
    );
  drawBottomStripe(document);
}

function drawProjectSummary(
  document: PDFKit.PDFDocument,
  context: RenderContext,
): void {
  drawManagementLockup(document, context);
  document
    .font("Carlito-Bold")
    .fontSize(18)
    .fillColor(TEXT)
    .strokeColor(TEXT)
    .lineWidth(0.22)
    .text("Project Cost Summary", 54, 72, {
      fill: true,
      lineBreak: false,
      stroke: true,
    });

  const prose = [
    context.detail.project.project_summary.trim(),
    `Part numbering and revision control: ${context.detail.project.numbering_convention.trim()}`,
    `Bulk-production approach: ${context.detail.project.bulk_method_summary.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let fontSize = 10.5;
  document.font("Carlito").fontSize(fontSize);
  while (
    fontSize > 8.6 &&
    document.heightOfString(prose, {
      width: 487,
      lineGap: 1.9,
      align: "justify",
    }) > 650
  ) {
    fontSize -= 0.2;
    document.fontSize(fontSize);
  }
  document
    .fillColor("#111111")
    .text(prose, 54, 103, {
      width: 487,
      height: 650,
      lineGap: 1.9,
      align: "justify",
    });
  document
    .font("Carlito")
    .fontSize(8)
    .fillColor("#111111")
    .text("Page ", 54, 777, { continued: true })
    .fillColor(REPORT_RED)
    .text("1");
  drawBottomStripe(document);
}

function drawVehicleDrawing(
  document: PDFKit.PDFDocument,
  context: RenderContext,
  evidence: ReportEvidence | null,
): void {
  document
    .lineWidth(0.55)
    .strokeColor(GRID)
    .rect(25, 31, 792, 532)
    .stroke();

  drawHonestEvidenceFrameLabel(
    document,
    evidence,
    48,
    55,
    744,
    390,
  );

  drawDrawingTitleBlock(document, {
    x: 390,
    y: 465,
    width: 427,
    height: 98,
    title: `UC MOTORSPORT ${context.detail.project.season}\nFORMULA SAE VEHICLE`,
    ...drawingIdentity(context.detail.tree, context.mode),
    quantity: "1",
    context,
  });
}

function drawCostSummary(
  document: PDFKit.PDFDocument,
  context: RenderContext,
): void {
  if (fs.existsSync(context.formulaLogoPath)) {
    document.image(context.formulaLogoPath, 72, 37, {
      fit: [78, 52],
      align: "center",
      valign: "center",
    });
  }
  drawUcmLockup(document, context, 407, 34, 133, false);
  document
    .font("Carlito-BoldOblique")
    .fontSize(16)
    .fillColor("#111111")
    .strokeColor("#111111")
    .lineWidth(0.18)
    .text("Cost Report", 188, 70, {
      fill: true,
      width: 220,
      align: "center",
      stroke: true,
    })
    .font("Carlito")
    .fontSize(8.5)
    .text("for:", 188, 94, { width: 220, align: "center" })
    .font("Carlito-Bold")
    .fontSize(11)
    .text(
      "University of Canterbury, Christchurch, New Zealand",
      104,
      112,
      { width: 388, align: "center" },
    )
    .text(`Vehicle Number ${entryNumber(context.detail)}`, 104, 132, {
      width: 388,
      align: "center",
    });

  const systems = summarySystems(context.detail);
  const breakdown = reportSummaryBreakdown(context.detail);
  drawSystemCostMatrix(document, systems, breakdown);
  drawConcentricCostChart(document, systems, breakdown);
}

function drawSystemCostMatrix(
  document: PDFKit.PDFDocument,
  systems: SummarySystem[],
  breakdown: CostBreakdown,
): void {
  const x = 70;
  const y = 155;
  const rowHeight = 11;
  const widths = [24, 161, 55, 55, 55, 55, 55];
  const labels = [
    "",
    "Vehicle System",
    "Materials",
    "Processes",
    "Fasteners",
    "Tooling",
    "Total",
  ];
  drawTableRow(document, x, y, widths, labels, {
    height: 13,
    fill: "#ffffff",
    font: "Carlito-Bold",
    fontSize: 7,
    alignments: [
      "left",
      "center",
      "center",
      "center",
      "center",
      "center",
      "center",
    ],
    stroke: false,
  });
  systems.forEach((system, index) => {
    drawTableRow(
      document,
      x,
      y + 13 + index * rowHeight,
      widths,
      [
        system.code,
        system.name,
        moneyCell(system.breakdown.material),
        moneyCell(system.breakdown.process),
        moneyCell(system.breakdown.fastener),
        moneyCell(system.breakdown.tooling),
        moneyCell(system.breakdown.total),
      ],
      {
        height: rowHeight,
        fill: summaryColors[system.code] ?? "#ffffff",
        font: "Carlito",
        fontSize: 7.2,
        alignments: [
          "left",
          "left",
          "right",
          "right",
          "right",
          "right",
          "right",
        ],
        stroke: false,
      },
    );
  });
  drawTableRow(
    document,
    x,
    y + 13 + systems.length * rowHeight + 10,
    widths,
    [
      "",
      "Total Vehicle",
      moneyCell(breakdown.material),
      moneyCell(breakdown.process),
      moneyCell(breakdown.fastener),
      moneyCell(breakdown.tooling),
      moneyCell(breakdown.total),
    ],
    {
      height: 12,
      fill: "#000000",
      textColor: "#ffffff",
      font: "Carlito",
      fontSize: 7.2,
      alignments: [
        "left",
        "center",
        "right",
        "right",
        "right",
        "right",
        "right",
      ],
      stroke: false,
    },
  );
}

function drawConcentricCostChart(
  document: PDFKit.PDFDocument,
  systems: SummarySystem[],
  breakdown: CostBreakdown,
): void {
  const chartX = 56;
  const chartY = 306;
  const chartWidth = 489;
  const chartHeight = 414;
  document
    .lineWidth(0.45)
    .strokeColor("#bdbdbd")
    .rect(chartX, chartY, chartWidth, chartHeight)
    .stroke()
    .font("Carlito-Bold")
    .fontSize(12)
    .fillColor("#444444")
    .strokeColor("#444444")
    .lineWidth(0.15)
    .text("COST BREAKDOWN BY SECTION", chartX, chartY + 10, {
      fill: true,
      width: chartWidth,
      align: "center",
      stroke: true,
    });

  const centerX = 264;
  const centerY = 505;
  const rings: Array<{
    kind: keyof CostBreakdown;
    label: string;
    radius: number;
  }> = [
    { kind: "total", label: "TOTAL", radius: 135 },
    { kind: "material", label: "MATERIAL", radius: 116 },
    { kind: "process", label: "PROCESS", radius: 97 },
    { kind: "fastener", label: "FASTENER", radius: 78 },
    { kind: "tooling", label: "TOOLING", radius: 59 },
  ];

  for (const ring of rings) {
    const values = systems.map((system) => ({
      code: system.code,
      value:
        ring.kind === "total"
          ? new Decimal(system.breakdown.total)
          : new Decimal(system.breakdown[ring.kind]),
    }));
    const total = values.reduce(
      (sum, item) => sum.plus(item.value),
      new Decimal(0),
    );
    if (total.isZero()) {
      document
        .circle(centerX, centerY, ring.radius)
        .lineWidth(12)
        .strokeColor("#eeeeee")
        .stroke();
    } else {
      let angle = -90;
      for (const item of values) {
        if (item.value.isZero()) {
          continue;
        }
        const sweep = item.value.div(total).times(360).toNumber();
        drawRingSegment(
          document,
          centerX,
          centerY,
          ring.radius,
          12,
          angle,
          angle + sweep,
          summaryColors[item.code] ?? "#dddddd",
        );
        angle += sweep;
      }
    }
  }

  const labelX = 445;
  rings.forEach((ring, index) => {
    const y = 425 + index * 21;
    const target = polar(
      centerX,
      centerY,
      ring.radius,
      -28 + index * 7,
    );
    document
      .strokeColor("#000000")
      .lineWidth(1.6)
      .moveTo(labelX - 7, y + 3)
      .lineTo(target.x, target.y)
      .stroke()
      .font("Carlito-Bold")
      .fontSize(8)
      .fillColor("#111111")
      .text(ring.label, labelX, y - 3);
  });

  drawSystemTotalCallouts(
    document,
    systems,
    breakdown,
    centerX,
    centerY,
    rings[0]!.radius,
    chartY,
    chartHeight,
  );

  let legendY = 611;
  const nonZeroSystems = systems.filter(
    (system) => !new Decimal(system.breakdown.total).isZero(),
  );
  const legendSystems =
    nonZeroSystems.length > 0 ? nonZeroSystems : systems;
  legendSystems.slice(0, 9).forEach((system) => {
    document
      .rect(455, legendY + 2, 4, 4)
      .fill(summaryColors[system.code] ?? "#dddddd")
      .font("Carlito")
      .fontSize(5.5)
      .fillColor("#333333")
      .text(system.name, 462, legendY, { width: 73 });
    legendY += 11;
  });
}

function drawSystemTotalCallouts(
  document: PDFKit.PDFDocument,
  systems: SummarySystem[],
  breakdown: CostBreakdown,
  centerX: number,
  centerY: number,
  radius: number,
  chartY: number,
  chartHeight: number,
): void {
  const total = new Decimal(breakdown.total);
  if (total.isZero()) {
    return;
  }

  interface Callout {
    anchor: { x: number; y: number };
    elbow: { x: number; y: number };
    label: string;
    side: "left" | "right";
    y: number;
  }

  const callouts: Callout[] = [];
  let angle = -90;
  for (const system of systems) {
    const value = new Decimal(system.breakdown.total);
    if (value.isZero()) {
      continue;
    }
    const sweep = value.div(total).times(360).toNumber();
    const middle = angle + sweep / 2;
    const percentage = value
      .div(total)
      .times(100)
      .toDecimalPlaces(0)
      .toString();
    callouts.push({
      anchor: polar(centerX, centerY, radius + 5, middle),
      elbow: polar(centerX, centerY, radius + 22, middle),
      label: `$ ${displayUniversalDollars(value)}, ${percentage}%`,
      side:
        Math.cos((middle * Math.PI) / 180) >= 0
          ? "right"
          : "left",
      y: polar(centerX, centerY, radius + 22, middle).y - 6,
    });
    angle += sweep;
  }

  const minimumY = chartY + 37;
  const maximumY = chartY + chartHeight - 26;
  const gap = 15;
  for (const side of ["left", "right"] as const) {
    const grouped = callouts
      .filter((callout) => callout.side === side)
      .sort((left, right) => left.y - right.y);
    grouped.forEach((callout, index) => {
      callout.y = Math.max(
        callout.y,
        index === 0 ? minimumY : grouped[index - 1]!.y + gap,
      );
    });
    for (let index = grouped.length - 1; index >= 0; index -= 1) {
      const following = grouped[index + 1];
      grouped[index]!.y = Math.min(
        grouped[index]!.y,
        following ? following.y - gap : maximumY,
      );
    }
  }

  const labelWidth = 66;
  const labelHeight = 13;
  for (const callout of callouts) {
    const labelX =
      callout.side === "right"
        ? Math.min(callout.elbow.x + 4, 472)
        : Math.max(callout.elbow.x - labelWidth - 4, 64);
    const edgeX =
      callout.side === "right" ? labelX : labelX + labelWidth;
    document
      .save()
      .strokeColor("#555555")
      .lineWidth(0.55)
      .moveTo(callout.anchor.x, callout.anchor.y)
      .lineTo(callout.elbow.x, callout.elbow.y)
      .lineTo(edgeX, callout.y + labelHeight / 2)
      .stroke()
      .rect(labelX + 1.5, callout.y + 1.5, labelWidth, labelHeight)
      .fill("#bcbcbc")
      .rect(labelX, callout.y, labelWidth, labelHeight)
      .fill("#444444")
      .font("Carlito-Bold")
      .fontSize(6.2)
      .fillColor("#ffffff")
      .text(callout.label, labelX + 2, callout.y + 3, {
        width: labelWidth - 4,
        align: "center",
        ellipsis: true,
      })
      .restore();
  }
}

function drawBomPage(
  document: PDFKit.PDFDocument,
  page: Extract<Ucm25PlannedPage, { type: "bom" }>,
  context: RenderContext,
): void {
  const tableTop = page.first ? 80 : 36;
  if (page.first) {
    drawBomMetadata(document, context);
  }
  drawBomHeader(document, tableTop);
  const allRows = flattenNodes(context.detail.tree).filter(
    (node) =>
      node.kind === "assembly" ||
      node.kind === "subassembly" ||
      node.kind === "part",
  );
  let rowY = tableTop + 26.2;
  for (const row of page.rows) {
    if (row.type === "node") {
      const { node } = row;
      drawBomRow(
        document,
        node,
        row.lineNumber ?? allRows.indexOf(node) + 1,
        rowY,
        page.pageNumberByNode.get(node.id) ?? null,
        context.detail.tree,
        context.mode,
        row.historicalAssemblyDescription,
        row.historicalPartDescription,
      );
    } else {
      drawBomAreaTotal(
        document,
        row.system.system_code ?? "",
        rowY,
        context.detail.tree,
      );
    }
    rowY += 6.86;
  }
}

function drawBomMetadata(
  document: PDFKit.PDFDocument,
  context: RenderContext,
): void {
  const x = 20;
  const y = 38;
  const labelWidth = 119;
  const valueWidth = 112;
  const rows: Array<[string, string]> = [
    ["University", "University of Canterbury, Christchurch, New Zealand"],
    ["Competition Code", "FSAE-A"],
    ["Year", String(context.detail.project.season)],
    ["Vehicle Entry Number", entryNumber(context.detail)],
  ];
  rows.forEach(([label, value], index) => {
    drawCell(document, x, y + index * 9.5, labelWidth, 9.5, label, {
      fill: "#25478b",
      textColor: "#ffffff",
      font: "Carlito-Bold",
      fontSize: 4.3,
      align: "right",
      padding: 3,
    });
    drawCell(
      document,
      x + labelWidth,
      y + index * 9.5,
      valueWidth,
      9.5,
      value,
      {
        fill: LIGHT_CELL,
        font: "Carlito",
        fontSize: 4.2,
        padding: 4,
      },
    );
  });

  drawCell(document, 602, 38, 70, 10, "Total Vehicle Cost", {
    fill: "#25478b",
    textColor: "#ffffff",
    font: "Carlito-Bold",
    fontSize: 4.3,
    align: "center",
  });
  drawCell(
    document,
    672,
    38,
    78,
    10,
    `$ ${displayUniversalDollars(reportBomHeaderTotal(context.detail))}`,
    {
      fill: LIGHT_CELL,
      font: "Carlito",
      fontSize: 4.3,
      align: "right",
    },
  );
  if (fs.existsSync(context.formulaLogoPath)) {
    document.image(context.formulaLogoPath, 760, 35, {
      fit: [62, 40],
      align: "center",
      valign: "center",
    });
  }
}

function drawBomHeader(
  document: PDFKit.PDFDocument,
  y: number,
): void {
  const widths = bomColumnWidths();
  const labels = [
    "Line\nNo.",
    "",
    "Assembly\nNo.",
    "Level",
    "Part No.",
    "Revision",
    "Assembly/ Part Number",
    "Assembly Description",
    "Part Description",
    "Material",
    "Process",
    "Fastener",
    "Tooling",
    "Total",
    "QTY per\nAssembly/\nSystem",
    "Extended Cost",
    "Cost Table\nPage",
  ];
  drawTableRow(document, 20.7, y, widths, labels, {
    height: 26.2,
    fill: "#ffffff",
    font: "Carlito-Bold",
    fontSize: 4.5,
    alignments: labels.map(() => "center"),
    lineWidth: 0.45,
    verticalAlign: "center",
    fitText: true,
    minFontSize: 3.8,
  });
  document
    .font("Carlito-Bold")
    .fontSize(4.5)
    .fillColor("#111111")
    .text("Vehicle System", 38.1, y + 10.5, {
      width: 114.57,
      align: "center",
      lineBreak: false,
    });
}

function drawBomRow(
  document: PDFKit.PDFDocument,
  node: ProjectNode,
  lineNumber: number,
  y: number,
  tablePage: number | null,
  root: ProjectNode,
  mode: ReportMode,
  historicalAssemblyDescription?: string,
  historicalPartDescription?: string,
): void {
  const direct = ownBreakdown(node);
  const parent = findNode(root, node.parent_id);
  const assemblyDescription =
    historicalAssemblyDescription ??
    (node.kind === "assembly" || node.kind === "subassembly"
      ? node.name
      : "");
  const partDescription =
    historicalPartDescription ??
    (node.kind === "part" ? node.name : "");
  const extended =
    historicalMetadata(node)?.historicalBomExtendedCost ??
    new Decimal(direct.total).times(node.quantity).toString();
  drawTableRow(
    document,
    20.7,
    y,
    bomColumnWidths(),
    [
      String(lineNumber),
      `${reportSystemNames[node.system_code ?? ""] ?? systemName(
        node.system_code ?? "",
      )}`,
      node.raw_hla ?? "",
      node.raw_subassembly ?? "",
      node.raw_part_number ?? "",
      identityValue(node.revision, mode, "revision", node.id),
      identityValue(node.full_number, mode, "full-number", node.id),
      assemblyDescription,
      partDescription,
      moneyCell(direct.material),
      moneyCell(direct.process),
      moneyCell(direct.fastener),
      moneyCell(direct.tooling),
      moneyCell(direct.total),
      node.quantity,
      `$ ${displayUniversalDollars(extended)}`,
      tablePage ? String(tablePage) : "",
    ],
    {
      height: 6.86,
      fill: summaryColors[node.system_code ?? ""] ?? "#ffffff",
      font: "Carlito",
      fontSize: 4.5,
      alignments: [
        "right",
        "left",
        "center",
        "center",
        "center",
        "center",
        "left",
        "left",
        "left",
        "right",
        "right",
        "right",
        "right",
        "right",
        "center",
        "right",
        "center",
      ],
      lineWidth: 0.3,
      verticalAlign: "center",
      ellipsis: true,
    },
  );
  document
    .font("Carlito")
    .fontSize(4.5)
    .fillColor("#111111")
    .text(node.system_code ?? "", 38.1, y + 1.1, {
      width: 112.2,
      align: "right",
      lineBreak: false,
    });
  void parent;
}

function drawBomAreaTotal(
  document: PDFKit.PDFDocument,
  systemCode: string,
  y: number,
  root: ProjectNode,
): void {
  const system = root.children.find(
    (candidate) => candidate.system_code === systemCode,
  );
  if (!system) {
    return;
  }
  document
    .lineWidth(0.6)
    .strokeColor("#000000")
    .moveTo(20.7, y + 6.86)
    .lineTo(822.5, y + 6.86)
    .stroke()
    .font("Carlito")
    .fontSize(4.3)
    .fillColor("#111111")
    .text(
      `${reportSystemNames[systemCode] ?? system.name}  Area Total`,
      442,
      y + 1.5,
      { width: 91, align: "right" },
    );
  const breakdown = reportBomSystemBreakdown(system);
  document
    .text(moneyCell(breakdown.material), 539, y + 1.5, {
      width: 33,
      align: "right",
    })
    .text(moneyCell(breakdown.process), 573, y + 1.5, {
      width: 33,
      align: "right",
    })
    .text(moneyCell(breakdown.fastener), 607, y + 1.5, {
      width: 33,
      align: "right",
    })
    .text(moneyCell(breakdown.tooling), 641, y + 1.5, {
      width: 33,
      align: "right",
    })
    .text(moneyCell(breakdown.total), 675, y + 1.5, {
      width: 33,
      align: "right",
    });
}

function drawHierarchyPage(
  document: PDFKit.PDFDocument,
  system: ProjectNode,
  context: RenderContext,
): void {
  const assemblies = system.children.filter(
    (node) =>
      node.kind === "assembly" || node.kind === "subassembly",
  );
  const hierarchyTop = 36;
  const hierarchyBottom = 548;
  const rootBox = {
    x: 27,
    y: (hierarchyTop + hierarchyBottom - 34) / 2,
    width: 95,
    height: 34,
  };
  drawHierarchyBox(
    document,
    rootBox,
    reportSystemNames[system.system_code ?? ""] ?? system.name,
    true,
  );

  const assemblyX = 190;
  const partX = 420;
  const assemblyLayouts = assemblies.map((assembly) => ({
    assembly,
    descendants: assembly.children.slice(0, 16),
  }));
  const totalRows = assemblyLayouts.reduce(
    (total, layout) =>
      total + Math.max(1, layout.descendants.length),
    0,
  );
  const rowSpacing = Math.min(
    32,
    (hierarchyBottom - hierarchyTop - 22) /
      Math.max(1, totalRows - 1),
  );
  const rowsHeight =
    totalRows > 0 ? (totalRows - 1) * rowSpacing : 0;
  let nextRowCenter =
    (hierarchyTop + hierarchyBottom - rowsHeight) / 2;

  assemblyLayouts.forEach(({ assembly, descendants }) => {
    const rowCount = Math.max(1, descendants.length);
    const firstRowCenter = nextRowCenter;
    const lastRowCenter =
      firstRowCenter + (rowCount - 1) * rowSpacing;
    const assemblyCenterY =
      (firstRowCenter + lastRowCenter) / 2;
    const assemblyY = assemblyCenterY - 14;
    const assemblyBox = {
      x: assemblyX,
      y: assemblyY,
      width: 130,
      height: 28,
    };
    drawElbowArrow(
      document,
      rootBox.x + rootBox.width,
      rootBox.y + rootBox.height / 2,
      assemblyBox.x,
      assemblyBox.y + assemblyBox.height / 2,
    );
    drawHierarchyBox(
      document,
      assemblyBox,
      `${assembly.name}\n(${displayNodeNumber(assembly, context.mode)})`,
    );
    descendants.forEach((part, partIndex) => {
      const partY =
        firstRowCenter + partIndex * rowSpacing - 11;
      const partBox = {
        x: partX,
        y: partY,
        width: 190,
        height: 22,
      };
      drawElbowArrow(
        document,
        assemblyBox.x + assemblyBox.width,
        assemblyBox.y + assemblyBox.height / 2,
        partBox.x,
        partBox.y + partBox.height / 2,
      );
      drawHierarchyBox(
        document,
        partBox,
        `${part.name} (${displayNodeNumber(part, context.mode)})`,
      );
    });
    nextRowCenter += rowCount * rowSpacing;
  });

  if (assemblies.length === 0) {
    const parts = system.children.filter(
      (node) => node.kind === "part",
    );
    const directSpacing = Math.min(
      30,
      (hierarchyBottom - hierarchyTop - 22) /
        Math.max(1, parts.length - 1),
    );
    const directHeight =
      parts.length > 0 ? (parts.length - 1) * directSpacing : 0;
    const directStart =
      (hierarchyTop + hierarchyBottom - directHeight) / 2 - 11;
    parts.forEach((part, index) => {
      const box = {
        x: 350,
        y: directStart + index * directSpacing,
        width: 200,
        height: 22,
      };
      drawElbowArrow(
        document,
        rootBox.x + rootBox.width,
        rootBox.y + rootBox.height / 2,
        box.x,
        box.y + box.height / 2,
      );
      drawHierarchyBox(
        document,
        box,
        `${part.name} (${displayNodeNumber(part, context.mode)})`,
      );
    });
  }
}

function drawAssemblyPage(
  document: PDFKit.PDFDocument,
  system: ProjectNode,
  assembly: ProjectNode,
  evidence: ReportEvidence | null,
  children: ProjectNode[],
  showContentsSubtotal: boolean,
  context: RenderContext,
): void {
  const metadataBottom = drawEntityMetadata(document, {
    kind: "assembly",
    system,
    assembly,
    node: assembly,
    context,
  });
  drawSummaryEvidenceFrame(
    document,
    evidence,
    471,
    28,
    343,
    142,
    Boolean(historicalMetadata(assembly)),
    assembly.image_required !== false,
  );
  if (children.length > 0 || showContentsSubtotal) {
    drawAssemblyChildrenTable(
      document,
      assembly,
      children,
      20,
      Math.ceil(metadataBottom + 15),
      context.mode,
      showContentsSubtotal,
    );
  }
}

function drawAssemblyContentsPage(
  document: PDFKit.PDFDocument,
  assembly: ProjectNode,
  children: ProjectNode[],
  showSubtotal: boolean,
): void {
  drawAssemblyChildrenTable(
    document,
    assembly,
    children,
    20,
    28,
    "export",
    showSubtotal,
  );
}

function drawAssemblyCostPage(
  document: PDFKit.PDFDocument,
  system: ProjectNode,
  assembly: ProjectNode,
  sections: PlannedCostSection[],
  continued: boolean,
): void {
  let y = COST_PAGE_START_Y;
  for (const section of sections) {
    y = drawCostSection(
      document,
      section,
      system.system_code ?? "",
      20,
      y,
    );
    y += COST_SECTION_GAP;
  }
  void continued;
}

function drawPartPage(
  document: PDFKit.PDFDocument,
  system: ProjectNode,
  assembly: ProjectNode | null,
  part: ProjectNode,
  sections: PlannedCostSection[],
  continued: boolean,
  evidence: ReportEvidence | null,
  context: RenderContext,
): void {
  let y = COST_PAGE_START_Y;
  if (!continued) {
    const metadataBottom = drawEntityMetadata(document, {
      kind: "part",
      system,
      assembly,
      node: part,
      context,
    });
    drawSummaryEvidenceFrame(
      document,
      evidence,
      600,
      28,
      214,
      156,
      Boolean(historicalMetadata(part)),
      part.image_required !== false,
    );
    y = Math.max(
      FIRST_PART_COST_START_Y,
      Math.ceil(metadataBottom + 14),
    );
  }
  for (const section of sections) {
    y = drawCostSection(
      document,
      section,
      system.system_code ?? "",
      20,
      y,
    );
    y += COST_SECTION_GAP;
  }
}

function drawEntityMetadata(
  document: PDFKit.PDFDocument,
  input: {
    kind: "assembly" | "part";
    system: ProjectNode;
    assembly: ProjectNode | null;
    node: ProjectNode;
    context: RenderContext;
  },
): number {
  const labelColor =
    sheetColors[input.system.system_code ?? ""] ?? "#D9D9D9";
  const entry = entryNumber(input.context.detail);
  const identity = drawingIdentity(
    input.node,
    input.context.mode,
  );
  const historical = historicalMetadata(input.node);
  const displayedCost =
    historical?.historicalDetailCost ?? input.node.breakdown.total;
  const displayedQuantity =
    historical?.historicalDetailQuantity ?? input.node.quantity;
  const displayedExtendedCost =
    historical?.historicalDetailExtendedCost ??
    new Decimal(displayedCost).times(displayedQuantity).toString();
  const rows: Array<[string, string]> =
    input.kind === "assembly"
      ? [
          ["University", "University of Canterbury"],
          ["Entry No.", entry],
          ["System", conciseSystemName(input.system)],
          ["Assembly", input.node.name],
          ["Assembly No.", identity.partNumber],
          ["Revision", identity.revision],
          ["Details", input.node.description || input.node.name],
          [
            "Assembly Cost",
            displayCostNumber(displayedCost),
          ],
          ["Quantity", displayedQuantity],
          [
            "Extended Cost",
            displayCostNumber(displayedExtendedCost),
          ],
        ]
      : [
          ["University", "University of Canterbury"],
          ["Entry No.", entry],
          ["System", conciseSystemName(input.system)],
          ["Assembly", input.assembly?.name ?? ""],
          ["Part", input.node.name],
          ["Part No.", identity.partNumber],
          ["Revision", identity.revision],
          ["Details", input.node.description || input.node.name],
          ["Part Cost", displayCostNumber(displayedCost)],
          ["Quantity", displayedQuantity],
          [
            "Extended Cost",
            displayCostNumber(displayedExtendedCost),
          ],
        ];

  document.font("Carlito").fontSize(8);
  const labelX = 19.84252;
  const labelWidth = 57.829291;
  const valueX = labelX + labelWidth;
  const valueWidth = Math.max(
    98.63,
    ...rows.map(([, value]) => document.widthOfString(value) + 5.669291),
  );
  const rowHeight = 14.869291;
  let rowY = 28.346457;
  for (const [index, [label, value]] of rows.entries()) {
    drawCell(document, labelX, rowY, labelWidth, rowHeight, label, {
      fill: labelColor,
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 2.834646,
      lineWidth: 0.283465,
    });
    drawCell(document, valueX, rowY, valueWidth, rowHeight, value, {
      fill: index % 2 === 0 ? LIGHT_CELL : "#ffffff",
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 2.834646,
      lineWidth: 0.283465,
      ellipsis: true,
    });
    rowY += rowHeight;
  }
  return rowY;
}

function drawAssemblyChildrenTable(
  document: PDFKit.PDFDocument,
  assembly: ProjectNode,
  children: ProjectNode[],
  x: number,
  y: number,
  mode: ReportMode,
  showSubtotal: boolean,
): void {
  const color =
    sheetColors[assembly.system_code ?? ""] ?? "#D9D9D9";
  const widths = [
    29, 108, 70, 63, 71, 71, 71, 71, 71, 71, 48, 57,
  ];
  const labels = [
    "Item\nOrder",
    "Part/Sub Assembly",
    "Part/Sub\nAssembly\nNumber",
    "Description",
    "Sub Assembly\nParts Cost",
    "Material Cost",
    "Process Cost",
    "Fastener Cost",
    "Tooling Cost",
    "Part/Sub\nAssembly Cost",
    "Quantity",
    "Sub Total",
  ];
  drawTableRow(document, x, y, widths, labels, {
    height: 34,
    fill: color,
    font: "Carlito",
    fontSize: 8,
    alignments: labels.map(() => "left"),
    verticalAlign: "top",
    lineWidth: 0.5,
    padding: 3,
  });
  const childRowHeight = 24;
  children.forEach((child, index) => {
    const direct = ownBreakdown(child);
    const sourceDeclared = Boolean(
      historicalMetadata(child)?.historicalBomBreakdown,
    );
    const childrenCost = sourceDeclared
      ? zeroBreakdown()
      : subtractBreakdown(child.breakdown, direct);
    const displayedTotal = sourceDeclared
      ? direct.total
      : child.breakdown.total;
    const subtotal = new Decimal(displayedTotal).times(child.quantity);
    drawTableRow(
      document,
      x,
      y + 34 + index * childRowHeight,
      widths,
      [
        String(index + 1),
        child.name,
        displayNodeNumber(child, mode),
        child.description,
        displayCostNumber(childrenCost.total),
        displayCostNumber(direct.material),
        displayCostNumber(direct.process),
        displayCostNumber(direct.fastener),
        displayCostNumber(direct.tooling),
        displayCostNumber(displayedTotal),
        child.quantity,
        displayCostNumber(subtotal),
      ],
      {
        height: childRowHeight,
        fill: LIGHT_CELL,
        textColor: MUTED,
        font: "Carlito",
        fontSize: 7.2,
        alignments: labels.map(() => "left"),
        lineWidth: 0.5,
        padding: 3,
        fitText: true,
        minFontSize: 5.2,
      },
    );
  });
  const subtotal = assembly.children.reduce(
    (sum, child) =>
      sum.plus(
        new Decimal(
          historicalMetadata(child)?.historicalBomBreakdown?.total ??
            child.breakdown.total,
        ).times(child.quantity),
      ),
    new Decimal(0),
  );
  const subtotalY =
    y + 34 + children.length * childRowHeight;
  if (!showSubtotal) {
    return;
  }
  drawCell(
    document,
    x + widths.slice(0, -2).reduce((sum, width) => sum + width, 0),
    subtotalY,
    widths.at(-2)!,
    15,
    "Subtotal",
    {
      fill: color,
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 3,
    },
  );
  drawCell(
    document,
    x + widths.slice(0, -1).reduce((sum, width) => sum + width, 0),
    subtotalY,
    widths.at(-1)!,
    15,
    displayCostNumber(subtotal),
    {
      fill: LIGHT_CELL,
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 3,
    },
  );
}

function drawCostSection(
  document: PDFKit.PDFDocument,
  section: PlannedCostSection,
  systemCode: string,
  x: number,
  y: number,
): number {
  const schema = costTableSchema(document, section.kind, section.lines);
  const sourceLayout = section.sourceLayout;
  if (
    sourceLayout &&
    sourceLayout.widths.length === schema.labels.length
  ) {
    schema.widths = sourceLayout.widths;
  }
  const sectionX = sourceLayout?.left ?? x;
  const sectionY = sourceLayout?.top ?? y;
  const headerHeight =
    sourceLayout?.headerHeight ?? COST_SECTION_HEADER_HEIGHT;
  const rowHeight = sourceLayout?.rowHeight ?? COST_DATA_ROW_HEIGHT;
  const subtotalHeight =
    sourceLayout?.rowHeight ?? COST_SECTION_SUBTOTAL_HEIGHT;
  const color = sheetColors[systemCode] ?? "#D9D9D9";
  const labels = [...schema.labels];
  labels[1] = schema.title;
  drawTableRow(document, sectionX, sectionY, schema.widths, labels, {
    height: headerHeight,
    fill: color,
    font: "Carlito",
    fontSize: 8,
    alignments: labels.map(() => "left"),
    verticalAlign: "center",
    lineWidth: 0.283,
    padding: 2.83,
  });
  let rowY = sectionY + headerHeight;
  section.lines.forEach((line, index) => {
    drawTableRow(
      document,
      sectionX,
      rowY,
      schema.widths,
      costLineCells(line, section.kind, index + 1),
      {
        height: rowHeight,
        fill: sourceLayout ? "#ffffff" : LIGHT_CELL,
        textColor: MUTED,
        font: "Carlito",
        fontSize: 8,
        alignments: schema.labels.map(() => "left"),
        lineWidth: 0.283,
        padding: 2.83,
      },
    );
    rowY += rowHeight;
  });
  const subtotal = section.lines.reduce(
    (sum, line) => sum.plus(line.subtotal),
    new Decimal(0),
  );
  const subtotalLabelX =
    sectionX +
    schema.widths
      .slice(0, -2)
      .reduce((sum, width) => sum + width, 0);
  drawCell(
    document,
    subtotalLabelX,
    rowY,
    schema.widths.at(-2)!,
    subtotalHeight,
    "Subtotal",
    {
      fill: color,
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 2.83,
      lineWidth: 0.283,
    },
  );
  drawCell(
    document,
    subtotalLabelX + schema.widths.at(-2)!,
    rowY,
    schema.widths.at(-1)!,
    subtotalHeight,
    displayCostNumber(subtotal),
    {
      fill: sourceLayout ? "#ffffff" : LIGHT_CELL,
      textColor: MUTED,
      font: "Carlito",
      fontSize: 8,
      padding: 2.83,
      lineWidth: 0.283,
    },
  );
  return rowY + subtotalHeight;
}

function costTableSchema(
  document: PDFKit.PDFDocument,
  kind: CostKind,
  lines: CostLineRow[],
): {
  title: string;
  labels: string[];
  widths: number[];
} {
  switch (kind) {
    case "material":
      return withAutomaticWidths(document, lines, kind, {
        title: "Material",
        labels: [
          "Item Order",
          "Material",
          "Use",
          "Size 1",
          "Unit 1",
          "Size 2",
          "Unit 2",
          "Unit Cost",
          "Quantity",
          "Sub Total",
        ],
        widths: [],
      });
    case "process":
      return withAutomaticWidths(document, lines, kind, {
        title: "Process",
        labels: [
          "Item Order",
          "Process",
          "Use",
          "Unit Cost",
          "Unit",
          "Multiplier",
          "Multiplier Value",
          "Quantity",
          "Sub Total",
        ],
        widths: [],
      });
    case "fastener":
      return withAutomaticWidths(document, lines, kind, {
        title: "Fastener",
        labels: [
          "Item Order",
          "Fastener",
          "Use",
          "Size 1",
          "Unit 1",
          "Size 2",
          "Unit 2",
          "Unit Cost",
          "Quantity",
          "Sub Total",
        ],
        widths: [],
      });
    case "tooling":
      return withAutomaticWidths(document, lines, kind, {
        title: "Tooling",
        labels: [
          "Item Order",
          "Tooling",
          "Use",
          "Fraction Included",
          "PVF",
          "Size 1",
          "Unit 1",
          "Size 2",
          "Unit 2",
          "Unit Cost",
          "Quantity",
          "Sub Total",
        ],
        widths: [],
      });
  }
}

function withAutomaticWidths(
  document: PDFKit.PDFDocument,
  lines: CostLineRow[],
  kind: CostKind,
  schema: { title: string; labels: string[]; widths: number[] },
): { title: string; labels: string[]; widths: number[] } {
  const rows = lines.map((line, index) =>
    costLineCells(line, kind, index + 1),
  );
  document.font("Carlito").fontSize(8);
  schema.widths = schema.labels.map((label, column) => {
    const values = [label, ...rows.map((row) => row[column] ?? "")];
    return Math.max(
      ...values.flatMap((value) =>
        value.split("\n").map((part) => document.widthOfString(part) + 5.67),
      ),
    );
  });
  return schema;
}

function costLineCells(
  line: CostLineRow,
  kind: CostKind,
  order: number,
): string[] {
  const sizes = parseSizeInputs(line.size_inputs_json);
  const source = historicalLineDisplay(line);
  const displayedOrder = String(source.sourceOrder ?? order);
  const displayedQuantity = source.recoveredQuantityMissing
    ? ""
    : line.quantity;
  switch (kind) {
    case "material":
      return [
        displayedOrder,
        line.description,
        line.use_description,
        sizes.size1,
        sizes.unit1,
        sizes.size2,
        sizes.unit2,
        displayNumber(line.unit_cost),
        displayedQuantity,
        displayCostNumber(line.subtotal),
      ];
    case "process":
      return [
        displayedOrder,
        line.description,
        line.use_description,
        displayNumber(line.unit_cost),
        source.unitDisplay ?? "unit",
        line.multiplier_name ?? "None",
        source.multiplierDisplay ?? line.multiplier,
        displayedQuantity,
        displayCostNumber(line.subtotal),
      ];
    case "fastener":
      return [
        displayedOrder,
        line.description,
        line.use_description,
        sizes.size1,
        sizes.unit1,
        sizes.size2,
        sizes.unit2,
        displayNumber(line.unit_cost),
        displayedQuantity,
        displayCostNumber(line.subtotal),
      ];
    case "tooling":
      return [
        displayedOrder,
        line.description,
        line.use_description,
        line.fraction_included,
        line.production_volume_factor ?? "",
        sizes.size1,
        sizes.unit1,
        sizes.size2,
        sizes.unit2,
        displayNumber(line.unit_cost),
        displayedQuantity,
        displayCostNumber(line.subtotal),
      ];
  }
}

function drawProjectTechnicalFrame(
  document: PDFKit.PDFDocument,
  system: ProjectNode,
  node: ProjectNode,
  evidence: ReportEvidence | null,
  context: RenderContext,
): void {
  document
    .lineWidth(0.55)
    .strokeColor("#000000")
    .rect(20, 20, 802, 555)
    .stroke();

  drawHonestEvidenceFrameLabel(
    document,
    evidence,
    45,
    45,
    750,
    405,
  );
  document
    .font("Carlito")
    .fontSize(8)
    .fillColor("#111111")
    .text(`QUANTITY: ${node.quantity}`, 104, 454)
    .text("NOT FOR MANUFACTURE", 651, 454, {
      width: 150,
      align: "right",
    });
  drawDrawingTitleBlock(document, {
    x: 390,
    y: 465,
    width: 432,
    height: 110,
    title: node.name.toUpperCase(),
    ...drawingIdentity(node, context.mode),
    quantity: node.quantity,
    context,
  });
  document
    .font("Carlito")
    .fontSize(8)
    .fillColor("#111111")
    .text(
      evidence
        ? `VERIFIED PROJECT EVIDENCE\nSHA-256 ${evidence.contentSha256}`
        : "PROJECT EVIDENCE REQUIRED\nNo synthetic drawing authority",
      104,
      525,
      { width: 240 },
    );
}

function drawHonestEvidenceFrameLabel(
  document: PDFKit.PDFDocument,
  evidence: ReportEvidence | null,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  document
    .save()
    .font(evidence ? "Carlito-Bold" : "Carlito")
    .fontSize(evidence ? 9 : 11)
    .fillColor(evidence ? "#555555" : "#777777")
    .text(
      evidence
        ? `Verified project evidence: ${evidence.displayName}`
        : "PROJECT EVIDENCE REQUIRED\nNo geometry or dimensions are generated by the application.",
      x,
      y + height / 2 - 18,
      {
        width,
        align: "center",
      },
    )
    .restore();
}

function drawSummaryEvidenceFrame(
  document: PDFKit.PDFDocument,
  evidence: ReportEvidence | null,
  x: number,
  y: number,
  width: number,
  height: number,
  historical = false,
  imageRequired = true,
): void {
  if (!evidence && !imageRequired) {
    document.save().font("Carlito").fontSize(10).fillColor("#777777")
      .text("Isometric image not required", x + 6, y + height / 2 - 6,
        { width: width - 12, align: "center" }).restore();
    return;
  }
  if (historical) {
    return;
  }
  document
    .save()
    .lineWidth(0.45)
    .strokeColor(GRID)
    .rect(x, y, width, height)
    .stroke()
    .restore();
  drawHonestEvidenceFrameLabel(
    document,
    evidence,
    x + 6,
    y + 4,
    width - 12,
    height - 8,
  );
}

function drawEvidencePlaceholder(
  document: PDFKit.PDFDocument,
  page: Extract<Ucm25PlannedPage, { type: "evidence" }>,
  pageNumber: number,
): void {
  document
    .font("Carlito")
    .fontSize(8)
    .fillColor("#777777")
    .text(
      `Evidence placeholder ${pageNumber}: ${page.evidence.displayName}`,
      20,
      20,
    );
}

async function replaceEvidencePlaceholders(
  basePath: string,
  destination: string,
  context: RenderContext,
): Promise<void> {
  const base = await PDFLibDocument.load(await readFile(basePath), {
    updateMetadata: false,
  });
  const output = await PDFLibDocument.create();
  output.setTitle(`${context.detail.project.name} Cost Report`);
  output.setAuthor("University of Canterbury Motorsport");
  output.setSubject(
    `Formula SAE-Australasia ${context.detail.project.season} Cost and Manufacturing Report`,
  );
  output.setCreationDate(new Date(context.createdAt));
  output.setModificationDate(new Date(context.createdAt));
  output.registerFontkit(fontkit);
  const regular = await output.embedFont(
    await readFile(CARLITO_REGULAR_PATH),
    { subset: true },
  );
  const evidenceImageCache = new Map<string, EmbeddedEvidenceImage>();

  for (const [index, planned] of context.plan.pages.entries()) {
    if (
      (planned.type === "vehicle-drawing" ||
        planned.type === "project-drawing") &&
      planned.evidence?.mimeType === "application/pdf"
    ) {
      const image = await embedVerifiedEvidenceImage(
        output,
        planned.evidence,
        planned.sourcePageIndex,
        evidenceImageCache,
      );
      const page = output.addPage(A4_LANDSCAPE);
      drawEvidenceImageOnPage(
        page,
        image,
        planned.evidence,
        regular,
        A4_LANDSCAPE,
      );
      continue;
    }
    if (
      planned.type === "vehicle-drawing" ||
      planned.type === "project-drawing" ||
      planned.type === "assembly" ||
      (planned.type === "part" && !planned.continued)
    ) {
      const [copied] = await output.copyPages(base, [index]);
      const page = output.addPage(copied!);
      if (planned.evidence) {
        const frame =
          planned.type === "assembly"
            ? {
                ...pdfLibFrameFromPdfKit(
                  planned.imageFrame?.left ?? 471,
                  planned.imageFrame?.top ?? 28,
                  planned.imageFrame?.width ?? 343,
                  planned.imageFrame?.height ?? 142,
                ),
                horizontalAlign: "right" as const,
              }
            : planned.type === "part"
              ? {
                  ...pdfLibFrameFromPdfKit(
                    planned.imageFrame?.left ?? 600,
                    planned.imageFrame?.top ?? 28,
                    planned.imageFrame?.width ?? 214,
                    planned.imageFrame?.height ?? 156,
                  ),
                  horizontalAlign: "right" as const,
                }
              : undefined;
        await drawVerifiedEvidenceInTechnicalFrame(
          output,
          page,
          planned.evidence,
          planned.sourcePageIndex,
          evidenceImageCache,
          frame,
        );
      }
      continue;
    }
    if (planned.type !== "evidence") {
      const [copied] = await output.copyPages(base, [index]);
      output.addPage(copied!);
      continue;
    }
    const item = planned.evidence;
    const image = await embedVerifiedEvidenceImage(
      output,
      item,
      planned.sourcePageIndex,
      evidenceImageCache,
    );
    const landscape = image.width >= image.height;
    const size = landscape ? A4_LANDSCAPE : A4_PORTRAIT;
    const page = output.addPage(size);
    if (isHashLockedHistoricalSourcePage(context, planned)) {
      drawHistoricalSourceImageOnPage(page, image, size);
    } else {
      drawEvidenceImageOnPage(page, image, item, regular, size);
    }
  }

  await drawReportStatusMarks(output, context);

  const temporary = `${destination}.merged`;
  await writeFile(
    temporary,
    await output.save({ useObjectStreams: false }),
    { flag: "wx" },
  );
  await rename(temporary, destination);
}

async function drawReportStatusMarks(
  output: PDFLibDocument,
  context: RenderContext,
): Promise<void> {
  if (
    context.mode === "competition-ready" ||
    context.mode === "export"
  ) {
    return;
  }
  const font = await output.embedFont(
    await readFile(CARLITO_BOLD_PATH),
    { subset: true },
  );
  const label =
    context.mode === "deadline"
      ? `INCOMPLETE — ${context.validation.blockers} BLOCKERS`
      : "DRAFT";
  const size = context.mode === "deadline" ? 30 : 68;
  const opacity = context.mode === "deadline" ? 0.16 : 0.1;
  for (const page of output.getPages()) {
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (page.getWidth() - width * 0.82) / 2,
      y: page.getHeight() / 2 - 20,
      size,
      font,
      color: rgb(0.72, 0, 0.07),
      opacity,
      rotate: degrees(32),
    });
  }
}

type EmbeddedEvidenceImage = Awaited<
  ReturnType<PDFLibDocument["embedPng"]>
>;

async function embedVerifiedEvidenceImage(
  output: PDFLibDocument,
  item: ReportEvidence,
  sourcePageIndex: number | null,
  cache: Map<string, EmbeddedEvidenceImage>,
): Promise<EmbeddedEvidenceImage> {
  const cacheKey = `${item.id}:${sourcePageIndex ?? 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const image =
    item.mimeType === "application/pdf"
      ? await output.embedPng(
          await rasterizePdfPage(
            item.verifiedBytes,
            sourcePageIndex ?? 0,
          ),
        )
      : item.mimeType === "image/png"
        ? await output.embedPng(item.verifiedBytes)
        : item.mimeType === "image/jpeg"
          ? await output.embedJpg(item.verifiedBytes)
          : null;
  if (!image) {
    throw new Error("report-evidence-type-unsupported");
  }
  cache.set(cacheKey, image);
  return image;
}

function drawEvidenceImageOnPage(
  page: ReturnType<PDFLibDocument["addPage"]>,
  image: EmbeddedEvidenceImage,
  item: ReportEvidence,
  regular: Awaited<ReturnType<PDFLibDocument["embedFont"]>>,
  size: readonly [number, number],
): void {
  const scaled = image.scaleToFit(size[0] - 40, size[1] - 52);
  page.drawImage(image, {
    x: (size[0] - scaled.width) / 2,
    y: 28 + (size[1] - 52 - scaled.height) / 2,
    width: scaled.width,
    height: scaled.height,
  });
  page.drawText(
    truncate(
      item.reportCaption || item.displayName,
      size[0] > size[1] ? 120 : 80,
    ),
    {
      x: 20,
      y: 12,
      size: 7,
      font: regular,
      color: rgb(0.3, 0.3, 0.3),
    },
  );
}

function isHashLockedHistoricalSourcePage(
  context: RenderContext,
  page: Extract<Ucm25PlannedPage, { type: "evidence" }>,
): boolean {
  return (
    context.detail.project.season === 2025 &&
    context.detail.project.is_historical &&
    /^historical-evidence-chunk-\d{3}\.pdf$/.test(
      page.evidence.displayName,
    )
  );
}

function drawHistoricalSourceImageOnPage(
  page: ReturnType<PDFLibDocument["addPage"]>,
  image: EmbeddedEvidenceImage,
  size: readonly [number, number],
): void {
  const scaled = image.scaleToFit(size[0], size[1]);
  page.drawImage(image, {
    x: (size[0] - scaled.width) / 2,
    y: (size[1] - scaled.height) / 2,
    width: scaled.width,
    height: scaled.height,
  });
}

async function drawVerifiedEvidenceInTechnicalFrame(
  output: PDFLibDocument,
  page: ReturnType<PDFLibDocument["addPage"]>,
  item: ReportEvidence,
  sourcePageIndex: number | null,
  evidenceImageCache: Map<string, EmbeddedEvidenceImage>,
  customFrame?: {
    x: number;
    y: number;
    width: number;
    height: number;
    horizontalAlign?: "center" | "right";
  },
): Promise<void> {
  const frame = customFrame ?? {
    x: 35,
    y: 145,
    width: A4_LANDSCAPE[0] - 70,
    height: 405,
  };
  page.drawRectangle({
    ...frame,
    color: rgb(1, 1, 1),
  });
  const image = await embedVerifiedEvidenceImage(
    output,
    item,
    sourcePageIndex,
    evidenceImageCache,
  );
  const scaled = image.scaleToFit(frame.width, frame.height);
  page.drawImage(image, {
    x:
      frame.horizontalAlign === "right"
        ? frame.x + frame.width - scaled.width
        : frame.x + (frame.width - scaled.width) / 2,
    y: frame.y + (frame.height - scaled.height) / 2,
    width: scaled.width,
    height: scaled.height,
  });
}

function pdfLibFrameFromPdfKit(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x,
    y: A4_LANDSCAPE[1] - y - height,
    width,
    height,
  };
}

interface SummarySystem {
  code: string;
  name: string;
  breakdown: CostBreakdown;
}

function summarySystems(detail: ProjectDetail): SummarySystem[] {
  const byCode = new Map(
    detail.tree.children.map((system) => [
      system.system_code ?? "",
      system,
    ]),
  );
  const codes = [
    ...new Set([
      ...systemDefinitions.map((system) => system.code),
      "AV",
      ...detail.tree.children.flatMap((system) =>
        system.system_code ? [system.system_code] : [],
      ),
    ]),
  ];
  return codes.map((code) => {
    const system = byCode.get(code);
    return {
      code,
      name: reportSystemNames[code] ?? system?.name ?? code,
      breakdown:
        (system
          ? historicalMetadata(system)?.historicalSummaryBreakdown
          : null) ??
        system?.breakdown ??
        zeroBreakdown(),
    };
  });
}

function entryNumber(detail: ProjectDetail): string {
  const entryNumber = detail.project.entry_number.trim();
  if (!entryNumber) {
    throw new Error("report-entry-number-missing");
  }
  return entryNumber;
}

function conciseSystemName(system: ProjectNode): string {
  switch (system.system_code) {
    case "BR":
      return "Brake";
    case "DR":
      return "Drivetrain";
    default:
      return systemName(system.system_code ?? "") || system.name;
  }
}

function ownBreakdown(node: ProjectNode): CostBreakdown {
  const historical = historicalMetadata(node)?.historicalBomBreakdown;
  if (historical) {
    return historical;
  }
  const values: Record<CostKind, Decimal> = {
    material: new Decimal(0),
    process: new Decimal(0),
    fastener: new Decimal(0),
    tooling: new Decimal(0),
  };
  for (const line of node.costLines) {
    values[line.kind] = values[line.kind].plus(line.subtotal);
  }
  return {
    material: values.material.toString(),
    process: values.process.toString(),
    fastener: values.fastener.toString(),
    tooling: values.tooling.toString(),
    total: costKinds
      .reduce((sum, kind) => sum.plus(values[kind]), new Decimal(0))
      .toString(),
  };
}

const UCM25_ACCEPTED_SOURCE_SHA256 =
  "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37";

interface HistoricalMetadata {
  sourcePdfSha256?: string;
  historicalBomBreakdown?: CostBreakdown;
  historicalBomExtendedCost?: string;
  historicalBomHeaderTotal?: string;
  historicalSummaryBreakdown?: CostBreakdown;
  historicalDetailCost?: string;
  historicalDetailExtendedCost?: string;
  historicalDetailQuantity?: string;
}

function isBreakdown(value: unknown): value is CostBreakdown {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["material", "process", "fastener", "tooling", "total"].every(
    (key) => typeof record[key] === "string",
  );
}

function historicalMetadata(
  node: ProjectNode,
): HistoricalMetadata | null {
  if (!node.internal_note) {
    return null;
  }
  try {
    const raw = JSON.parse(node.internal_note) as Record<string, unknown>;
    if (raw.sourcePdfSha256 !== UCM25_ACCEPTED_SOURCE_SHA256) {
      return null;
    }
    return {
      sourcePdfSha256: raw.sourcePdfSha256,
      historicalBomBreakdown: isBreakdown(raw.historicalBomBreakdown)
        ? raw.historicalBomBreakdown
        : undefined,
      historicalBomExtendedCost:
        typeof raw.historicalBomExtendedCost === "string"
          ? raw.historicalBomExtendedCost
          : undefined,
      historicalBomHeaderTotal:
        typeof raw.historicalBomHeaderTotal === "string"
          ? raw.historicalBomHeaderTotal
          : undefined,
      historicalSummaryBreakdown: isBreakdown(
        raw.historicalSummaryBreakdown,
      )
        ? raw.historicalSummaryBreakdown
        : undefined,
      historicalDetailCost:
        typeof raw.historicalDetailCost === "string"
          ? raw.historicalDetailCost
          : undefined,
      historicalDetailExtendedCost:
        typeof raw.historicalDetailExtendedCost === "string"
          ? raw.historicalDetailExtendedCost
          : undefined,
      historicalDetailQuantity:
        typeof raw.historicalDetailQuantity === "string"
          ? raw.historicalDetailQuantity
          : undefined,
    };
  } catch {
    return null;
  }
}

function reportSummaryBreakdown(detail: ProjectDetail): CostBreakdown {
  return (
    historicalMetadata(detail.tree)?.historicalSummaryBreakdown ??
    detail.breakdown
  );
}

function reportBomHeaderTotal(detail: ProjectDetail): string {
  return (
    historicalMetadata(detail.tree)?.historicalBomHeaderTotal ??
    detail.breakdown.total
  );
}

function reportBomSystemBreakdown(system: ProjectNode): CostBreakdown {
  const reportable = flattenNodes(system).filter(
    (node) =>
      node.kind === "assembly" ||
      node.kind === "subassembly" ||
      node.kind === "part",
  );
  const declared = reportable.map((node) => ({
    node,
    metadata: historicalMetadata(node),
  }));
  if (
    declared.length === 0 ||
    declared.some((item) => !item.metadata?.historicalBomBreakdown)
  ) {
    return system.breakdown;
  }
  const values: Record<keyof CostBreakdown, Decimal> = {
    material: new Decimal(0),
    process: new Decimal(0),
    fastener: new Decimal(0),
    tooling: new Decimal(0),
    total: new Decimal(0),
  };
  for (const { node, metadata } of declared) {
    const breakdown = metadata!.historicalBomBreakdown!;
    const quantity = new Decimal(node.quantity);
    for (const kind of costKinds) {
      values[kind] = values[kind].plus(
        new Decimal(breakdown[kind]).times(quantity),
      );
    }
    values.total = values.total.plus(
      metadata!.historicalBomExtendedCost ??
        new Decimal(breakdown.total).times(quantity),
    );
  }
  return {
    material: values.material.toString(),
    process: values.process.toString(),
    fastener: values.fastener.toString(),
    tooling: values.tooling.toString(),
    total: values.total.toString(),
  };
}

function subtractBreakdown(
  left: CostBreakdown,
  right: CostBreakdown,
): CostBreakdown {
  return {
    material: new Decimal(left.material).minus(right.material).toString(),
    process: new Decimal(left.process).minus(right.process).toString(),
    fastener: new Decimal(left.fastener).minus(right.fastener).toString(),
    tooling: new Decimal(left.tooling).minus(right.tooling).toString(),
    total: new Decimal(left.total).minus(right.total).toString(),
  };
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

function moneyCell(value: Decimal.Value): string {
  return new Decimal(value).isZero()
    ? "$ -"
    : `$ ${displayUniversalDollars(value)}`;
}

function displayNumber(value: Decimal.Value): string {
  const decimal = new Decimal(value);
  if (decimal.isZero()) {
    return "0";
  }
  const fixed = decimal.toDecimalPlaces(4).toFixed();
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

function displayCostNumber(value: Decimal.Value): string {
  const fixed = new Decimal(value)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function parseSizeInputs(raw: string): {
  size1: string;
  unit1: string;
  size2: string;
  unit2: string;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = (key: string): string =>
      ["string", "number"].includes(typeof parsed[key])
        ? String(parsed[key])
        : "";
    return {
      size1: value("size1"),
      unit1: value("size1Unit"),
      size2: value("size2"),
      unit2: value("size2Unit"),
    };
  } catch {
    return { size1: "", unit1: "", size2: "", unit2: "" };
  }
}

function historicalLineDisplay(line: CostLineRow): {
  sourceOrder?: number;
  multiplierDisplay?: string;
  unitDisplay?: string;
  recoveredQuantityMissing: boolean;
} {
  try {
    const raw = JSON.parse(line.calculation_json) as Record<string, unknown>;
    return {
      sourceOrder:
        typeof raw.sourceOrder === "number" ? raw.sourceOrder : undefined,
      multiplierDisplay:
        typeof raw.sourceMultiplierDisplay === "string"
          ? raw.sourceMultiplierDisplay
          : undefined,
      unitDisplay:
        typeof raw.sourceUnitDisplay === "string"
          ? raw.sourceUnitDisplay
          : undefined,
      recoveredQuantityMissing: raw.recoveredQuantityMissing === true,
    };
  } catch {
    return { recoveredQuantityMissing: false };
  }
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

function displayNodeNumber(
  node: Pick<ProjectNode, "id" | "full_number">,
  mode: ReportMode,
): string {
  return identityValue(
    node.full_number,
    mode,
    "full-number",
    node.id,
  );
}

export function assertRendererIdentity(
  detail: ProjectDetail,
  mode: ReportMode,
): void {
  drawingIdentity(detail.tree, mode);
  for (const node of detail.flatNodes) {
    if (
      node.kind === "assembly" ||
      node.kind === "subassembly" ||
      node.kind === "part"
    ) {
      drawingIdentity(node, mode);
    }
  }
}

export function drawingIdentity(
  node: Pick<ProjectNode, "id" | "full_number" | "revision">,
  mode: ReportMode,
): { partNumber: string; revision: string } {
  return {
    partNumber: identityValue(
      node.full_number,
      mode,
      "full-number",
      node.id,
    ),
    revision: identityValue(
      node.revision,
      mode,
      "revision",
      node.id,
    ),
  };
}

function identityValue(
  value: string | null,
  mode: ReportMode,
  field: "full-number" | "revision",
  nodeId: string,
): string {
  const exact = value?.trim();
  if (exact) {
    return exact;
  }
  if (mode === "competition-ready") {
    throw new Error(
      `competition-ready-report-identity-missing:${nodeId}:${field}`,
    );
  }
  if (mode === "deadline") {
    return field === "full-number"
      ? DEADLINE_MISSING_NUMBER
      : DEADLINE_MISSING_REVISION;
  }
  if (mode === "draft") {
    return field === "full-number"
      ? DRAFT_MISSING_NUMBER
      : DRAFT_MISSING_REVISION;
  }
  return "MISSING";
}

function findNode(
  root: ProjectNode,
  id: string | null,
): ProjectNode | null {
  if (!id) {
    return null;
  }
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function bomColumnWidths(): number[] {
  return [
    17.4, 114.57, 24.69, 24.69, 24.69, 24.69, 72.82,
    92.66, 149.3, 33.27, 33.54, 30.38, 30.38, 30.64, 29.53,
    36.83, 31.59,
  ];
}

interface CellOptions {
  fill?: string;
  textColor?: string;
  font?: string;
  fontSize?: number;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "center";
  lineWidth?: number;
  padding?: number;
  ellipsis?: boolean;
  fitText?: boolean;
  minFontSize?: number;
  stroke?: boolean;
}

interface RowOptions extends CellOptions {
  height: number;
  alignments?: Array<"left" | "center" | "right">;
}

function drawTableRow(
  document: PDFKit.PDFDocument,
  x: number,
  y: number,
  widths: number[],
  values: string[],
  options: RowOptions,
): void {
  let cellX = x;
  widths.forEach((width, index) => {
    drawCell(document, cellX, y, width, options.height, values[index] ?? "", {
      ...options,
      align: options.alignments?.[index] ?? options.align,
    });
    cellX += width;
  });
}

function drawCell(
  document: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  options: CellOptions = {},
): void {
  document.save();
  if (options.fill) {
    document.rect(x, y, width, height).fill(options.fill);
  }
  if (options.stroke !== false) {
    document
      .lineWidth(options.lineWidth ?? 0.5)
      .strokeColor(GRID)
      .rect(x, y, width, height)
      .stroke();
  }
  document.restore();
  const padding = options.padding ?? 2;
  let fontSize = options.fontSize ?? 8;
  const minimumFontSize = Math.min(
    fontSize,
    options.minFontSize ?? 5,
  );
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const measureText = (): number =>
    document
      .font(options.font ?? "Carlito")
      .fontSize(fontSize)
      .heightOfString(text, {
        width: availableWidth,
        lineGap: 0,
      });
  let textHeight = measureText();
  while (
    options.fitText &&
    textHeight > availableHeight &&
    fontSize > minimumFontSize
  ) {
    fontSize = Math.max(minimumFontSize, fontSize - 0.2);
    textHeight = measureText();
  }
  const textY =
    options.verticalAlign === "center"
      ? y + Math.max(0, (height - textHeight) / 2)
      : y + padding;
  document
    .font(options.font ?? "Carlito")
    .fontSize(fontSize)
    .fillColor(options.textColor ?? TEXT)
    .text(text, x + padding, textY, {
      width: Math.max(1, width - padding * 2),
      height: Math.max(1, height - (textY - y) - 1),
      align: options.align ?? "left",
      ellipsis: options.ellipsis ?? false,
      lineGap: 0,
    });
}

function drawBottomStripe(
  document: PDFKit.PDFDocument,
): void {
  const height = document.page.height;
  document.save();
  document
    .rect(0, height - 14.5, document.page.width, 14.5)
    .fill("#ef2b2d")
    .polygon(
      [250, height],
      [document.page.width, height - 4],
      [document.page.width, height],
    )
    .fill("#111111");
  document.restore();
}

function drawUcmLockup(
  document: PDFKit.PDFDocument,
  context: RenderContext,
  x: number,
  y: number,
  width: number,
  withTagline: boolean,
): void {
  const markHeight = width * 0.4;
  if (fs.existsSync(context.ucmMarkPath)) {
    document.image(context.ucmMarkPath, x, y, {
      width,
      height: markHeight,
    });
  }
  void withTagline;
}

function drawManagementLockup(
  document: PDFKit.PDFDocument,
  context: RenderContext,
): void {
  if (fs.existsSync(context.ucmMarkOnlyPath)) {
    document.image(context.ucmMarkOnlyPath, 57, 32, {
      width: 57,
      height: 20,
    });
  }
  document
    .strokeColor("#aaaaaa")
    .lineWidth(0.8)
    .moveTo(117, 33)
    .lineTo(117, 52)
    .stroke()
    .font("Carlito")
    .fontSize(15)
    .fillColor("#666666")
    .text("MANAGEMENT", 121, 35, { lineBreak: false });
}

function drawRingSegment(
  document: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  startAngle: number,
  endAngle: number,
  color: string,
): void {
  const sweep = endAngle - startAngle;
  if (sweep >= 359.9) {
    document
      .circle(cx, cy, radius)
      .lineWidth(thickness)
      .strokeColor(color)
      .stroke();
    return;
  }
  const outer = radius + thickness / 2;
  const inner = radius - thickness / 2;
  const startOuter = polar(cx, cy, outer, startAngle);
  const endOuter = polar(cx, cy, outer, endAngle);
  const endInner = polar(cx, cy, inner, endAngle);
  const startInner = polar(cx, cy, inner, startAngle);
  const large = sweep > 180 ? 1 : 0;
  const pathData = [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outer} ${outer} 0 ${large} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${inner} ${inner} 0 ${large} 0 ${startInner.x} ${startInner.y}`,
    "Z",
  ].join(" ");
  document.path(pathData).fill(color);
}

function polar(
  cx: number,
  cy: number,
  radius: number,
  degrees: number,
): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function drawHierarchyBox(
  document: PDFKit.PDFDocument,
  box: { x: number; y: number; width: number; height: number },
  label: string,
  bold = false,
): void {
  document
    .lineWidth(0.65)
    .strokeColor("#000000")
    .rect(box.x, box.y, box.width, box.height)
    .stroke()
    .font(bold ? "Carlito-Bold" : "Carlito")
    .fontSize(7.5)
    .fillColor("#111111")
    .text(label, box.x + 4, box.y + 5, {
      width: box.width - 8,
      height: box.height - 8,
      align: "center",
      ellipsis: true,
    });
}

function drawElbowArrow(
  document: PDFKit.PDFDocument,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  const midX = startX + Math.max(18, (endX - startX) * 0.45);
  document
    .strokeColor("#000000")
    .fillColor("#000000")
    .lineWidth(0.65)
    .moveTo(startX, startY)
    .lineTo(midX, startY)
    .lineTo(midX, endY)
    .lineTo(endX - 6, endY)
    .stroke()
    .polygon(
      [endX - 6, endY - 3.5],
      [endX, endY],
      [endX - 6, endY + 3.5],
    )
    .fill();
}

type IllustrationPoint = [number, number];

function drawDrawingTitleBlock(
  document: PDFKit.PDFDocument,
  input: {
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    partNumber: string;
    revision: string;
    quantity: string;
    context: RenderContext;
  },
): void {
  const { x, y, width, height } = input;
  document
    .lineWidth(0.55)
    .strokeColor("#000000")
    .rect(x, y, width, height)
    .stroke()
    .moveTo(x + width * 0.55, y)
    .lineTo(x + width * 0.55, y + height)
    .stroke()
    .moveTo(x, y + 37)
    .lineTo(x + width, y + 37)
    .stroke()
    .moveTo(x + width * 0.55, y + 72)
    .lineTo(x + width, y + 72)
    .stroke();
  drawUcmLockup(document, input.context, x + 8, y + 6, 66, false);
  document
    .font("Carlito")
    .fontSize(7)
    .fillColor("#111111")
    .text("NOT FOR MANUFACTURE", x + 82, y + 13, {
      width: width * 0.55 - 90,
      align: "center",
    })
    .font("Carlito-Bold")
    .fontSize(10)
    .text(
      "UNIVERSITY OF CANTERBURY\nMOTORSPORT",
      x + width * 0.55,
      y + 10,
      { width: width * 0.45, align: "center" },
    )
    .fontSize(10)
    .text(input.title, x + width * 0.55 + 5, y + 44, {
      width: width * 0.45 - 10,
      height: 26,
      align: "center",
    })
    .font("Carlito")
    .fontSize(5)
    .text("MATERIAL", x + 6, y + 43)
    .text("N/A", x + 6, y + 57, {
      width: width * 0.25,
      align: "center",
    })
    .fontSize(5.5)
    .text("SIZE", x + width * 0.55 + 4, y + 76)
    .font("Carlito-Bold")
    .fontSize(14)
    .text("A3", x + width * 0.55 + 4, y + 83)
    .font("Carlito")
    .fontSize(5.5)
    .text("PART NO.", x + width * 0.62, y + 76)
    .fontSize(12)
    .text(input.partNumber, x + width * 0.62, y + 84, {
      width: width * 0.32,
      ellipsis: true,
    })
    .fontSize(5.5)
    .text("REV.", x + width - 28, y + 76)
    .fontSize(10)
    .text(input.revision, x + width - 24, y + 84);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 3)}...`;
}
