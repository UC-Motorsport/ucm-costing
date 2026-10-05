import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseHandle } from "../../src/db/database";
import { seedCoreData } from "../../src/services/reference-data-service";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres";

describe
  .skipIf(!hasPostgresTestDatabase())
  .sequential("PostgreSQL project ownership constraints", () => {
  let postgres: PostgresTestDatabase;
  let database: DatabaseHandle;

  beforeAll(async () => {
    postgres = await createPostgresTestDatabase();
    database = postgres.database;
    await installFixture(database);
  }, 120_000);

  afterAll(async () => {
    await postgres?.close();
  });

  it("installs and validates every direct same-project foreign key", async () => {
    const constraints = await database.query<{
      conname: string;
      convalidated: boolean;
      condeferrable: boolean;
    }>(
      `
        SELECT conname, convalidated, condeferrable
        FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname
      `,
      [DIRECT_PROJECT_CONSTRAINTS],
    );

    expect(constraints.rows.map(({ conname }) => conname)).toEqual(
      [...DIRECT_PROJECT_CONSTRAINTS].sort(),
    );
    expect(
      constraints.rows.every(
        ({ convalidated, condeferrable }) => convalidated && condeferrable,
      ),
    ).toBe(true);
  });

  it("rejects cross-project direct SQL references", async () => {
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cost_nodes(
            id, project_id, parent_id, kind, name,
            procurement_type, quantity
          )
          VALUES (
            'cross-parent', 'project-one', 'vehicle-two',
            'assembly', 'Cross-project parent', 'made', 1
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cost_nodes(
            id, project_id, kind, name, procurement_type, quantity,
            source_import_batch_id
          )
          VALUES (
            'cross-import-node', 'project-one', 'assembly',
            'Cross-project import', 'made', 1, 'batch-two'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO evidence(
            id, node_id, project_id, kind, display_name,
            content_sha256, storage_path, mime_type
          )
          VALUES (
            'cross-evidence', 'vehicle-two', 'project-one', 'drawing',
            'Cross-project evidence', $1, 'uploads/cross-evidence.pdf',
            'application/pdf'
          )
        `,
        ["c".repeat(64)],
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cost_amendments(
            id, project_id, event_reference, status,
            base_report_snapshot_id, created_by, updated_by
          )
          VALUES (
            'cross-amendment', 'project-one', 'cross-report', 'draft',
            'report-two', 'owner-user', 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO artifacts(
            id, project_id, kind, status, report_snapshot_id, created_by
          )
          VALUES (
            'cross-artifact', 'project-one', 'other', 'reserved',
            'report-two', 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO submissions(
            id, project_id, status, report_snapshot_id,
            manifest_json, prepared_by
          )
          VALUES (
            'cross-submission-report', 'project-one', 'prepared',
            'report-two', '{}'::jsonb, 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO submissions(
            id, project_id, status, report_snapshot_id,
            cost_amendment_id, manifest_json, prepared_by
          )
          VALUES (
            'cross-submission-amendment', 'project-one', 'prepared',
            'report-one', 'amendment-two', '{}'::jsonb, 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO submissions(
            id, project_id, status, report_snapshot_id,
            supporting_artifact_id, manifest_json, prepared_by
          )
          VALUES (
            'cross-submission-artifact', 'project-one', 'prepared',
            'report-one', 'support-two', '{}'::jsonb, 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO submission_preparations(
            id, project_id, report_snapshot_id, supporting_artifact_id,
            package_artifact_id, manifest_artifact_id, status, prepared_by
          )
          VALUES (
            'cross-preparation-artifact', 'project-one', 'report-one',
            'support-two', 'package-one', 'manifest-one',
            'reserved', 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO submission_preparations(
            id, project_id, report_snapshot_id, supporting_artifact_id,
            package_artifact_id, manifest_artifact_id, status, prepared_by
          )
          VALUES (
            'cross-preparation-report', 'project-one', 'report-two',
            'support-one', 'package-one', 'manifest-one',
            'reserved', 'owner-user'
          )
        `,
      ),
    );
  });

  it("rejects indirect cross-project references through constraint triggers", async () => {
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO import_rows(
            id, batch_id, row_number, raw_json, node_id
          )
          VALUES (
            'cross-import-row', 'batch-one', 1, '{}'::jsonb, 'vehicle-two'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cair_requests(
            id, project_id, cost_line_id, status,
            requested_catalogue_description, rationale,
            created_by, updated_by
          )
          VALUES (
            'cross-cair-line', 'project-one', 'line-two', 'draft',
            'Cross-project line', 'Must be rejected',
            'owner-user', 'owner-user'
          )
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cair_evidence(
            cair_id, evidence_id, attached_by
          )
          VALUES ('cair-one', 'evidence-two', 'owner-user')
        `,
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `
          INSERT INTO cost_amendment_items(
            id, amendment_id, action, node_id, description,
            cost_box, classification, quantity,
            original_quantity, revised_quantity, unit_cost, subtotal
          )
          VALUES (
            'cross-amendment-item', 'amendment-one', 'add', 'vehicle-two',
            'Cross-project node', 'material', 'new', 1, 0, 1, 1, 1
          )
        `,
      ),
    );
  });

  it("preserves nullable links and node cascade/set-null behavior", async () => {
    await database.query(
      `
        INSERT INTO cost_nodes(
          id, project_id, parent_id, kind, name,
          procurement_type, quantity
        )
        VALUES
          (
            'cascade-parent', 'project-one', 'vehicle-one',
            'assembly', 'Cascade parent', 'made', 1
          ),
          (
            'cascade-child', 'project-one', 'cascade-parent',
            'subassembly', 'Cascade child', 'made', 1
          ),
          (
            'set-null-node', 'project-one', 'vehicle-one',
            'assembly', 'Set null node', 'made', 1
          )
      `,
    );
    await database.query(
      `
        INSERT INTO evidence(
          id, node_id, project_id, kind, display_name,
          content_sha256, storage_path, mime_type
        )
        VALUES
          (
            'cascade-evidence', 'cascade-child', 'project-one', 'drawing',
            'Cascade evidence', $1, 'uploads/cascade-evidence.pdf',
            'application/pdf'
          ),
          (
            'project-evidence', NULL, 'project-one', 'other',
            'Project-level evidence', $2, 'uploads/project-evidence.txt',
            'text/plain'
          )
      `,
      ["d".repeat(64), "e".repeat(64)],
    );
    await database.query(
      `
        INSERT INTO import_rows(
          id, batch_id, row_number, raw_json, node_id
        )
        VALUES (
          'nullable-import-row', 'batch-one', 2, '{}'::jsonb,
          'set-null-node'
        )
      `,
    );
    await database.query(
      `
        INSERT INTO cost_amendment_items(
          id, amendment_id, action, node_id, description,
          cost_box, classification, quantity,
          original_quantity, revised_quantity, unit_cost, subtotal
        )
        VALUES (
          'nullable-amendment-item', 'amendment-one', 'add', 'set-null-node',
          'Set-null amendment node', 'material', 'new', 1, 0, 1, 1, 1
        )
      `,
    );

    await database.query(
      "DELETE FROM cost_nodes WHERE id = 'cascade-parent'",
    );
    const cascadeCounts = await database.one<{
      nodes: number;
      evidence: number;
    }>(
      `
        SELECT
          (
            SELECT count(*)::integer
            FROM cost_nodes
            WHERE id IN ('cascade-parent', 'cascade-child')
          ) AS nodes,
          (
            SELECT count(*)::integer
            FROM evidence
            WHERE id = 'cascade-evidence'
          ) AS evidence
      `,
    );
    expect(cascadeCounts).toEqual({ nodes: 0, evidence: 0 });

    await database.query(
      "DELETE FROM cost_nodes WHERE id = 'set-null-node'",
    );
    const nullable = await database.one<{
      import_node_id: string | null;
      amendment_node_id: string | null;
      project_evidence_node_id: string | null;
    }>(
      `
        SELECT
          (
            SELECT node_id
            FROM import_rows
            WHERE id = 'nullable-import-row'
          ) AS import_node_id,
          (
            SELECT node_id
            FROM cost_amendment_items
            WHERE id = 'nullable-amendment-item'
          ) AS amendment_node_id,
          (
            SELECT node_id
            FROM evidence
            WHERE id = 'project-evidence'
          ) AS project_evidence_node_id
      `,
    );
    expect(nullable).toEqual({
      import_node_id: null,
      amendment_node_id: null,
      project_evidence_node_id: null,
    });
  });
});

const DIRECT_PROJECT_CONSTRAINTS = [
  "cost_nodes_parent_project_fkey",
  "cost_nodes_import_batch_project_fkey",
  "evidence_node_project_fkey",
  "cost_amendments_report_project_fkey",
  "artifacts_report_project_fkey",
  "submissions_report_project_fkey",
  "submissions_amendment_project_fkey",
  "submissions_supporting_artifact_project_fkey",
  "submissions_amendment_artifact_project_fkey",
  "submissions_manifest_artifact_project_fkey",
  "submissions_package_artifact_project_fkey",
  "submission_preparations_report_project_fkey",
  "submission_preparations_supporting_artifact_project_fkey",
  "submission_preparations_package_artifact_project_fkey",
  "submission_preparations_manifest_artifact_project_fkey",
  "submission_preparations_completed_submission_project_fkey",
] as const;

async function expectForeignKeyViolation(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: "23503" });
}

async function installFixture(database: DatabaseHandle): Promise<void> {
  await seedCoreData(database);
  await database.query(
    `
      INSERT INTO users(
        id, email, display_name, role, status
      )
      VALUES (
        'owner-user', 'owner@example.test', 'Owner',
        'admin', 'active'
      );

      INSERT INTO projects(
        id, name, season, vehicle_type, entry_number, status,
        rule_pack_version, rule_pack_sha256, rule_source_document_id,
        catalogue_release_id, created_by, updated_by
      )
      SELECT
        project.id,
        project.name,
        project.season,
        'electric',
        project.entry_number,
        'draft',
        'test-rule',
        repeat('1', 64),
        (
          SELECT id
          FROM source_documents
          WHERE kind = 'governing-rule'
          ORDER BY retrieved_at DESC
          LIMIT 1
        ),
        release.id,
        'owner-user',
        'owner-user'
      FROM catalogue_releases release
      CROSS JOIN (
        VALUES
          ('project-one', 'Project One', 'E01', 2026),
          ('project-two', 'Project Two', 'E02', 2025)
      ) AS project(id, name, entry_number, season)
      LIMIT 2;

      INSERT INTO import_batches(
        id, project_id, template, source_name, source_sha256,
        source_encoding, status, preview_json, created_by
      )
      VALUES
        (
          'batch-one', 'project-one', 'test', 'one.csv', repeat('2', 64),
          'utf-8', 'preview', '{}'::jsonb, 'owner-user'
        ),
        (
          'batch-two', 'project-two', 'test', 'two.csv', repeat('3', 64),
          'utf-8', 'preview', '{}'::jsonb, 'owner-user'
        );

      INSERT INTO cost_nodes(
        id, project_id, kind, name, procurement_type, quantity
      )
      VALUES
        ('vehicle-one', 'project-one', 'vehicle', 'Vehicle One', 'made', 1),
        ('vehicle-two', 'project-two', 'vehicle', 'Vehicle Two', 'made', 1);

      INSERT INTO cost_lines(
        id, node_id, kind, description, unit_cost, quantity,
        multiplier, fraction_included, calculation_json, subtotal
      )
      VALUES
        (
          'line-one', 'vehicle-one', 'material', 'Line One',
          1, 1, 1, 1, '{}'::jsonb, 1
        ),
        (
          'line-two', 'vehicle-two', 'material', 'Line Two',
          1, 1, 1, 1, '{}'::jsonb, 1
        );

      INSERT INTO evidence(
        id, node_id, project_id, kind, display_name,
        content_sha256, storage_path, mime_type
      )
      VALUES
        (
          'evidence-one', 'vehicle-one', 'project-one', 'drawing',
          'Evidence One', repeat('4', 64),
          'uploads/evidence-one.pdf', 'application/pdf'
        ),
        (
          'evidence-two', 'vehicle-two', 'project-two', 'drawing',
          'Evidence Two', repeat('5', 64),
          'uploads/evidence-two.pdf', 'application/pdf'
        );

      INSERT INTO cair_requests(
        id, project_id, cost_line_id, status,
        requested_catalogue_description, rationale,
        created_by, updated_by
      )
      VALUES (
        'cair-one', 'project-one', 'line-one', 'draft',
        'Fixture request', 'Fixture rationale', 'owner-user', 'owner-user'
      );

      INSERT INTO report_snapshots(
        id, project_id, mode, status, snapshot_json, validation_json,
        source_hashes_json, created_by
      )
      VALUES
        (
          'report-one', 'project-one', 'draft', 'complete',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'owner-user'
        ),
        (
          'report-two', 'project-two', 'draft', 'complete',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'owner-user'
        );

      INSERT INTO cost_amendments(
        id, project_id, event_reference, status,
        base_report_snapshot_id, created_by, updated_by
      )
      VALUES
        (
          'amendment-one', 'project-one', 'event-one', 'draft',
          'report-one', 'owner-user', 'owner-user'
        ),
        (
          'amendment-two', 'project-two', 'event-two', 'draft',
          'report-two', 'owner-user', 'owner-user'
        );

      INSERT INTO artifacts(
        id, project_id, kind, status, report_snapshot_id, created_by
      )
      VALUES
        (
          'support-one', 'project-one', 'supporting-workbook',
          'reserved', 'report-one', 'owner-user'
        ),
        (
          'package-one', 'project-one', 'submission-package',
          'reserved', 'report-one', 'owner-user'
        ),
        (
          'manifest-one', 'project-one', 'submission-manifest',
          'reserved', 'report-one', 'owner-user'
        ),
        (
          'support-two', 'project-two', 'supporting-workbook',
          'reserved', 'report-two', 'owner-user'
        );
    `,
  );
}
