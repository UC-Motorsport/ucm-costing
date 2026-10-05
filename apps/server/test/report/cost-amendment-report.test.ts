import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  assertCostAmendmentCanLock,
  buildCostAmendmentSnapshot,
  renderCostAmendmentPreview,
  type CostAmendmentReportInput,
} from "../../src/report/cost-amendment-report";

const zero = {
  material: "0",
  process: "0",
  fastener: "0",
  tooling: "0",
  total: "0",
};

function fixture(): CostAmendmentReportInput {
  return {
    schemaVersion: 1,
    amendmentId: "amendment-1",
    eventReference: "FSAE-A 2026",
    createdAt: "2026-12-01T08:00:00.000Z",
    project: {
      id: "project-1",
      name: "University of Canterbury Motorsport",
      entryNumber: "26",
    },
    baseReport: {
      snapshotId: "report-1",
      sha256: "a".repeat(64),
      breakdown: {
        material: "100",
        process: "0",
        fastener: "0",
        tooling: "0",
        total: "100",
      },
    },
    rulePack: {
      version: "FSAE-A 2026 Local Addendum v1.2",
      sha256: "b".repeat(64),
    },
    catalogue: {
      releaseId: "release-26-r1",
      revision: "26_R1",
      sha256: "c".repeat(64),
    },
    parts: [
      {
        partIdentity: "CH-NEW",
        partNumber: "CH-NEW",
        description: "New bracket",
        originalQuantity: "0",
        revisedQuantity: "1",
        original: zero,
      },
    ],
    items: [
      {
        id: "change-1",
        action: "add",
        costBox: "material",
        classification: "new",
        changeGroupId: null,
        partIdentity: "CH-NEW",
        originalQuantity: "0",
        revisedQuantity: "1",
        nodeId: null,
        description: "New bracket material",
        quantity: "1",
        unitCost: "10",
        subtotal: "10",
        catalogueReleaseId: "release-26-r1",
        catalogueItemId: "item-1",
        catalogueId: "M-001",
      },
    ],
  };
}

describe("Cost Amendment Report preview", () => {
  it("freezes raw and penalty-adjusted values separately", () => {
    const snapshot = buildCostAmendmentSnapshot(fixture());
    expect(snapshot.calculation.rawRevised.total).toBe("110");
    expect(snapshot.calculation.amendmentDelta.total).toBe("10.5");
    expect(snapshot.calculation.adjustedRevised.total).toBe("110.5");
    expect(snapshot.previewOnly).toBe(true);
    expect(snapshot.issues.map(({ code }) => code)).toContain(
      "amendment-official-template-unavailable",
    );
  });

  it("renders a valid watermarked review PDF but refuses final lock", async () => {
    const result = await renderCostAmendmentPreview(fixture());
    const pdf = await PDFDocument.load(result.bytes, {
      updateMetadata: false,
    });
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(result.pageCount).toBe(pdf.getPageCount());
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertCostAmendmentCanLock(result.snapshot)).toThrow(
      "Cost amendment contains",
    );
  });

  it("does not trust a stored item subtotal", () => {
    const input = fixture();
    input.items[0]!.subtotal = "10.01";
    const snapshot = buildCostAmendmentSnapshot(input);
    expect(snapshot.issues.map(({ code }) => code)).toContain(
      "amendment-item-subtotal-mismatch",
    );
  });
});
