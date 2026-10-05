import type { ValidationIssue } from "@ucm/domain";
import type { QueryResultRow } from "pg";

import type {
  DatabaseHandle,
  DbExecutor,
} from "../db/database";
import {
  assertProjectPermission,
  type ActorContext,
} from "../security/authorization";
import {
  getProjectDetailFromExecutor,
} from "./project-detail-service";
import type {
  ProjectDetail,
  ProjectNode,
} from "./project-types";

export interface ValidationResult {
  projectId: string;
  checkedAt: string;
  mode: "draft" | "deadline" | "competition-ready" | "export";
  blockers: number;
  warnings: number;
  notices: number;
  readyForCompetitionReport: boolean;
  issues: ValidationIssue[];
}

interface ValidationEvidenceRow extends QueryResultRow {
  id: string;
  node_id: string | null;
  kind: string;
  display_name: string;
  content_sha256: string;
  storage_path: string;
  mime_type: string;
  report_caption: string;
  visibility: "report" | "internal";
}

interface CairSummaryRow extends QueryResultRow {
  id: string;
  cost_line_id: string | null;
  status: string;
  resolved_catalogue_release_id: string | null;
  resolved_catalogue_item_id: string | null;
}

interface CatalogueReleaseMismatchRow extends QueryResultRow {
  cost_line_id: string;
  node_id: string;
  node_name: string;
  catalogue_item_id: string | null;
  catalogue_item_release_id: string | null;
  multiplier_catalogue_item_id: string | null;
  multiplier_release_id: string | null;
}

const ELECTRIC_DATASHEET_REQUIREMENTS = [
  ["cells", "Cell datasheet"],
  ["bms", "Battery-management system datasheet"],
  ["motors", "Motor datasheet"],
  ["motor-controllers", "Motor-controller datasheet"],
  ["main-controller", "Main VCU or ECU datasheet"],
  ["lv-battery", "Low-voltage battery datasheet"],
] as const;

const COMBUSTION_DATASHEET_REQUIREMENTS = [
  ["engine", "Engine datasheet"],
  ["ecu", "Engine-control unit (ECU) datasheet"],
  ["injectors", "Fuel-injector datasheet"],
] as const;

const PLACEHOLDER_PATTERN =
  /\b(?:demo|example|placeholder|lorem ipsum|to be confirmed|tbc|todo)\b/i;

/**
 * Actor-aware public validation entry point. The project graph, evidence, and
 * CAIR state are read in one repeatable-read transaction.
 */
export async function validateProjectForActor(
  database: DatabaseHandle,
  actor: ActorContext,
  projectId: string,
  mode: ValidationResult["mode"] = "competition-ready",
): Promise<ValidationResult> {
  return await database.transaction(
    async (transaction) => {
      await assertProjectPermission(
        transaction,
        actor,
        projectId,
        "read",
      );
      const detail = await getProjectDetailFromExecutor(
        transaction,
        projectId,
      );
      if (!detail) {
        throw new Error("project-not-found");
      }
      return await validateProject(transaction, detail, mode);
    },
    { isolationLevel: "repeatable read", readOnly: true },
  );
}

/**
 * Internal validation for callers that already hold a consistent database
 * view (notably report snapshot reservation).
 */
export async function validateProject(
  database: DbExecutor,
  detail: ProjectDetail,
  mode: ValidationResult["mode"] = "competition-ready",
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const evidenceResult = await database.query<ValidationEvidenceRow>(
    `
      SELECT id, node_id, kind, display_name, content_sha256,
             storage_path, mime_type, report_caption, visibility
      FROM evidence
      WHERE project_id = $1
      ORDER BY id
    `,
    [detail.project.id],
  );
  const cairResult = await database.query<CairSummaryRow>(
    `
      SELECT id, cost_line_id, status,
             resolved_catalogue_release_id, resolved_catalogue_item_id
      FROM cair_requests
      WHERE project_id = $1
      ORDER BY id
    `,
    [detail.project.id],
  );
  const releaseMismatchResult =
    await database.query<CatalogueReleaseMismatchRow>(
      `
        SELECT
          cl.id AS cost_line_id,
          cn.id AS node_id,
          cn.name AS node_name,
          cl.catalogue_item_id,
          item.release_id AS catalogue_item_release_id,
          cl.multiplier_catalogue_item_id,
          multiplier.release_id AS multiplier_release_id
        FROM cost_lines cl
        JOIN cost_nodes cn ON cn.id = cl.node_id
        LEFT JOIN catalogue_items item
          ON item.id = cl.catalogue_item_id
        LEFT JOIN catalogue_items multiplier
          ON multiplier.id = cl.multiplier_catalogue_item_id
        WHERE cn.project_id = $1
          AND (
            (
              cl.catalogue_item_id IS NOT NULL
              AND item.release_id IS DISTINCT FROM $2
            )
            OR (
              cl.multiplier_catalogue_item_id IS NOT NULL
              AND multiplier.release_id IS DISTINCT FROM $2
            )
          )
        ORDER BY cn.id, cl.id
      `,
      [detail.project.id, detail.project.catalogue_release_id],
    );
  const evidence = evidenceResult.rows.filter((item) => item.visibility === "report");
  const allEvidenceByNode = groupEvidenceByNode(evidenceResult.rows);
  const cairs = cairResult.rows;
  const evidenceByNode = groupEvidenceByNode(evidence);
  const parts = detail.flatNodes.filter((node) => node.kind === "part");
  const reportableNodes = detail.flatNodes.filter(
    ({ kind }) =>
      kind === "assembly" ||
      kind === "subassembly" ||
      kind === "part",
  );

  validateProjectSetup(detail, issues);
  validateDrawingIdentity(detail, reportableNodes, issues);
  validateVehicleEvidence(detail, evidenceByNode, issues);
  validateReportableEvidence(
    detail,
    reportableNodes,
    evidenceByNode,
    allEvidenceByNode,
    issues,
  );
  for (const node of detail.flatNodes) {
    validateCostLineProvenance(node, cairs, issues);
  }
  validateCatalogueReleaseMembership(
    detail.project.catalogue_revision,
    releaseMismatchResult.rows,
    issues,
  );
  for (const part of parts) {
    validatePart(part, issues);
  }
  validateTableCompleteness(detail, issues);
  validateCriticalDatasheets(detail, evidence, issues);
  appendRuleNotices(issues);

  const blockers = issues.filter(
    ({ severity }) => severity === "blocker",
  ).length;
  const warnings = issues.filter(
    ({ severity }) => severity === "warning",
  ).length;
  const notices = issues.filter(
    ({ severity }) => severity === "notice",
  ).length;
  return {
    projectId: detail.project.id,
    checkedAt: new Date().toISOString(),
    mode,
    blockers,
    warnings,
    notices,
    readyForCompetitionReport: blockers === 0,
    issues,
  };
}

function validateProjectSetup(
  detail: ProjectDetail,
  issues: ValidationIssue[],
): void {
  if (
    detail.project.season === 2026 &&
    !detail.project.focusSystems.includes("DR")
  ) {
    issues.push(
      issue(
        "blocker",
        "required-focus-system-missing",
        "The official 2026 drawing focus system DR is not selected",
        "Add DR as the rules-mandated fully prepared drawing system. Additional team focus systems may remain selected.",
        null,
        "Local Addendum S.3.12.2",
      ),
    );
  }
  if (!detail.project.report_setup_confirmation) {
    issues.push(
      issue(
        "blocker",
        "report-setup-unconfirmed",
        "Report setup has no active attestation",
        "Review the report-setup fields and create a versioned confirmation for their exact content hash.",
        null,
        "Local Addendum S.3.4.1",
      ),
    );
  }
  if (!detail.project.entry_number.trim()) {
    issues.push(
      issue(
        "blocker",
        "entry-number-missing",
        "Competition entry number is missing",
        "Record the explicit entry number; the report will not infer it from another field.",
        null,
        "Official Cost Data Table template",
      ),
    );
  }
  validateSubstantiveText(
    detail.project.project_summary,
    "project-summary-missing",
    "Cost-management summary is missing or still a placeholder",
    "Describe cost-versus-performance decisions and bulk-production methods.",
    "Local Addendum S.3.4.1",
    issues,
  );
  validateSubstantiveText(
    detail.project.numbering_convention,
    "numbering-convention-missing",
    "Numbering convention is missing or still a placeholder",
    "Explain the identifier used consistently by the BOM, data tables, drawings, and evidence.",
    "Local Addendum S.3.4.1 and S.3.5",
    issues,
  );
  validateSubstantiveText(
    detail.project.bulk_method_summary,
    "bulk-method-summary-missing",
    "Bulk-manufacturing summary is missing or still a placeholder",
    "Describe the bulk methods used and where they are applied.",
    "Local Addendum S.3.4.1",
    issues,
  );
}

function validateVehicleEvidence(
  detail: ProjectDetail,
  evidenceByNode: ReadonlyMap<string, ValidationEvidenceRow[]>,
  issues: ValidationIssue[],
): void {
  const visuals = evidenceByNode
    .get(detail.tree.id)
    ?.filter(({ kind }) => kind === "drawing" || kind === "image");
  if (!visuals || visuals.length === 0) {
    issues.push(
      issue(
        "blocker",
        "vehicle-visual-missing",
        "The vehicle overview has no verified drawing or image",
        "Attach a report-visible vehicle drawing or image. Draft output will show an honest empty evidence frame; it will not generate vehicle geometry.",
        detail.tree.id,
        "Local Addendum S.3.4.1",
      ),
    );
  }
}

function validateDrawingIdentity(
  detail: ProjectDetail,
  reportableNodes: readonly ProjectNode[],
  issues: ValidationIssue[],
): void {
  validateNodeDrawingIdentity(
    detail.tree,
    "vehicle",
    issues,
  );
  for (const node of reportableNodes) {
    validateNodeDrawingIdentity(
      node,
      node.kind === "part" ? "part" : "assembly",
      issues,
    );
  }
}

function validateNodeDrawingIdentity(
  node: ProjectNode,
  entity: "vehicle" | "assembly" | "part",
  issues: ValidationIssue[],
): void {
  const label =
    entity === "vehicle"
      ? "Vehicle"
      : `${node.name} ${entity}`;
  if (!node.full_number?.trim()) {
    issues.push(
      issue(
        "blocker",
        `${entity}-number-missing`,
        `${label} has no controlled full number`,
        "Record the exact controlled identifier used by the BOM, data table, drawing, and evidence. The report will not construct one from other fields.",
        node.id,
        "Local Addendum S.3.5",
      ),
    );
  }
  if (!node.revision?.trim()) {
    issues.push(
      issue(
        "blocker",
        `${entity}-revision-missing`,
        `${label} has no controlled revision`,
        "Record the exact controlled drawing revision. The report will not assume an initial revision.",
        node.id,
        "Local Addendum S.3.5",
      ),
    );
  }
}

function validateReportableEvidence(
  detail: ProjectDetail,
  reportableNodes: readonly ProjectNode[],
  evidenceByNode: ReadonlyMap<string, ValidationEvidenceRow[]>,
  allEvidenceByNode: ReadonlyMap<string, ValidationEvidenceRow[]>,
  issues: ValidationIssue[],
): void {
  for (const node of reportableNodes) {
    const evidence = evidenceByNode.get(node.id) ?? [];
    const missing: string[] = [];
    if (node.image_required !== false && !evidence.some(({ kind }) => kind === "image")) {
      missing.push("isometric image");
    }
    if (node.drawing_required !== false && !evidence.some(({ kind }) => kind === "drawing")) {
      missing.push("technical drawing");
    }
    if (missing.length === 0) continue;

    const excluded = missing.filter((label) =>
      (allEvidenceByNode.get(node.id) ?? []).some((item) =>
        item.kind === (label === "isometric image" ? "image" : "drawing") &&
        item.visibility === "internal",
      ),
    );
    const absent = missing.filter((label) => !excluded.includes(label));
    const title = [
      ...(absent.length ? [`${node.name} is missing its ${absent.join(" and ")}`] : []),
      ...(excluded.length ? [`${absent.length ? "Attached" : node.name + " has attached"} ${excluded.join(" and ")} excluded from report`] : []),
    ].join("; ");
    const isFocusSystem = detail.project.focusSystems.includes(
      node.system_code ?? "",
    );
    issues.push(
      issue(
        "blocker",
        "part-visual-missing",
        title,
        `${
          isFocusSystem
            ? "The selected focus system requires complete team-owned visuals. "
            : ""
        }Attach report-visible visuals, or mark an isometric image or drawing as not required when it does not apply.${excluded.length ? " Attached internal evidence does not appear in the report; include it in the report from the attachment settings." : ""} A component datasheet is optional here unless it is separately required as a critical datasheet.`,
        node.id,
        "Local Addendum S.3.4.1 and S.3.12.3",
      ),
    );
  }
}

function validatePart(
  part: ProjectNode,
  issues: ValidationIssue[],
): void {
  if (part.costLines.length === 0) {
    issues.push(
      issue(
        "blocker",
        "part-not-costed",
        `${part.name} has no cost lines`,
        "Every vehicle part must be costed with current catalogue materials, processes, fasteners, and required tooling as applicable.",
        part.id,
        "Local Addendum S.3.4.1",
      ),
    );
  }
  if (part.procurement_type === "unknown") {
    issues.push(
      issue(
        "blocker",
        "made-bought-unset",
        `${part.name} is not classified as made or bought`,
        "Confirm the catalogue classification and retain proof for any team-made listed item.",
        part.id,
        "Local Addendum S.3.9",
      ),
    );
  }
}

function validateCostLineProvenance(
  node: ProjectNode,
  cairs: readonly CairSummaryRow[],
  issues: ValidationIssue[],
): void {
  for (const line of node.costLines) {
    if (!line.catalogue_item_id) {
      const cair = cairs.find(
        ({ cost_line_id: costLineId }) => costLineId === line.id,
      );
      const detail =
        cair?.status === "catalogue-resolved"
          ? "The CAIR now references an official catalogue item, but the cost line itself has not been updated to that immutable item."
          : cair
            ? `The linked CAIR is ${cair.status}; a request or receipt does not authorize a private competition price.`
            : "Link the line to the current official catalogue. A typed-in value alone is not competition-ready evidence.";
      issues.push(
        issue(
          "blocker",
          "cost-line-source-unlinked",
          `${node.name} has a cost line without official catalogue provenance`,
          detail,
          node.id,
          "Local Addendum S.3.4.1, S.3.8, and S.3.10",
          line.id,
        ),
      );
    }
    if (line.kind !== "tooling" && !line.multiplier_catalogue_item_id) {
      issues.push(
        issue(
          "blocker",
          "cost-multiplier-source-unlinked",
          `${node.name} has a multiplier without official catalogue provenance`,
          "Select a multiplier from the pinned Process Multipliers sheet; typed values are not competition-ready provenance.",
          node.id,
          "Local Addendum S.3.4.1 and S.3.8",
          line.id,
        ),
      );
    }
    if (
      line.kind === "tooling" &&
      (!line.production_volume_factor ||
        !line.fraction_included)
    ) {
      issues.push(
        issue(
          "blocker",
          "tooling-allocation-input-missing",
          `${node.name} has incomplete tooling allocation inputs`,
          "Every tooling row must preserve an explicit fraction included and production-volume factor. The app does not assume the historical value 3000.",
          node.id,
          "Official Cost Data Table template and 2026 source-gap policy",
          line.id,
        ),
      );
    }
  }
}

function validateCatalogueReleaseMembership(
  projectCatalogueRevision: string,
  mismatches: readonly CatalogueReleaseMismatchRow[],
  issues: ValidationIssue[],
): void {
  for (const mismatch of mismatches) {
    if (
      mismatch.catalogue_item_id &&
      mismatch.catalogue_item_release_id !== null
    ) {
      issues.push(
        issue(
          "blocker",
          "cost-line-catalogue-release-mismatch",
          `${mismatch.node_name} has a cost item from a different catalogue release`,
          `Re-select the item from the project-pinned ${projectCatalogueRevision} catalogue release. Reports never relabel historical item provenance as the current release.`,
          mismatch.node_id,
          "Local Addendum S.3.4.1 and S.3.8",
          mismatch.cost_line_id,
        ),
      );
    }
    if (
      mismatch.multiplier_catalogue_item_id &&
      mismatch.multiplier_release_id !== null
    ) {
      issues.push(
        issue(
          "blocker",
          "cost-multiplier-catalogue-release-mismatch",
          `${mismatch.node_name} has a process multiplier from a different catalogue release`,
          `Re-select the multiplier from the project-pinned ${projectCatalogueRevision} catalogue release.`,
          mismatch.node_id,
          "Local Addendum S.3.4.1 and S.3.8",
          mismatch.cost_line_id,
        ),
      );
    }
  }
}

function validateTableCompleteness(
  detail: ProjectDetail,
  issues: ValidationIssue[],
): void {
  const reportable = detail.flatNodes.filter(
    ({ kind }) =>
      kind === "assembly" ||
      kind === "subassembly" ||
      kind === "part",
  );
  const incomplete = reportable.filter(
    (node) =>
      !node.name.trim() ||
      !node.description.trim() ||
      (node.kind === "part" && node.costLines.length === 0),
  );
  if (reportable.length > 0 && incomplete.length / reportable.length > 0.2) {
    issues.push(
      issue(
        "blocker",
        "cost-tables-over-20-percent-incomplete",
        "More than 20% of required data-table records are incomplete",
        `${incomplete.length} of ${reportable.length} reportable records lack required identity, description, or part costing data.`,
        null,
        "Local Addendum S.3.6",
      ),
    );
  }
  for (const system of detail.tree.children) {
    const records = flatten(system).filter(
      ({ kind }) =>
        kind === "assembly" ||
        kind === "subassembly" ||
        kind === "part",
    );
    if (records.length === 0) {
      issues.push(
        issue(
          "blocker",
          "cost-section-missing",
          `${system.name} has no reportable cost section`,
          "A missing complete report section is treated as an incomplete/not-submitted report.",
          system.id,
          "Local Addendum S.3.6",
        ),
      );
    }
  }
}

function validateCriticalDatasheets(
  detail: ProjectDetail,
  evidence: readonly ValidationEvidenceRow[],
  issues: ValidationIssue[],
): void {
  const tags = new Set(
    evidence
      .filter(({ kind }) => kind === "datasheet")
      .flatMap(
        ({ report_caption: caption }) =>
          caption.match(/\[(.+?)\]/g) ?? [],
      )
      .map((tag) => tag.slice(1, -1).toLowerCase()),
  );
  const requirements = [
    ...(detail.project.vehicle_type === "electric" ||
    detail.project.vehicle_type === "dual"
      ? ELECTRIC_DATASHEET_REQUIREMENTS
      : []),
    ...(detail.project.vehicle_type === "combustion" ||
    detail.project.vehicle_type === "dual"
      ? COMBUSTION_DATASHEET_REQUIREMENTS
      : []),
  ];
  for (const [tag, label] of requirements) {
    if (!tags.has(tag)) {
      issues.push(
        issue(
          "blocker",
          `critical-datasheet-${tag}`,
          `${label} is missing`,
          `Attach report-visible evidence with tag [${tag}] so the critical datasheet appendix is complete.`,
          null,
          "Local Addendum S.3.4.1",
        ),
      );
    }
  }
}

function appendRuleNotices(issues: ValidationIssue[]): void {
  issues.push(
    issue(
      "notice",
      "scoring-multipliers-unpublished",
      "Current D and A multiplier mappings are not published",
      "The app will not estimate a final report score until judge-provided D1-D4, A, Pmin, and Pmax values exist.",
      null,
      "Local Addendum S.3.12 and S.3.16",
    ),
    issue(
      "notice",
      "amendment-official-template-unavailable",
      "The official 2026 Cost Amendment Report template is unavailable",
      "The app implements exact per-BoX 105%/95% preview arithmetic but blocks a final CAR until the promised template and classification clarification are verified.",
      null,
      "Local Addendum S.3.7",
    ),
    issue(
      "notice",
      "amendment-route-conflict",
      "2026 amendment submission wording is inconsistent",
      "PDA-1 says On Site while S.3.7 says one electronic PDF by Saturday 11:59pm without a timezone. Confirm the current process with the Cost Committee.",
      null,
      "Local Addendum PDA-1 and S.3.7",
    ),
    issue(
      "notice",
      "stock-size-partial",
      "Some stock-size edge cases require organizer confirmation",
      "Unlisted or complex stock sizes require a CAIR trail; only an immutable official catalogue item clears report readiness.",
      null,
      "Local Addendum S.3.8 and S.3.10",
    ),
  );
}

function validateSubstantiveText(
  value: string,
  code: string,
  title: string,
  detail: string,
  reference: string,
  issues: ValidationIssue[],
): void {
  if (!value.trim() || PLACEHOLDER_PATTERN.test(value)) {
    issues.push(
      issue(
        "blocker",
        code,
        title,
        detail,
        null,
        reference,
      ),
    );
  }
}

function groupEvidenceByNode(
  evidence: readonly ValidationEvidenceRow[],
): Map<string, ValidationEvidenceRow[]> {
  const result = new Map<string, ValidationEvidenceRow[]>();
  for (const item of evidence) {
    if (!item.node_id) {
      continue;
    }
    const values = result.get(item.node_id) ?? [];
    values.push(item);
    result.set(item.node_id, values);
  }
  return result;
}

function flatten(root: ProjectNode): ProjectNode[] {
  const result: ProjectNode[] = [];
  const visit = (node: ProjectNode): void => {
    result.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return result;
}

function issue(
  severity: ValidationIssue["severity"],
  code: string,
  title: string,
  detail: string,
  nodeId: string | null,
  ruleReference: string | null,
  suffix?: string,
): ValidationIssue {
  return {
    id: `${code}:${suffix ?? nodeId ?? "project"}`,
    severity,
    code,
    title,
    detail,
    nodeId,
    ruleReference,
  };
}
