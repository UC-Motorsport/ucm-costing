import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres";
import {
  getCatalogueItem,
  importCatalogueRelease,
  resolveCatalogueUnitCost,
} from "../../src/services/catalogue-service";
import {
  CATALOGUE_RELEASE_ID,
  seedCoreData,
} from "../../src/services/reference-data-service";

const databases: PostgresTestDatabase[] = [];
const cataloguePath = path.resolve(
  import.meta.dirname,
  "../../../../docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx",
);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe.skipIf(!hasPostgresTestDatabase())(
  "PostgreSQL catalogue release import",
  () => {
    it("imports all nonblank 26_R1 rows idempotently with source anomalies visible", async () => {
      const testDatabase = await createPostgresTestDatabase();
      databases.push(testDatabase);

      const first = await seedCoreData(testDatabase.database);
      expect(first).toEqual({
        releaseId: CATALOGUE_RELEASE_ID,
        inserted: 2073,
        existing: 0,
        invalidFormulaRows: 5,
        byKind: {
          material: 1093,
          process: 168,
          multiplier: 51,
          fastener: 96,
          tooling: 21,
          "stock-size": 644,
        },
      });

      const second = await importCatalogueRelease(
        testDatabase.database,
        CATALOGUE_RELEASE_ID,
        cataloguePath,
      );
      expect(second).toMatchObject({ inserted: 0, existing: 2073 });

      const invalid = await testDatabase.database.query<{
        kind: string;
        catalogue_id: string;
        name: string;
        error: string;
      }>(
        `
          SELECT kind, catalogue_id, name,
                 metadata_json #>> '{formulaValidation,error}' AS error
          FROM catalogue_items
          WHERE metadata_json #>> '{formulaValidation,ok}' = 'false'
          ORDER BY kind, catalogue_id::integer
        `,
      );
      expect(invalid.rows).toHaveLength(5);
      expect(invalid.rows[0]).toMatchObject({
        kind: "fastener",
        catalogue_id: "76",
        error: "Unexpected token rightParen",
      });
      expect(
        invalid.rows.slice(1).map(({ catalogue_id: id }) => id),
      ).toEqual(["15", "16", "17", "19"]);

      const tooling = await testDatabase.database.one<{ id: string }>(
        `
          SELECT id
          FROM catalogue_items
          WHERE release_id = $1 AND kind = 'tooling' AND catalogue_id = '19'
        `,
        [CATALOGUE_RELEASE_ID],
      );
      expect(
        await getCatalogueItem(
          testDatabase.database,
          CATALOGUE_RELEASE_ID,
          tooling.id,
        ),
      ).toMatchObject({
        catalogueId: "19",
        unit: "m^2",
        rawFormula: "m^2",
        sourceFormula: "m^2",
        effectiveFormula: "=[C1]*[Size1]",
        formulaCorrection: {
          sourceFormula: "m^2",
          effectiveFormula: "=[C1]*[Size1]",
          inputs: {
            size1: { label: "Tool surface area", unit: "m²" },
          },
        },
        effectiveFormulaValidation: { ok: true },
        metadata: { formulaValidation: { ok: false } },
      });

      const stockSize = await testDatabase.database.one<{ id: string }>(
        `
          SELECT id
          FROM catalogue_items
          WHERE release_id = $1
            AND kind = 'stock-size'
            AND catalogue_id = '234'
        `,
        [CATALOGUE_RELEASE_ID],
      );
      expect(
        await getCatalogueItem(
          testDatabase.database,
          CATALOGUE_RELEASE_ID,
          stockSize.id,
        ),
      ).toMatchObject({
        catalogueId: "234",
        unit: "mm",
        unit2: "mm",
      });

      await expect(
        resolveCatalogueUnitCost(
          testDatabase.database,
          CATALOGUE_RELEASE_ID,
          {
            kind: "tooling",
            catalogueItemId: tooling.id,
            sizeInputs: { size1: "3.42" },
          },
        ),
      ).resolves.toBe("68400");
    });
  },
);
