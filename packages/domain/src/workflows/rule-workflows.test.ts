import { describe, expect, it } from "vitest";

import {
  assertCairTransition,
  assertSubmissionTransition,
  validateAmendmentWorkflow,
} from "./rule-workflows";

describe("rule workflow guards", () => {
  it("keeps modified amendments in preview until verified clarification exists", () => {
    const items = [
      {
        id: "old",
        action: "remove" as const,
        costBox: "material" as const,
        classification: "modified" as const,
        changeGroupId: "change-1",
        partIdentity: "CH-001",
        originalQuantity: "1",
        revisedQuantity: "1",
      },
      {
        id: "new",
        action: "add" as const,
        costBox: "material" as const,
        classification: "modified" as const,
        changeGroupId: "change-1",
        partIdentity: "CH-001",
        originalQuantity: "1",
        revisedQuantity: "1",
      },
    ];
    expect(
      validateAmendmentWorkflow(items).map(({ code }) => code),
    ).toEqual([
      "amendment-official-template-unavailable",
      "amendment-modified-classification-unresolved",
    ]);
    expect(
      validateAmendmentWorkflow(items, {
        officialTemplateReference: "verified-template-sha256",
        modifiedClassificationReference: "committee-clarification-2026-01",
      }),
    ).toEqual([]);
  });

  it("requires official catalogue linkage to resolve a submitted CAIR", () => {
    expect(() =>
      assertCairTransition({
        current: "submitted",
        next: "catalogue-resolved",
      }),
    ).toThrow("cair-catalogue-resolution-required");
    expect(() =>
      assertCairTransition({
        current: "submitted",
        next: "catalogue-resolved",
        resolvingCatalogueReleaseId: "release",
        resolvingCatalogueItemId: "item",
      }),
    ).not.toThrow();
  });

  it("never implies an external submission from export alone", () => {
    expect(() =>
      assertSubmissionTransition(
        "exported",
        "manually-submitted",
      ),
    ).toThrow("submission-external-reference-required");
    expect(() =>
      assertSubmissionTransition(
        "exported",
        "manually-submitted",
        "receipt-123",
      ),
    ).not.toThrow();
  });
});
