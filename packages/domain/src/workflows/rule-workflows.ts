import Decimal from "decimal.js";

import { costKinds, type CostKind } from "../costing/calculator";

export const amendmentClassifications = [
  "new",
  "deleted",
  "modified",
  "quantity-change",
  "unresolved",
] as const;

export type AmendmentClassification =
  (typeof amendmentClassifications)[number];

export interface AmendmentWorkflowItem {
  id: string;
  action: "add" | "remove";
  costBox: CostKind;
  classification: AmendmentClassification;
  changeGroupId: string | null;
  partIdentity: string;
  originalQuantity: string;
  revisedQuantity: string;
}

export interface AmendmentClarifications {
  officialTemplateReference?: string | null;
  modifiedClassificationReference?: string | null;
  quantityChangeClassificationReference?: string | null;
}

export interface RuleWorkflowIssue {
  code: string;
  severity: "blocker" | "warning" | "notice";
  message: string;
  itemIds: string[];
}

/**
 * Validates only published facts and structural invariants. It intentionally
 * does not choose how an organizer wants a modification or quantity change
 * classified when the governing package has not answered that question.
 */
export function validateAmendmentWorkflow(
  items: readonly AmendmentWorkflowItem[],
  clarifications: AmendmentClarifications = {},
): RuleWorkflowIssue[] {
  const issues: RuleWorkflowIssue[] = [];
  const groups = new Map<string, AmendmentWorkflowItem[]>();

  for (const item of items) {
    if (!costKinds.includes(item.costBox)) {
      issues.push({
        code: "amendment-cost-box-invalid",
        severity: "blocker",
        message: "Every amendment row must identify a valid cost BoX.",
        itemIds: [item.id],
      });
    }
    validateQuantity(item.originalQuantity, "original", item, issues);
    validateQuantity(item.revisedQuantity, "revised", item, issues);

    if (item.classification === "unresolved") {
      issues.push({
        code: "amendment-classification-unresolved",
        severity: "blocker",
        message:
          "The amendment row must be classified before it can be locked.",
        itemIds: [item.id],
      });
    }

    if (
      item.classification === "modified" ||
      item.classification === "quantity-change"
    ) {
      if (!item.changeGroupId?.trim()) {
        issues.push({
          code: "amendment-change-group-required",
          severity: "blocker",
          message:
            "Modified and quantity-change rows require a shared change-group identifier.",
          itemIds: [item.id],
        });
      } else {
        const members = groups.get(item.changeGroupId) ?? [];
        members.push(item);
        groups.set(item.changeGroupId, members);
      }
    }

    if (
      item.classification === "new" &&
      (item.action !== "add" || !isZeroDecimal(item.originalQuantity))
    ) {
      issues.push({
        code: "amendment-new-row-inconsistent",
        severity: "blocker",
        message:
          "A new-item row must be an addition with an original quantity of zero.",
        itemIds: [item.id],
      });
    }
    if (
      item.classification === "deleted" &&
      (item.action !== "remove" || !isZeroDecimal(item.revisedQuantity))
    ) {
      issues.push({
        code: "amendment-deleted-row-inconsistent",
        severity: "blocker",
        message:
          "A deleted-item row must be a removal with a revised quantity of zero.",
        itemIds: [item.id],
      });
    }
  }

  for (const [changeGroupId, members] of groups) {
    const actions = new Set(members.map(({ action }) => action));
    const identities = new Set(members.map(({ partIdentity }) => partIdentity));
    if (
      !actions.has("add") ||
      !actions.has("remove") ||
      identities.size !== 1
    ) {
      issues.push({
        code: "amendment-change-group-incomplete",
        severity: "blocker",
        message:
          `Change group ${changeGroupId} must pair additions and removals for one part identity.`,
        itemIds: members.map(({ id }) => id),
      });
    }
  }

  if (!clarifications.officialTemplateReference?.trim()) {
    issues.push({
      code: "amendment-official-template-unavailable",
      severity: "blocker",
      message:
        "The official 2026 Cost Amendment Report template is not present in the verified rule pack; preview is available, but lock/final export is blocked.",
      itemIds: [],
    });
  }
  if (
    items.some(({ classification }) => classification === "modified") &&
    !clarifications.modifiedClassificationReference?.trim()
  ) {
    issues.push({
      code: "amendment-modified-classification-unresolved",
      severity: "blocker",
      message:
        "The verified rules do not define the official gross-versus-net treatment for modified parts.",
      itemIds: items
        .filter(({ classification }) => classification === "modified")
        .map(({ id }) => id),
    });
  }
  if (
    items.some(({ classification }) => classification === "quantity-change") &&
    !clarifications.quantityChangeClassificationReference?.trim()
  ) {
    issues.push({
      code: "amendment-quantity-classification-unresolved",
      severity: "blocker",
      message:
        "The verified rules do not define the official gross-versus-net treatment for quantity changes.",
      itemIds: items
        .filter(({ classification }) => classification === "quantity-change")
        .map(({ id }) => id),
    });
  }

  return issues;
}

export const cairStates = [
  "draft",
  "submitted",
  "catalogue-resolved",
  "rejected",
  "cancelled",
] as const;

export type CairState = (typeof cairStates)[number];

export interface CairTransitionInput {
  current: CairState;
  next: CairState;
  externalReference?: string | null;
  resolvingCatalogueReleaseId?: string | null;
  resolvingCatalogueItemId?: string | null;
}

/**
 * Enforces the local authority boundary: only an official catalogue item in an
 * immutable release can resolve a CAIR for competition readiness.
 */
export function assertCairTransition(input: CairTransitionInput): void {
  const allowed: Record<CairState, readonly CairState[]> = {
    draft: ["submitted", "cancelled"],
    submitted: ["catalogue-resolved", "rejected", "cancelled"],
    "catalogue-resolved": [],
    rejected: [],
    cancelled: [],
  };
  if (!allowed[input.current].includes(input.next)) {
    throw new Error("invalid-cair-transition");
  }
  if (
    input.next === "submitted" &&
    !input.externalReference?.trim()
  ) {
    throw new Error("cair-external-reference-required");
  }
  if (
    input.next === "catalogue-resolved" &&
    (!input.resolvingCatalogueReleaseId?.trim() ||
      !input.resolvingCatalogueItemId?.trim())
  ) {
    throw new Error("cair-catalogue-resolution-required");
  }
}

export type SubmissionState =
  | "prepared"
  | "exported"
  | "manually-submitted";

export function assertSubmissionTransition(
  current: SubmissionState,
  next: SubmissionState,
  externalReference?: string | null,
): void {
  const allowed: Record<SubmissionState, readonly SubmissionState[]> = {
    prepared: ["exported"],
    exported: ["manually-submitted"],
    "manually-submitted": [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error("invalid-submission-transition");
  }
  if (next === "manually-submitted" && !externalReference?.trim()) {
    throw new Error("submission-external-reference-required");
  }
}

function validateQuantity(
  value: string,
  label: string,
  item: AmendmentWorkflowItem,
  issues: RuleWorkflowIssue[],
): void {
  try {
    const quantity = new Decimal(value);
    if (!quantity.isFinite() || quantity.isNegative()) {
      throw new Error();
    }
  } catch {
    issues.push({
      code: `amendment-${label}-quantity-invalid`,
      severity: "blocker",
      message: `The ${label} quantity must be a finite non-negative decimal.`,
      itemIds: [item.id],
    });
  }
}

function isZeroDecimal(value: string): boolean {
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.isZero();
  } catch {
    return false;
  }
}
