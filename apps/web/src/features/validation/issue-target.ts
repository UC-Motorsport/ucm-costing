import type { ValidationIssue } from "@/lib/api"

export const knownValidationIssueCodes = [
  "report-setup-unconfirmed",
  "required-focus-system-missing",
  "project-summary-missing",
  "numbering-convention-missing",
  "bulk-method-summary-missing",
  "vehicle-number-missing",
  "vehicle-revision-missing",
  "assembly-number-missing",
  "assembly-revision-missing",
  "part-not-costed",
  "part-number-missing",
  "part-revision-missing",
  "made-bought-unset",
  "part-visual-missing",
  "cost-line-source-unlinked",
  "cost-multiplier-source-unlinked",
  "critical-datasheet-cells",
  "critical-datasheet-bms",
  "critical-datasheet-motors",
  "critical-datasheet-motor-controllers",
  "critical-datasheet-main-controller",
  "critical-datasheet-lv-battery",
  "critical-datasheet-engine",
  "critical-datasheet-ecu",
  "critical-datasheet-injectors",
  "scoring-multipliers-unpublished",
  "amendment-route-conflict",
  "stock-size-partial",
] as const

export type KnownValidationIssueCode =
  (typeof knownValidationIssueCodes)[number]

export type ReportSetupField =
  | "report-setup"
  | "project-summary"
  | "numbering-convention"
  | "bulk-method-summary"

export type NodeEditorSection =
  | "record"
  | "cost-lines"
  | "evidence"
  | "children"

export type ValidationDestinationPage = "validation" | "rule-pack"

export type CriticalDatasheetTag =
  | "cells"
  | "bms"
  | "motors"
  | "motor-controllers"
  | "main-controller"
  | "lv-battery"
  | "engine"
  | "ecu"
  | "injectors"

export interface ReportSetupIssueTarget {
  kind: "project"
  field: ReportSetupField
  actionLabel: string
}

export interface PageIssueTarget {
  kind: "page"
  page: ValidationDestinationPage
  anchor?: string
  query?: Readonly<Record<string, string>>
  actionLabel: string
}

export interface NodeIssueTarget {
  kind: "node"
  nodeId: string
  section: NodeEditorSection
  actionLabel: string
}

export type ValidationIssueTarget =
  | ReportSetupIssueTarget
  | PageIssueTarget
  | NodeIssueTarget

type NodeIssueTargetSpec = Omit<NodeIssueTarget, "nodeId">

type ValidationIssueTargetSpec =
  | ReportSetupIssueTarget
  | PageIssueTarget
  | NodeIssueTargetSpec

export const VALIDATION_ISSUE_TARGETS = {
  "report-setup-unconfirmed": {
    kind: "project",
    field: "report-setup",
    actionLabel: "Open report setup",
  },
  "required-focus-system-missing": {
    kind: "page",
    page: "rule-pack",
    anchor: "governing-sources",
    actionLabel: "Review 2026 drawing scope",
  },
  "project-summary-missing": {
    kind: "project",
    field: "project-summary",
    actionLabel: "Add cost-management summary",
  },
  "numbering-convention-missing": {
    kind: "project",
    field: "numbering-convention",
    actionLabel: "Document numbering",
  },
  "bulk-method-summary-missing": {
    kind: "project",
    field: "bulk-method-summary",
    actionLabel: "Add bulk methods",
  },
  "vehicle-number-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add vehicle number",
  },
  "vehicle-revision-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add vehicle revision",
  },
  "assembly-number-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add assembly number",
  },
  "assembly-revision-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add assembly revision",
  },
  "part-not-costed": {
    kind: "node",
    section: "cost-lines",
    actionLabel: "Add cost lines",
  },
  "part-number-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add part number",
  },
  "part-revision-missing": {
    kind: "node",
    section: "record",
    actionLabel: "Add part revision",
  },
  "made-bought-unset": {
    kind: "node",
    section: "record",
    actionLabel: "Set made or bought",
  },
  "part-visual-missing": {
    kind: "node",
    section: "evidence",
    actionLabel: "Complete required evidence",
  },
  "cost-line-source-unlinked": {
    kind: "node",
    section: "cost-lines",
    actionLabel: "Review cost sources",
  },
  "cost-multiplier-source-unlinked": {
    kind: "node",
    section: "cost-lines",
    actionLabel: "Review multipliers",
  },
  "critical-datasheet-cells": datasheetTarget(
    "cells",
    "Attach cell datasheet",
  ),
  "critical-datasheet-bms": datasheetTarget(
    "bms",
    "Attach BMS datasheet",
  ),
  "critical-datasheet-motors": datasheetTarget(
    "motors",
    "Attach motor datasheet",
  ),
  "critical-datasheet-motor-controllers": datasheetTarget(
    "motor-controllers",
    "Attach controller datasheet",
  ),
  "critical-datasheet-main-controller": datasheetTarget(
    "main-controller",
    "Attach VCU or ECU datasheet",
  ),
  "critical-datasheet-lv-battery": datasheetTarget(
    "lv-battery",
    "Attach LV battery datasheet",
  ),
  "critical-datasheet-engine": datasheetTarget(
    "engine",
    "Attach engine datasheet",
  ),
  "critical-datasheet-ecu": datasheetTarget(
    "ecu",
    "Attach ECU datasheet",
  ),
  "critical-datasheet-injectors": datasheetTarget(
    "injectors",
    "Attach injector datasheet",
  ),
  "scoring-multipliers-unpublished": {
    kind: "page",
    page: "rule-pack",
    anchor: "committee-confirmation",
    actionLabel: "Review rule pack",
  },
  "amendment-route-conflict": {
    kind: "page",
    page: "rule-pack",
    anchor: "committee-confirmation",
    actionLabel: "Review rule pack",
  },
  "stock-size-partial": {
    kind: "page",
    page: "rule-pack",
    anchor: "governing-sources",
    actionLabel: "Review governing sources",
  },
} as const satisfies Record<
  KnownValidationIssueCode,
  ValidationIssueTargetSpec
>

export function isKnownValidationIssueCode(
  code: string,
): code is KnownValidationIssueCode {
  return Object.hasOwn(VALIDATION_ISSUE_TARGETS, code)
}

export function resolveValidationIssueTarget(
  issue: Pick<ValidationIssue, "code" | "nodeId">,
): ValidationIssueTarget | null {
  if (!isKnownValidationIssueCode(issue.code)) {
    return issue.nodeId
      ? {
          kind: "node",
          nodeId: issue.nodeId,
          section: "record",
          actionLabel: "Open item",
        }
      : null
  }

  const target = VALIDATION_ISSUE_TARGETS[issue.code]
  if (target.kind !== "node") return target
  if (!issue.nodeId) return null

  return {
    ...target,
    nodeId: issue.nodeId,
  }
}

export function validationIssueTargetHref(
  target: ValidationIssueTarget,
): string {
  if (target.kind === "project") {
    const search = new URLSearchParams({ field: target.field })
    return `/setup?${search}`
  }

  if (target.kind === "node") {
    const search = new URLSearchParams({
      node: target.nodeId,
      section: target.section,
    })
    return `/?${search}`
  }

  const path =
    target.page === "validation" ? "/validation" : "/rule-pack"
  const search = target.query
    ? `?${new URLSearchParams(target.query)}`
    : ""
  const hash = target.anchor ? `#${encodeURIComponent(target.anchor)}` : ""
  return `${path}${search}${hash}`
}

function datasheetTarget(
  tag: CriticalDatasheetTag,
  actionLabel: string,
): PageIssueTarget {
  return {
    kind: "page",
    page: "validation",
    anchor: "critical-datasheets",
    query: { datasheet: tag },
    actionLabel,
  }
}
