import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CATALOGUE_REVISION,
  CATALOGUE_SHA256,
  LOCAL_ADDENDUM_SHA256,
  LOCAL_ADDENDUM_V12_SHA256,
  getAppPaths,
} from "../config";
import type { DatabaseHandle } from "../db/database";
import {
  importCatalogueRelease,
  type CatalogueImportStats,
} from "./catalogue-service";
import {
  CATALOGUE_RELEASE_ID,
  OFFICIAL_CATALOGUE_DOCUMENT_ID,
  OFFICIAL_RULE_DOCUMENT_ID,
  OFFICIAL_RULE_DOCUMENT_V12_ID,
  stableSeedUuid,
} from "./reference-data-identifiers";

export {
  CATALOGUE_RELEASE_ID,
  OFFICIAL_CATALOGUE_DOCUMENT_ID,
  OFFICIAL_RULE_DOCUMENT_ID,
  OFFICIAL_RULE_DOCUMENT_V12_ID,
  stableSeedUuid,
} from "./reference-data-identifiers";

const EXPECTED_CATALOGUE_COUNTS: CatalogueImportStats["byKind"] = {
  material: 1093,
  process: 168,
  multiplier: 51,
  fastener: 96,
  tooling: 21,
  "stock-size": 644,
};
const EXPECTED_INVALID_FORMULA_ROWS = 5;
const REFERENCE_INSTALL_LOCK = "ucm:reference-data:26_R1";

interface SourceDocumentSeed {
  id: string;
  kind: string;
  title: string;
  version: string;
  originalUrl: string;
  localPath: string;
  sha256: string;
  applicability: string;
  retrievedAt: string;
}

const sourceDocuments: readonly SourceDocumentSeed[] = [
  {
    id: OFFICIAL_RULE_DOCUMENT_V12_ID,
    kind: "governing-rule",
    title: "Formula SAE-A 2026 Local Addendum",
    version: "v1.2",
    originalUrl: "https://www.sme-a.org/client_images/5276665.pdf",
    localPath: "docs/Local Addendum 2026 Version 1.2 (1).pdf",
    sha256: LOCAL_ADDENDUM_V12_SHA256,
    applicability:
      "Governing Appendix PDA-2 replaces the complete base S.3 cost rules.",
    retrievedAt: "2026-07-29T00:00:00.000Z",
  },
  {
    id: OFFICIAL_RULE_DOCUMENT_ID,
    kind: "governing-rule",
    title: "Formula SAE-A 2026 Local Addendum",
    version: "v1.4",
    originalUrl: "https://www.sme-a.org/client_images/5832409.pdf",
    localPath:
      "docs/references/official/FSAE-A_2026_Local_Addendum_v1.4.pdf",
    sha256: LOCAL_ADDENDUM_SHA256,
    applicability:
      "Current governing Appendix PDA-2 replaces the complete base S.3 cost rules.",
    retrievedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: OFFICIAL_CATALOGUE_DOCUMENT_ID,
    kind: "governing-catalogue",
    title: "FSAE-A Cost Catalogue 2026",
    version: CATALOGUE_REVISION,
    originalUrl: "https://www.sme-a.org/client_images/5102753.xlsx",
    localPath:
      "docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx",
    sha256: CATALOGUE_SHA256,
    applicability:
      "Canonical source for competition universal-dollar cost inputs.",
    retrievedAt: "2026-07-29T00:00:00.000Z",
  },
];

/**
 * Installs immutable, checksum-verified governing references. It deliberately does
 * not create a project or any demonstration costing records.
 */
export async function installReferenceData(
  database: DatabaseHandle,
): Promise<CatalogueImportStats> {
  const paths = getAppPaths();
  const verifiedFiles = await Promise.all(
    sourceDocuments.map(async (source) => {
      const absolutePath = path.join(paths.repositoryRoot, source.localPath);
      const bytes = await readFile(absolutePath);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== source.sha256) {
        throw new Error(
          `reference-source-sha256-mismatch:${source.id}:${actualSha256}`,
        );
      }
      return { source, absolutePath };
    }),
  );

  await database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [REFERENCE_INSTALL_LOCK],
    );
    for (const { source } of verifiedFiles) {
      const existing = await transaction.maybeOne<{
        kind: string;
        title: string;
        version: string;
        original_url: string;
        local_path: string;
        sha256: string;
        applicability: string;
        retrieved_at: string;
      }>(
        `
          SELECT kind, title, version, original_url, local_path, sha256,
                 applicability, retrieved_at
          FROM source_documents
          WHERE id = $1
        `,
        [source.id],
      );
      if (existing) {
        assertSourceDocumentMatches(source, existing);
        continue;
      }
      await transaction.query(
        `
          INSERT INTO source_documents(
            id, kind, title, version, original_url, local_path, sha256,
            applicability, retrieved_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          source.id,
          source.kind,
          source.title,
          source.version,
          source.originalUrl,
          source.localPath,
          source.sha256,
          source.applicability,
          source.retrievedAt,
        ],
      );
    }

    const existingRelease = await transaction.maybeOne<{
      competition_year: number;
      revision_code: string;
      source_document_id: string;
    }>(
      `
        SELECT competition_year, revision_code, source_document_id
        FROM catalogue_releases
        WHERE id = $1
      `,
      [CATALOGUE_RELEASE_ID],
    );
    if (existingRelease) {
      if (
        existingRelease.competition_year !== 2026 ||
        existingRelease.revision_code !== CATALOGUE_REVISION ||
        existingRelease.source_document_id !==
          OFFICIAL_CATALOGUE_DOCUMENT_ID
      ) {
        throw new Error("reference-catalogue-release-mismatch");
      }
      return;
    }

    await transaction.query(
      `
        INSERT INTO catalogue_releases(
          id, competition_year, revision_code, released_on,
          source_document_id
        )
        VALUES ($1, 2026, $2, DATE '2026-05-04', $3)
      `,
      [
        CATALOGUE_RELEASE_ID,
        CATALOGUE_REVISION,
        OFFICIAL_CATALOGUE_DOCUMENT_ID,
      ],
    );
  });

  const cataloguePath = verifiedFiles.find(
    ({ source }) => source.id === OFFICIAL_CATALOGUE_DOCUMENT_ID,
  )?.absolutePath;
  if (!cataloguePath) {
    throw new Error("reference-catalogue-file-missing");
  }
  const imported = await importCatalogueRelease(
    database,
    CATALOGUE_RELEASE_ID,
    cataloguePath,
  );
  assertCatalogueProfile(imported.byKind, imported.invalidFormulaRows);

  // Team entries share the release but are not part of its official profile.
  const persistedRows = await database.query<{
    kind: keyof CatalogueImportStats["byKind"];
    count: number;
  }>(
    `
      SELECT kind, COUNT(*)::integer AS count
      FROM catalogue_items
      WHERE release_id = $1
        AND origin = 'official'
      GROUP BY kind
    `,
    [CATALOGUE_RELEASE_ID],
  );
  const persistedCounts = emptyCatalogueCounts();
  for (const row of persistedRows.rows) {
    if (!(row.kind in persistedCounts)) {
      throw new Error(`reference-catalogue-unknown-kind:${row.kind}`);
    }
    persistedCounts[row.kind] = row.count;
  }
  const invalidFormulaRows = await database.one<{ count: number }>(
    `
      SELECT COUNT(*)::integer AS count
      FROM catalogue_items
      WHERE release_id = $1
        AND origin = 'official'
        AND metadata_json #>> '{formulaValidation,ok}' = 'false'
    `,
    [CATALOGUE_RELEASE_ID],
  );
  assertCatalogueProfile(persistedCounts, invalidFormulaRows.count);

  return {
    ...imported,
    existing:
      Object.values(persistedCounts).reduce((sum, count) => sum + count, 0) -
      imported.inserted,
    invalidFormulaRows: invalidFormulaRows.count,
    byKind: persistedCounts,
  };
}

/** Compatibility name for callers that install governing references. */
export const seedApplicationData = installReferenceData;

/** Compatibility name for callers that install governing references. */
export const seedCoreData = installReferenceData;

function assertSourceDocumentMatches(
  expected: SourceDocumentSeed,
  actual: {
    kind: string;
    title: string;
    version: string;
    original_url: string;
    local_path: string;
    sha256: string;
    applicability: string;
    retrieved_at: string;
  },
): void {
  const mismatch =
    actual.kind !== expected.kind ||
    actual.title !== expected.title ||
    actual.version !== expected.version ||
    actual.original_url !== expected.originalUrl ||
    actual.local_path !== expected.localPath ||
    actual.sha256 !== expected.sha256 ||
    actual.applicability !== expected.applicability ||
    actual.retrieved_at !== expected.retrievedAt;
  if (mismatch) {
    throw new Error(`reference-source-record-mismatch:${expected.id}`);
  }
}

function emptyCatalogueCounts(): CatalogueImportStats["byKind"] {
  return {
    material: 0,
    process: 0,
    multiplier: 0,
    fastener: 0,
    tooling: 0,
    "stock-size": 0,
  };
}

function assertCatalogueProfile(
  counts: CatalogueImportStats["byKind"],
  invalidFormulaRows: number,
): void {
  for (const kind of Object.keys(
    EXPECTED_CATALOGUE_COUNTS,
  ) as Array<keyof CatalogueImportStats["byKind"]>) {
    if (counts[kind] !== EXPECTED_CATALOGUE_COUNTS[kind]) {
      throw new Error(
        `reference-catalogue-count-mismatch:${kind}:${counts[kind]}`,
      );
    }
  }
  if (invalidFormulaRows !== EXPECTED_INVALID_FORMULA_ROWS) {
    throw new Error(
      `reference-catalogue-formula-anomaly-mismatch:${invalidFormulaRows}`,
    );
  }
}
