import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOGUE_RELEASE_ID,
  installReferenceData,
} from "../../src/services/reference-data-service";
import {
  createAndLogin,
  createHttpTestContext,
  mutation,
  type HttpTestContext,
} from "../helpers/http-app";
import { hasPostgresTestDatabase } from "../helpers/postgres";

describe.skipIf(!hasPostgresTestDatabase())(
  "shared catalogue maintenance",
  () => {
    let context: HttpTestContext;
    let editor: Awaited<ReturnType<typeof createAndLogin>>;
    let viewer: Awaited<ReturnType<typeof createAndLogin>>;

    beforeAll(async () => {
      context = await createHttpTestContext();
      editor = await createAndLogin(context, {
        email: "catalogue-editor@example.test",
        displayName: "Catalogue Editor",
        role: "editor",
      });
      viewer = await createAndLogin(context, {
        email: "catalogue-viewer@example.test",
        displayName: "Catalogue Viewer",
        role: "viewer",
      });
    });

    afterAll(async () => {
      await context.close();
    });

    it("preserves a published team row when startup revalidates official references", async () => {
      const created = await mutation(
        editor.agent.post("/api/catalogue/team"),
        editor.csrfToken,
      )
        .send({
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "material",
          name: "Brake Caliper, Team Billet",
          category: "Brake components",
          supplier: "Team supplier",
          unit: "each",
          unit2: null,
          costMode: "fixed",
          fixedCost: "145.50",
          formula: null,
          coefficients: {},
          size1Label: null,
          size2Label: null,
          size3Label: null,
          size4Label: null,
          reason: "Current team brake caliper option",
          evidence: "Supplier quote BR-2026-04",
        })
        .expect(201);

      expect(created.body.item).toMatchObject({
        kind: "material",
        name: "Brake Caliper, Team Billet",
        origin: "team",
        provenance: "team",
        revision: 0,
        fixedCost: "145.5",
        latestChange: {
          reason: "Current team brake caliper option",
          evidence: "Supplier quote BR-2026-04",
          createdBy: {
            id: editor.user.id,
            displayName: "Catalogue Editor",
          },
        },
      });
      expect(created.body.item.catalogueId).toMatch(/^TEAM-[A-F0-9]{12}$/);

      const restartedReferences = await installReferenceData(context.database);
      expect(restartedReferences).toMatchObject({
        inserted: 0,
        existing: 2073,
        byKind: { material: 1093 },
        invalidFormulaRows: 5,
      });

      const searched = await editor.agent
        .get("/api/catalogue")
        .query({
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "material",
          q: "Team Billet",
        })
        .expect(200);
      expect(searched.body.items).toHaveLength(1);
      expect(searched.body.items[0]).toMatchObject({
        id: created.body.item.id,
        provenance: "team",
        sourceSheet: "Team catalogue",
      });

      const officialCount = await context.database.one<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM catalogue_items WHERE origin = 'official'",
      );
      expect(officialCount.count).toBe(2073);
    });

    it("publishes an effective edit, preserves its official baseline, and rejects a stale revision", async () => {
      const rapidPrototype = await context.database.one<{
        id: string;
        fixed_cost: string;
      }>(
        `
          SELECT id, fixed_cost::text AS fixed_cost
          FROM catalogue_items
          WHERE release_id = $1
            AND kind = 'process'
            AND name = 'Rapid Prototype - Plastic'
        `,
        [CATALOGUE_RELEASE_ID],
      );
      expect(rapidPrototype.fixed_cost).toBe("32");

      const revised = await mutation(
        editor.agent.post(
          `/api/catalogue/${rapidPrototype.id}/revisions`,
        ),
        editor.csrfToken,
      )
        .send({
          expectedRevision: 0,
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "process",
          name: "Rapid Prototype - Plastic",
          category: "Basic Forming",
          supplier: null,
          unit: "kg",
          unit2: null,
          costMode: "fixed",
          fixedCost: "31.50",
          formula: null,
          coefficients: {},
          size1Label: null,
          size2Label: null,
          size3Label: null,
          size4Label: null,
          reason: "Team-verified current process rate",
          evidence: "September process review",
        })
        .expect(201);

      expect(revised.body.item).toMatchObject({
        id: rapidPrototype.id,
        origin: "official",
        provenance: "edited",
        revision: 1,
        fixedCost: "31.5",
        sourceSheet: "Processes",
        sourceRow: 13,
      });

      const baseline = await context.database.one<{ fixed_cost: string }>(
        "SELECT fixed_cost::text AS fixed_cost FROM catalogue_items WHERE id = $1",
        [rapidPrototype.id],
      );
      expect(baseline.fixed_cost).toBe("32");

      await mutation(
        editor.agent.post(
          `/api/catalogue/${rapidPrototype.id}/revisions`,
        ),
        editor.csrfToken,
      )
        .send({
          expectedRevision: 0,
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "process",
          name: "Rapid Prototype - Plastic",
          category: "Basic Forming",
          supplier: null,
          unit: "kg",
          unit2: null,
          costMode: "fixed",
          fixedCost: "31",
          formula: null,
          coefficients: {},
          reason: "Stale competing edit",
          evidence: null,
        })
        .expect(409);

      const audit = await context.database.query<{
        action: string;
        actor_user_id: string;
      }>(
        `
          SELECT action, actor_user_id
          FROM audit_ledger
          WHERE action LIKE 'catalogue-item.%'
          ORDER BY sequence
        `,
      );
      expect(audit.rows).toEqual(
        expect.arrayContaining([
          {
            action: "catalogue-item.team-created",
            actor_user_id: editor.user.id,
          },
          {
            action: "catalogue-item.revised",
            actor_user_id: editor.user.id,
          },
        ]),
      );
    });

    it("keeps viewer accounts read-only", async () => {
      await mutation(
        viewer.agent.post("/api/catalogue/team"),
        viewer.csrfToken,
      )
        .send({
          releaseId: CATALOGUE_RELEASE_ID,
          kind: "material",
          name: "Viewer should not publish",
          unit: "each",
          costMode: "fixed",
          fixedCost: "1",
          reason: "Viewer mutation attempt",
        })
        .expect(403);
    });
  },
);
