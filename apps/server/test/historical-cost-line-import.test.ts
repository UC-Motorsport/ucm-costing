import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAdministrator } from "../src/security/auth-service";
import type { ActorContext } from "../src/security/authorization";
import {
  importHistoricalCostLine,
  importHistoricalCostLines,
  searchHistoricalCostSources,
  listHistoricalSourceCosts,
  searchHistoricalCostLines,
} from "../src/services/historical-cost-line-service";
import { installReferenceData } from "../src/services/reference-data-service";
import {
  createSeasonWorkspaceRecord,
  ensureTeamWorkspace,
} from "../src/services/workspace-service";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "./helpers/postgres";

describe.skipIf(!hasPostgresTestDatabase())(
  "2025 cost-row search and import",
  () => {
    let postgres: PostgresTestDatabase;
    let actor: ActorContext;
    let currentProjectId: string;
    let historicalProjectId: string;
    let targetPartId: string;
    let sourceLineId: string;

    beforeAll(async () => {
      postgres = await createPostgresTestDatabase();
      await installReferenceData(postgres.database);
      const administrator = await bootstrapAdministrator(postgres.database, {
        email: "historical-row-admin@example.test",
        displayName: "Historical Row Administrator",
      });
      actor = {
        actorUserId: administrator.id,
        systemRole: "admin",
        requestId: "historical-cost-row-test",
        userAgent: null,
        ipAddressHash: null,
      };
      currentProjectId = (await ensureTeamWorkspace(postgres.database)).id;
      historicalProjectId = await postgres.database.transaction((transaction) =>
        createSeasonWorkspaceRecord(transaction, {
          id: randomUUID(),
          name: "UC Motorsport 2025 history",
          season: 2025,
          vehicleType: "electric",
          entryNumber: "E13",
          isHistorical: true,
          createdBy: administrator.id,
        }),
      );

      const currentSystem = await postgres.database.one<{ id: string }>(
        "SELECT id FROM cost_nodes WHERE project_id = $1 AND kind = 'system' AND system_code = 'DR'",
        [currentProjectId],
      );
      const historicalSystem = await postgres.database.one<{ id: string }>(
        "SELECT id FROM cost_nodes WHERE project_id = $1 AND kind = 'system' AND system_code = 'DR'",
        [historicalProjectId],
      );
      const targetAssemblyId = randomUUID();
      const sourceAssemblyId = randomUUID();
      targetPartId = randomUUID();
      const sourcePartId = randomUUID();
      const merelySimilarPartId = randomUUID();
      sourceLineId = randomUUID();

      await postgres.database.query(
        `
          INSERT INTO cost_nodes(
            id, project_id, parent_id, kind, system_code, reference_id,
            full_number, name, description, procurement_type, quantity,
            internal_note, sort_order
          )
          VALUES
            ($1, $2, $3, 'assembly', 'DR', '030000',
             'E13-26-DR-030000-A', 'Current brakes', '', 'made', 1, '', 0),
            ($4, $2, $1, 'part', 'DR', '030001',
             'E13-26-DR-030001-A', 'Front Caliper', '', 'bought', 1, '', 0),
            ($5, $6, $7, 'assembly', 'DR', '030000',
             'E13-25-DR-030000-A', 'Historical brakes', '', 'made', 1, '', 0),
            ($8, $6, $5, 'part', 'DR', '030001',
             'E13-25-DR-030001-A', 'Front Caliper', '', 'bought', 1, '', 0),
            ($9, $6, $5, 'part', 'DR', '030002',
             'E13-25-DR-030002-A', 'Front Caliper Prototype', '', 'bought', 1, '', 1)
        `,
        [
          targetAssemblyId,
          currentProjectId,
          currentSystem.id,
          targetPartId,
          sourceAssemblyId,
          historicalProjectId,
          historicalSystem.id,
          sourcePartId,
          merelySimilarPartId,
        ],
      );
      await postgres.database.query(
        `
          INSERT INTO cost_lines(
            id, node_id, kind, catalogue_item_id, description,
            use_description, unit_cost, quantity, multiplier,
            fraction_included, size_inputs_json, calculation_json,
            subtotal, sort_order
          )
          VALUES
            ($1, $2, 'material', NULL, 'Brake Caliper, ISR, 22-048',
             'Front braking assembly', 96, 1, 1, 1,
             '{}'::jsonb, '{}'::jsonb, 96, 0),
            ($3, $4, 'material', NULL, 'Prototype caliper stock',
             '', 12, 1, 1, 1, '{}'::jsonb, '{}'::jsonb, 12, 0)
        `,
        [sourceLineId, sourcePartId, randomUUID(), merelySimilarPartId],
      );
    });

    afterAll(async () => {
      await postgres.close();
    });

    it("suggests only the exact season-remapped controlled number", async () => {
      const result = await searchHistoricalCostLines(
        postgres.database,
        actor,
        targetPartId,
        "",
        40,
      );

      expect(result.matchReason).toBe("controlled-number");
      expect(result.suggested).toHaveLength(1);
      expect(result.suggested[0]).toMatchObject({
        id: sourceLineId,
        sourceNodeName: "Front Caliper",
        sourceNodeNumber: "E13-25-DR-030001-A",
      });
      expect(result.suggested).not.toContainEqual(
        expect.objectContaining({ sourceNodeName: "Front Caliper Prototype" }),
      );
    });

    it("searches all 2025 rows by words even when source punctuation differs", async () => {
      const result = await searchHistoricalCostLines(
        postgres.database,
        actor,
        targetPartId,
        "ISR 22-048",
        40,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.sourceNodeName).toBe("Front Caliper");
    });

    it("preserves recorded historical mass and units during import", async () => {
      await postgres.database.query("UPDATE cost_lines SET size_inputs_json = $1::jsonb WHERE id = $2", [JSON.stringify({ size1: "0.42", size1Unit: "kg" }), sourceLineId]);
      const source = await postgres.database.one<{ node_id: string }>("SELECT node_id FROM cost_lines WHERE id = $1", [sourceLineId]);
      const preview = await listHistoricalSourceCosts(postgres.database, actor, targetPartId, source.node_id);
      expect(preview.items.find((item) => item.id === sourceLineId)?.sizeInputs).toEqual({ size1: "0.42", size1Unit: "kg" });
      const result = await importHistoricalCostLine(postgres.database, actor, targetPartId, sourceLineId);
      expect(JSON.parse(result.line.size_inputs_json)).toEqual({ size1: "0.42", size1Unit: "kg" });
      await postgres.database.query("UPDATE cost_lines SET size_inputs_json = '{}'::jsonb WHERE id = $1", [sourceLineId]);
    });

    it("imports exactly one selected row and records its historical source", async () => {
      const result = await importHistoricalCostLine(
        postgres.database,
        actor,
        targetPartId,
        sourceLineId,
      );

      expect(result.line).toMatchObject({
        node_id: targetPartId,
        kind: "material",
        catalogue_item_id: null,
        description: "Brake Caliper, ISR, 22-048",
        unit_cost: "96",
        quantity: "1",
        multiplier: "1",
        subtotal: "96",
      });
      expect(result.warnings).toEqual([
        "The 2025 row was not linked to a catalogue item.",
      ]);
      const audit = await postgres.database.one<{
        action: string;
        metadata_json: {
          sourceLineId: string;
          sourceProjectId: string;
          sourceSeason: number;
        };
      }>(
        "SELECT action, metadata_json FROM audit_ledger WHERE entity_id = $1",
        [result.line.id],
      );
      expect(audit).toMatchObject({
        action: "cost-line.imported",
        metadata_json: {
          sourceLineId,
          sourceProjectId: historicalProjectId,
          sourceSeason: 2025,
        },
      });
    });

    it("finds assemblies and returns every descendant row", async () => {
      const search = await searchHistoricalCostSources(
        postgres.database,
        actor,
        targetPartId,
        "Historical brakes",
      );
      expect(search.items).toHaveLength(1);
      expect(search.items[0]?.rowCount).toBe(2);
      const costs = await listHistoricalSourceCosts(
        postgres.database,
        actor,
        targetPartId,
        search.items[0]!.id,
      );
      expect(costs.items).toHaveLength(2);
      expect(costs.items.map((row) => row.sourceNodeName)).toEqual([
        "Front Caliper",
        "Front Caliper Prototype",
      ]);
      const result = await importHistoricalCostLines(
        postgres.database,
        actor,
        targetPartId,
        search.items[0]!.id,
        costs.items.map((row) => row.id),
      );
      expect(result.results).toHaveLength(2);
      expect(result.results.map((row) => row.line.subtotal).sort()).toEqual([
        "12",
        "96",
      ]);
      const audits = await postgres.database.query(
        "SELECT entity_id FROM audit_ledger WHERE action = 'cost-line.imported' AND entity_id = ANY($1::text[])",
        [result.results.map((row) => row.line.id)],
      );
      expect(audits.rows).toHaveLength(2);
    });

    it("rejects foreign and duplicate selections without inserting rows", async () => {
      const source = await searchHistoricalCostSources(
        postgres.database,
        actor,
        targetPartId,
        "Prototype",
      );
      const count = async () =>
        (
          await postgres.database.one<{ count: number }>(
            "SELECT count(*)::int AS count FROM cost_lines WHERE node_id = $1",
            [targetPartId],
          )
        ).count;
      const before = await count();
      await expect(
        importHistoricalCostLines(
          postgres.database,
          actor,
          targetPartId,
          source.items[0]!.id,
          [sourceLineId],
        ),
      ).rejects.toThrow("historical-cost-selection-invalid");
      await expect(
        importHistoricalCostLines(
          postgres.database,
          actor,
          targetPartId,
          source.items[0]!.id,
          [sourceLineId, sourceLineId],
        ),
      ).rejects.toThrow("historical-cost-selection-invalid");
      expect(await count()).toBe(before);
    });

    it("rolls back the entire batch when a later insert fails", async () => {
      const source = await searchHistoricalCostSources(
        postgres.database,
        actor,
        targetPartId,
        "Historical brakes",
      );
      const costs = await listHistoricalSourceCosts(
        postgres.database,
        actor,
        targetPartId,
        source.items[0]!.id,
      );
      const before = await postgres.database.one<{ count: number }>(
        "SELECT count(*)::int AS count FROM cost_lines WHERE node_id = $1",
        [targetPartId],
      );
      await postgres.database
        .query(`CREATE FUNCTION reject_second_import() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT count(*) FROM cost_lines WHERE node_id = NEW.node_id) > ${before.count} THEN
            RAISE EXCEPTION 'simulated-import-failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_second_import BEFORE INSERT ON cost_lines FOR EACH ROW EXECUTE FUNCTION reject_second_import();`);
      try {
        await expect(
          importHistoricalCostLines(
            postgres.database,
            actor,
            targetPartId,
            source.items[0]!.id,
            costs.items.map((row) => row.id),
          ),
        ).rejects.toThrow("simulated-import-failure");
        expect(
          await postgres.database.one(
            "SELECT count(*)::int AS count FROM cost_lines WHERE node_id = $1",
            [targetPartId],
          ),
        ).toEqual(before);
      } finally {
        await postgres.database.query(
          "DROP TRIGGER reject_second_import ON cost_lines; DROP FUNCTION reject_second_import()",
        );
      }
    });

    it("returns complete source costs beyond the old search limit and forbids viewer imports", async () => {
      const source = await searchHistoricalCostSources(
        postgres.database,
        actor,
        targetPartId,
        "Prototype",
      );
      const sourceId = source.items[0]!.id;
      const inserted = await postgres.database.query<{ id: string }>(
        `INSERT INTO cost_lines(id,node_id,kind,description,use_description,unit_cost,quantity,multiplier,fraction_included,size_inputs_json,calculation_json,subtotal,sort_order)
        SELECT 'bulk-test-' || n, $1, 'fastener', 'Additional bolt ' || n, '', 1, 1, 1, 1, '{}', '{}', 1, n FROM generate_series(1,105) n RETURNING id`,
        [sourceId],
      );
      try {
        const costs = await listHistoricalSourceCosts(
          postgres.database,
          actor,
          targetPartId,
          sourceId,
        );
        expect(costs.items).toHaveLength(106);
        await expect(
          importHistoricalCostLines(
            postgres.database,
            { ...actor, systemRole: "viewer" },
            targetPartId,
            sourceId,
            [costs.items[0]!.id],
          ),
        ).rejects.toThrow("permission-denied");
      } finally {
        await postgres.database.query(
          "DELETE FROM cost_lines WHERE id = ANY($1::text[])",
          [inserted.rows.map((row) => row.id)],
        );
      }
    });

    it("rejects a current-season row as an import source", async () => {
      const currentLineId = randomUUID();
      await postgres.database.query(
        `
          INSERT INTO cost_lines(
            id, node_id, kind, description, use_description, unit_cost,
            quantity, multiplier, fraction_included, size_inputs_json,
            calculation_json, subtotal, sort_order
          )
          VALUES ($1, $2, 'material', 'Current row', '', 1, 1, 1, 1,
                  '{}'::jsonb, '{}'::jsonb, 1, 1)
        `,
        [currentLineId, targetPartId],
      );

      await expect(
        importHistoricalCostLine(
          postgres.database,
          actor,
          targetPartId,
          currentLineId,
        ),
      ).rejects.toThrow("historical-cost-line-source-not-allowed");
    });
  },
);
