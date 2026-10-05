import { CATALOGUE_RELEASE_ID } from "./reference-data-identifiers";

export interface CatalogueFormulaCorrection {
  id: string;
  releaseId: string;
  kind: "tooling";
  catalogueId: string;
  expectedSourceFormula: string;
  effectiveFormula: string;
  inputs: Record<string, { label: string; unit: string }>;
  reason: string;
  evidence: string;
}

const SURFACE_AREA_TOOLING_FORMULA = "=[C1]*[Size1]";
const SOURCE_UNIT_IN_FORMULA_COLUMN = "m^2";

const catalogueFormulaCorrections: readonly CatalogueFormulaCorrection[] = [
  "15",
  "16",
  "17",
  "19",
].map((catalogueId) => ({
  id: `26_R1-tooling-${catalogueId}-surface-area-formula`,
  releaseId: CATALOGUE_RELEASE_ID,
  kind: "tooling" as const,
  catalogueId,
  expectedSourceFormula: SOURCE_UNIT_IN_FORMULA_COLUMN,
  effectiveFormula: SURFACE_AREA_TOOLING_FORMULA,
  inputs: {
    size1: { label: "Tool surface area", unit: "m²" },
  },
  reason:
    "The source formula cell repeats the m^2 unit; C1, Size1 Unit, and the row comment define a surface-area tooling cost.",
  evidence:
    "Formula SAE-A Cost Catalogue 2026 v1.0 (26_R1), Tooling IDs 15, 16, 17, and 19.",
}));

export function findCatalogueFormulaCorrection(input: {
  releaseId: string;
  kind: string;
  catalogueId: string;
  sourceFormula: string | null;
}): CatalogueFormulaCorrection | null {
  return (
    catalogueFormulaCorrections.find(
      (correction) =>
        correction.releaseId === input.releaseId &&
        correction.kind === input.kind &&
        correction.catalogueId === input.catalogueId &&
        correction.expectedSourceFormula === input.sourceFormula,
    ) ?? null
  );
}
