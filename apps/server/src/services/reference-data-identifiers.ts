import { createHash } from "node:crypto";

export function stableSeedUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const OFFICIAL_RULE_DOCUMENT_V12_ID = stableSeedUuid(
  "source:FSAE-A-2026-local-addendum-v1.2",
);
export const OFFICIAL_RULE_DOCUMENT_V14_ID = stableSeedUuid(
  "source:FSAE-A-2026-local-addendum-v1.4",
);
export const OFFICIAL_RULE_DOCUMENT_ID = OFFICIAL_RULE_DOCUMENT_V14_ID;
export const OFFICIAL_CATALOGUE_DOCUMENT_ID = stableSeedUuid(
  "source:FSAE-A-cost-catalogue-26_R1",
);
export const CATALOGUE_RELEASE_ID = stableSeedUuid(
  "catalogue:2026:26_R1",
);
