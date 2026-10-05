import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AuditLedgerRow } from "../src/audit/audit-ledger";
import { verifyAuditLedgerRows } from "../src/audit/audit-ledger";
import { parseCatalogueWorkbook } from "../src/catalog/catalogue-workbook";
import {
  getAppPaths,
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../src/config";
import { buildCostAmendmentSnapshot } from "../src/report/cost-amendment-report";
import { bootstrapAdministrator } from "../src/security/auth-service";
import type { ActorContext } from "../src/security/authorization";
import {
  FileIntegrityError,
  openVerifiedFile,
} from "../src/integrity/file-integrity";
import {
  createArtifact,
  createFileArtifact,
  materializeReservedFileArtifact,
  type ArtifactRow,
} from "../src/services/artifact-service";
import {
  cairClearsReadiness,
  createCairDraft,
  listCairs,
  transitionCair,
} from "../src/services/cair-service";
import { createCostAmendmentPreviewArtifact } from "../src/services/cost-amendment-preview-service";
import {
  addCostAmendmentItem,
  assertCostAmendmentMayLock,
  CostAmendmentWorkflowBlockedError,
  createCostAmendmentDraft,
  updateCostAmendmentItem,
} from "../src/services/cost-amendment-service";
import { updateProject } from "../src/services/project-lifecycle-service";
import { installReferenceData } from "../src/services/reference-data-service";
import {
  ensureTeamWorkspace,
  TEAM_WORKSPACE_ID,
} from "../src/services/workspace-service";
import { prepareSubmissionPackage } from "../src/services/submission-package-service";
import {
  beginSubmissionPreparation,
  reserveSubmissionPreparation,
} from "../src/services/submission-preparation-service";
import {
  markSubmissionExported,
  recordManualSubmission,
} from "../src/services/submission-service";
import { createSupportingWorkbookArtifact } from "../src/services/supporting-workbook-service";
import { writeSubmissionPackage } from "../src/export/submission-package";
import { strFromU8, unzipSync } from "fflate";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "./helpers/postgres";

const RULE_SOURCE_ID = "workflow-rule-source";
const CATALOGUE_SOURCE_ID = "workflow-catalogue-source";
const CATALOGUE_RELEASE_ID = "workflow-catalogue-release";
const CATALOGUE_ITEM_ID = "workflow-material-item";
const CATALOGUE_ID = "MAT-WORKFLOW-001";
const RULE_SHA256 = "1".repeat(64);
const CATALOGUE_SHA256 = "2".repeat(64);
const PROJECT_NAME = "Workflow Production Vehicle";
const UPDATED_PROJECT_NAME = "Workflow Production Vehicle — Reviewed";
const REPORT_ID = "workflow-report-snapshot";
const REPORT_CREATED_AT = "2026-07-30T08:00:00.000Z";
const zeroBreakdown = {
  material: "0",
  process: "0",
  fastener: "0",
  tooling: "0",
  total: "0",
} as const;

describe.skipIf(!hasPostgresTestDatabase())(
  "PostgreSQL rule workflows and immutable artifacts",
  () => {
    let postgres: PostgresTestDatabase;
    let temporaryRoot: string;
    let paths: AppPaths;
    let adminUserId: string;
    let editorUserId: string;
    let projectId: string;
    let vehicleId: string;
    let initialSupportingArtifact: ArtifactRow;
    let currentSupportingArtifact: ArtifactRow;
    let previewArtifact: ArtifactRow;

    beforeAll(async () => {
      postgres = await createPostgresTestDatabase();
      temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "ucm-workflows-postgres-"),
      );
      const defaults = getAppPaths();
      const dataRoot = path.join(temporaryRoot, "data");
      paths = {
        ...defaults,
        dataRoot,
        uploadRoot: path.join(dataRoot, "uploads"),
        reportRoot: path.join(dataRoot, "reports"),
        outputPdfRoot: path.join(temporaryRoot, "output", "pdf"),
        webDistRoot: path.join(temporaryRoot, "missing-web-dist"),
      };
      await mkdir(paths.reportRoot, { recursive: true });
      await installReferenceData(postgres.database);
      await installReferenceFixture(postgres);

      const administrator = await bootstrapAdministrator(postgres.database, {
        email: "workflow-admin@example.test",
        displayName: "Workflow Administrator",
      });
      adminUserId = administrator.id;
      editorUserId = randomUUID();
      await postgres.database.query(
        `
          INSERT INTO users(
            id, email, display_name, role, status
          )
          VALUES
            ($1, 'workflow-editor@example.test', 'Workflow Editor',
             'editor', 'active')
        `,
        [editorUserId],
      );

      const workspace = await ensureTeamWorkspace(postgres.database);
      projectId = workspace.id;
      expect(projectId).toBe(TEAM_WORKSPACE_ID);
      await postgres.database.query(
        `
          UPDATE projects
          SET name = $1,
              entry_number = 'E14',
              rule_source_document_id = $2,
              rule_pack_version = 'FSAE-A 2026 test rule',
              rule_pack_sha256 = $3,
              catalogue_release_id = $4,
              focus_systems_json = '["CH"]'::jsonb
          WHERE id = $5
        `,
        [
          PROJECT_NAME,
          RULE_SOURCE_ID,
          RULE_SHA256,
          CATALOGUE_RELEASE_ID,
          projectId,
        ],
      );
      vehicleId = (
        await postgres.database.one<{ id: string }>(
          `
            SELECT id
            FROM cost_nodes
            WHERE project_id = $1 AND kind = 'vehicle'
          `,
          [projectId],
        )
      ).id;
      await installCompleteReportFixture();
      initialSupportingArtifact =
        await createSupportingWorkbookArtifact(
          postgres.database,
          paths,
          actor(editorUserId, "editor", "supporting-workbook-initial"),
          REPORT_ID,
        );
      currentSupportingArtifact = initialSupportingArtifact;
    }, 120_000);

    afterAll(async () => {
      await postgres?.close();
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });

    it("enforces project authorization and only clears a CAIR against an official catalogue release", async () => {
      const draft = await createCairDraft(
        postgres.database,
        actor(editorUserId, "editor", "cair-create"),
        projectId,
        {
          requestedCatalogueDescription: "Unlisted steering material",
          rationale:
            "The immutable catalogue does not currently contain the exact engineering input.",
          proposedCost: "12.345",
          provenance: {
            supplier: "Engineering supplier quotation",
            observedAt: "2026-07-30",
          },
        },
      );
      expect(draft).toMatchObject({
        project_id: projectId,
        status: "draft",
        proposed_cost: "12.345",
        created_by: editorUserId,
        updated_by: editorUserId,
        version: 0,
      });
      expect(cairClearsReadiness(draft)).toBe(false);

      await expect(
        transitionCair(
          postgres.database,
          actor(editorUserId, "editor", "cair-submit-no-reference"),
          draft.id,
          {
            expectedVersion: 0,
            next: "submitted",
          },
        ),
      ).rejects.toThrow("cair-external-reference-required");

      const submitted = await transitionCair(
        postgres.database,
        actor(editorUserId, "editor", "cair-submit"),
        draft.id,
        {
          expectedVersion: 0,
          next: "submitted",
          externalReference: "CAIR-RECEIPT-2026-0042",
        },
      );
      expect(submitted).toMatchObject({
        status: "submitted",
        external_reference: "CAIR-RECEIPT-2026-0042",
        resolved_catalogue_release_id: null,
        resolved_catalogue_item_id: null,
        version: 1,
      });
      expect(cairClearsReadiness(submitted)).toBe(false);

      await expect(
        transitionCair(
          postgres.database,
          actor(editorUserId, "editor", "cair-false-resolution"),
          draft.id,
          {
            expectedVersion: 1,
            next: "catalogue-resolved",
            resolvedCatalogueReleaseId: "not-an-official-release",
            resolvedCatalogueItemId: "not-an-official-item",
          },
        ),
      ).rejects.toThrow("cair-official-catalogue-item-not-found");

      const resolved = await transitionCair(
        postgres.database,
        actor(editorUserId, "editor", "cair-official-resolution"),
        draft.id,
        {
          expectedVersion: 1,
          next: "catalogue-resolved",
          decisionNote:
            "Resolved by the immutable governing catalogue release.",
          resolvedCatalogueReleaseId: CATALOGUE_RELEASE_ID,
          resolvedCatalogueItemId: CATALOGUE_ITEM_ID,
        },
      );
      expect(resolved).toMatchObject({
        status: "catalogue-resolved",
        external_reference: "CAIR-RECEIPT-2026-0042",
        resolved_catalogue_release_id: CATALOGUE_RELEASE_ID,
        resolved_catalogue_item_id: CATALOGUE_ITEM_ID,
        decided_by: editorUserId,
        version: 2,
      });
      expect(cairClearsReadiness(resolved)).toBe(true);
    });

    it("persists exact amendment inputs, applies 105/95 per-BoX arithmetic, and hard-blocks final export", async () => {
      const amendment = await createCostAmendmentDraft(
        postgres.database,
        actor(editorUserId, "editor", "amendment-create"),
        projectId,
        {
          eventReference: "EVENT-CAR-0042",
          baseReportSnapshotId: REPORT_ID,
        },
      );
      const source = {
        partIdentity: vehicleId,
        partNumber: "E14-CH-000001-A",
        catalogueReleaseId: CATALOGUE_RELEASE_ID,
        catalogueItemId: CATALOGUE_ITEM_ID,
        catalogueId: CATALOGUE_ID,
      };
      const laterReleaseId = "workflow-catalogue-release-later";
      await postgres.database.query(
        `
          INSERT INTO catalogue_releases(
            id, competition_year, revision_code, released_on,
            source_document_id
          )
          VALUES ($1, 2026, '26_R2-test', DATE '2026-07-31', $2)
        `,
        [laterReleaseId, CATALOGUE_SOURCE_ID],
      );
      await postgres.database.query(
        "UPDATE projects SET catalogue_release_id = $1 WHERE id = $2",
        [laterReleaseId, projectId],
      );
      let afterAddition: Awaited<
        ReturnType<typeof addCostAmendmentItem>
      >;
      try {
        await expect(
          addCostAmendmentItem(
            postgres.database,
            actor(editorUserId, "editor", "amendment-kind-forgery"),
            amendment.id,
            0,
            {
              action: "add",
              nodeId: vehicleId,
              description: "Caller-forged cost box",
              costBox: "process",
              classification: "modified",
              changeGroupId: "change-material-1",
              quantity: "3",
              originalQuantity: "1",
              revisedQuantity: "1",
              unitCost: "0.01",
              source,
            },
          ),
        ).rejects.toThrow("catalogue-kind-mismatch");
        afterAddition = await addCostAmendmentItem(
          postgres.database,
          actor(editorUserId, "editor", "amendment-addition"),
          amendment.id,
          0,
          {
            action: "add",
            nodeId: vehicleId,
            description: "Revised material addition",
            costBox: "material",
            classification: "modified",
            changeGroupId: "change-material-1",
            quantity: "3",
            originalQuantity: "1",
            revisedQuantity: "1",
            unitCost: "10",
            source,
          },
        );
      } finally {
        await postgres.database.query(
          "UPDATE projects SET catalogue_release_id = $1 WHERE id = $2",
          [CATALOGUE_RELEASE_ID, projectId],
        );
      }
      expect(afterAddition.amendment).toMatchObject({
        total_additions: "30",
        total_removals: "0",
        net_change: "30",
        version: 1,
      });
      expect(afterAddition.blockers.map(({ code }) => code)).toContain(
        "amendment-change-group-incomplete",
      );

      const detail = await addCostAmendmentItem(
        postgres.database,
        actor(editorUserId, "editor", "amendment-removal"),
        amendment.id,
        1,
        {
          action: "remove",
          nodeId: vehicleId,
          description: "Superseded material removal",
          costBox: "material",
          classification: "modified",
          changeGroupId: "change-material-1",
          quantity: "2",
          originalQuantity: "1",
          revisedQuantity: "1",
          // Deliberately false: the service must derive 10 from the immutable
          // catalogue item instead of trusting this caller-supplied value.
          unitCost: "999999",
          source: {
            ...source,
            partNumber: "FORGED-PART-NUMBER",
            catalogueId: "FORGED-CATALOGUE-ID",
          },
        },
      );
      expect(detail.amendment).toMatchObject({
        total_additions: "30",
        total_removals: "20",
        net_change: "10",
        version: 2,
      });
      expect(detail.items.map(({ subtotal }) => subtotal)).toEqual([
        "30",
        "20",
      ]);
      expect(detail.items.map(({ unit_cost }) => unit_cost)).toEqual([
        "10",
        "10",
      ]);
      expect(detail.items[1]?.source_json).toMatchObject({
        partIdentity: vehicleId,
        catalogueReleaseId: CATALOGUE_RELEASE_ID,
        catalogueItemId: CATALOGUE_ITEM_ID,
        catalogueId: CATALOGUE_ID,
        derivedFrom: "immutable-base-report-and-official-catalogue",
      });
      expect(detail.blockers.map(({ code }) => code)).not.toContain(
        "amendment-change-group-incomplete",
      );

      const calculated = buildCostAmendmentSnapshot({
        schemaVersion: 1,
        amendmentId: amendment.id,
        eventReference: amendment.event_reference,
        createdAt: detail.amendment.updated_at,
        project: {
          id: projectId,
          name: PROJECT_NAME,
          entryNumber: "E14",
        },
        baseReport: {
          snapshotId: REPORT_ID,
          sha256: (
            await postgres.database.one<{ pdf_sha256: string }>(
              "SELECT pdf_sha256 FROM report_snapshots WHERE id = $1",
              [REPORT_ID],
            )
          ).pdf_sha256,
          breakdown: { ...zeroBreakdown },
        },
        rulePack: {
          version: "FSAE-A 2026 test rule",
          sha256: RULE_SHA256,
        },
        catalogue: {
          releaseId: CATALOGUE_RELEASE_ID,
          revision: "26_R1",
          sha256: CATALOGUE_SHA256,
        },
        parts: [
          {
            partIdentity: vehicleId,
            partNumber: source.partNumber,
            description: PROJECT_NAME,
            originalQuantity: "1",
            revisedQuantity: "1",
            original: { ...zeroBreakdown },
          },
        ],
        items: detail.items.map((item) => ({
          id: item.id,
          action: item.action,
          costBox: item.cost_box,
          classification: item.classification,
          changeGroupId: item.change_group_id,
          partIdentity: item.source_json.partIdentity,
          originalQuantity: item.original_quantity,
          revisedQuantity: item.revised_quantity,
          nodeId: item.node_id,
          description: item.description,
          quantity: item.quantity,
          unitCost: item.unit_cost,
          subtotal: item.subtotal,
          catalogueReleaseId: item.source_json.catalogueReleaseId,
          catalogueItemId: item.source_json.catalogueItemId,
          catalogueId: item.source_json.catalogueId,
        })),
      });
      expect(calculated.calculation.buckets.material).toEqual({
        original: "0",
        additions: "30",
        removals: "20",
        rawRevised: "10",
        amendmentDelta: "12.5",
        adjustedRevised: "12.5",
      });
      expect(calculated.calculation.amendmentDelta).toEqual({
        material: "12.5",
        process: "0",
        fastener: "0",
        tooling: "0",
        total: "12.5",
      });

      expect(() => assertCostAmendmentMayLock(detail)).toThrow(
        CostAmendmentWorkflowBlockedError,
      );
      try {
        assertCostAmendmentMayLock(detail);
      } catch (error) {
        expect(
          (error as CostAmendmentWorkflowBlockedError).issues.map(
            ({ code }) => code,
          ),
        ).toEqual(
          expect.arrayContaining([
            "amendment-official-template-unavailable",
            "amendment-modified-classification-unresolved",
            "amendment-official-renderer-unavailable",
          ]),
        );
      }

      previewArtifact = await createCostAmendmentPreviewArtifact(
        postgres.database,
        paths,
        actor(editorUserId, "editor", "amendment-preview"),
        amendment.id,
      );
      expect(previewArtifact).toMatchObject({
        project_id: projectId,
        kind: "cost-amendment",
        status: "complete",
        report_snapshot_id: REPORT_ID,
        mime_type: "application/pdf",
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadata_json: {
          previewOnly: true,
          submissionEligible: false,
          sourceAmendmentVersion: 2,
          frozenAmendmentVersion: 3,
          amendmentSnapshotSha256: expect.stringMatching(
            /^[a-f0-9]{64}$/,
          ),
          watermark: "PREVIEW — NOT FOR SUBMISSION",
          calculation: {
            amendmentDelta: {
              material: "12.5",
              process: "0",
              fastener: "0",
              tooling: "0",
              total: "12.5",
            },
          },
          snapshot: {
            amendmentId: amendment.id,
            amendmentVersion: 2,
            previewOnly: true,
          },
        },
      });
      const previewPath = resolveStoredDataPath(
        previewArtifact.storage_path!,
        paths,
      );
      expect((await readFile(previewPath)).subarray(0, 5).toString()).toBe(
        "%PDF-",
      );

      const frozen = await postgres.database.one<{
        snapshot_json: {
          amendmentId: string;
          amendmentVersion: number;
          calculation: {
            rawRevised: { total: string };
            amendmentDelta: { total: string };
            adjustedRevised: { total: string };
          };
        } | null;
        version: number;
      }>(
        `
          SELECT snapshot_json, version
          FROM cost_amendments
          WHERE id = $1
        `,
        [amendment.id],
      );
      expect(frozen).toMatchObject({
        version: 3,
        snapshot_json: {
          amendmentId: amendment.id,
          amendmentVersion: 2,
          calculation: {
            rawRevised: { total: "10" },
            amendmentDelta: { total: "12.5" },
            adjustedRevised: { total: "12.5" },
          },
        },
      });

      const editedAfterPreview = await updateCostAmendmentItem(
        postgres.database,
        actor(editorUserId, "editor", "amendment-edit-after-preview"),
        amendment.id,
        detail.items[0]!.id,
        3,
        {
          action: "add",
          nodeId: vehicleId,
          description: "Revised material addition after review",
          costBox: "material",
          classification: "modified",
          changeGroupId: "change-material-1",
          quantity: "3",
          originalQuantity: "1",
          revisedQuantity: "1",
          unitCost: "10",
          source,
        },
      );
      expect(editedAfterPreview.amendment).toMatchObject({
        snapshot_json: null,
        version: 4,
      });
    });

    it("generates deterministic supporting workbooks from the immutable report snapshot, not live project data", async () => {
      const firstPath = resolveStoredDataPath(
        initialSupportingArtifact.storage_path!,
        paths,
      );
      const firstBytes = await readFile(firstPath);
      expect(
        createHash("sha256").update(firstBytes).digest("hex"),
      ).toBe(initialSupportingArtifact.content_sha256);
      expect(
        parseCatalogueWorkbook(firstBytes).sheets.map(({ name }) => name),
      ).toEqual([
        "Submission Manifest",
        "BOM",
        "Cost Data",
        "Reconciliation",
      ]);

      const liveProject = await updateProject(
        postgres.database,
        actor(editorUserId, "editor", "project-live-name-update"),
        projectId,
        {
          expectedVersion: 0,
          name: UPDATED_PROJECT_NAME,
        },
      );
      expect(liveProject.name).toBe(UPDATED_PROJECT_NAME);

      currentSupportingArtifact =
        await createSupportingWorkbookArtifact(
          postgres.database,
          paths,
          actor(editorUserId, "editor", "supporting-workbook-repeat"),
          REPORT_ID,
        );
      const repeatedBytes = await readFile(
        resolveStoredDataPath(
          currentSupportingArtifact.storage_path!,
          paths,
        ),
      );
      expect(currentSupportingArtifact.content_sha256).toBe(
        initialSupportingArtifact.content_sha256,
      );
      expect(repeatedBytes).toEqual(firstBytes);
      const manifestValues = parseCatalogueWorkbook(repeatedBytes)
        .sheetsByName["Submission Manifest"]!
        .rows.flatMap(({ cells }) => cells.map(({ value }) => value));
      expect(manifestValues).toContain(PROJECT_NAME);
      expect(manifestValues).not.toContain(UPDATED_PROJECT_NAME);

      await expect(
        postgres.database.query(
          `
            UPDATE report_snapshots
            SET snapshot_json =
              jsonb_set(snapshot_json, '{project,name}', '"Mutated"')
            WHERE id = $1
          `,
          [REPORT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    });

    it("prepares a local package and requires exported state plus an external receipt before recording submission", async () => {
      const packageFilename = "UCM-E14-submission.zip";
      const manifestFilename = "UCM-E14-submission-manifest.json";
      const interrupted = await reserveSubmissionPreparation(
        postgres.database,
        actor(editorUserId, "editor", "submission-reserve-interrupted"),
        {
          projectId,
          reportSnapshotId: REPORT_ID,
          supportingArtifactId: currentSupportingArtifact.id,
          packageFilename,
          manifestFilename,
        },
      );
      const generating = await beginSubmissionPreparation(
        postgres.database,
        actor(editorUserId, "editor", "submission-start-interrupted"),
        interrupted.id,
      );
      const reportSource = await postgres.database.one<{
        pdf_path: string;
        pdf_sha256: string;
        pdf_bytes: string | number;
      }>(
        `
          SELECT pdf_path, pdf_sha256, pdf_bytes
          FROM report_snapshots
          WHERE id = $1
        `,
        [REPORT_ID],
      );
      await materializeReservedFileArtifact(
        postgres.database,
        paths,
        actor(editorUserId, "editor", "submission-package-before-crash"),
        {
          artifactId: generating.package_artifact_id,
          projectId,
          kind: "submission-package",
          reportSnapshotId: REPORT_ID,
          filename: packageFilename,
          mimeType: "application/zip",
          metadata: {
            submissionId: generating.id,
            mode: "competition-ready",
            externalSubmissionRecorded: false,
          },
          generate: async (destination) => {
            const result = await writeSubmissionPackage(destination, {
              schemaVersion: 1,
              submissionId: generating.id,
              projectId,
              projectName: PROJECT_NAME,
              entryNumber: "E14",
              reportSnapshotId: REPORT_ID,
              preparedAt: generating.prepared_at,
              preparedBy: generating.prepared_by,
              mode: "competition-ready",
              sources: {
                rulePackVersion: "FSAE-A 2026 test rule",
                rulePackSha256: RULE_SHA256,
                catalogueRevision: "26_R1",
                catalogueSha256: CATALOGUE_SHA256,
              },
              validationBlockers: [],
              artifacts: [
                {
                  role: "cost-report",
                  filename: "cost-report.pdf",
                  mimeType: "application/pdf",
                  expectedSha256: reportSource.pdf_sha256,
                  expectedByteSize: Number(reportSource.pdf_bytes),
                  reportSnapshotId: REPORT_ID,
                  source: {
                    filePath: resolveStoredDataPath(
                      reportSource.pdf_path,
                      paths,
                    ),
                  },
                },
                {
                  role: "supporting-workbook",
                  filename: "supporting-cost-data.xlsx",
                  mimeType:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  expectedSha256:
                    currentSupportingArtifact.content_sha256!,
                  expectedByteSize: Number(
                    currentSupportingArtifact.byte_size,
                  ),
                  reportSnapshotId: REPORT_ID,
                  source: {
                    filePath: resolveStoredDataPath(
                      currentSupportingArtifact.storage_path!,
                      paths,
                    ),
                  },
                },
              ],
            });
            return {
              sha256: result.sha256,
              byteSize: result.byteSize,
              metadata: {
                manifestSha256: result.manifestSha256,
                manifestBytes: result.manifestBytes,
              },
            };
          },
        },
      );
      expect(
        await postgres.database.maybeOne(
          "SELECT id FROM submissions WHERE id = $1",
          [generating.id],
        ),
      ).toBeNull();
      await postgres.database.query(
        `
          UPDATE artifacts
          SET status = 'failed',
              error_message = 'simulated crash before manifest write',
              completed_at = clock_timestamp(),
              version = version + 1
          WHERE id = $1 AND status = 'reserved'
        `,
        [generating.manifest_artifact_id],
      );

      const prepared = await prepareSubmissionPackage(
        postgres.database,
        paths,
        actor(editorUserId, "editor", "submission-prepare"),
        {
          projectId,
          reportSnapshotId: REPORT_ID,
          supportingArtifactId: currentSupportingArtifact.id,
        },
      );
      expect(prepared.packageArtifact.id).toBe(
        generating.package_artifact_id,
      );
      expect(prepared.manifestArtifact.id).toBe(
        generating.manifest_artifact_id,
      );
      const recoveredPreparation = await postgres.database.one<{
        status: string;
        attempt_count: number;
        completed_submission_id: string;
      }>(
        `
          SELECT status, attempt_count, completed_submission_id
          FROM submission_preparations
          WHERE id = $1
        `,
        [generating.id],
      );
      expect(recoveredPreparation).toEqual({
        status: "complete",
        attempt_count: 2,
        completed_submission_id: generating.id,
      });

      const competingClient = await postgres.database.pool.connect();
      const preparationLockKey =
        `ucm:submission-preparation:${generating.id}`;
      try {
        await competingClient.query(
          "SELECT pg_advisory_lock(hashtextextended($1, 0))",
          [preparationLockKey],
        );
        await expect(
          prepareSubmissionPackage(
            postgres.database,
            paths,
            actor(editorUserId, "editor", "submission-concurrent-repeat"),
            {
              projectId,
              reportSnapshotId: REPORT_ID,
              supportingArtifactId: currentSupportingArtifact.id,
            },
          ),
        ).rejects.toThrow("submission-preparation-in-progress");
      } finally {
        await competingClient.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [preparationLockKey],
        );
        competingClient.release();
      }

      const repeated = await prepareSubmissionPackage(
        postgres.database,
        paths,
        actor(editorUserId, "editor", "submission-idempotent-repeat"),
        {
          projectId,
          reportSnapshotId: REPORT_ID,
          supportingArtifactId: currentSupportingArtifact.id,
        },
      );
      expect(repeated.submission.id).toBe(prepared.submission.id);
      expect(repeated.packageArtifact.id).toBe(
        prepared.packageArtifact.id,
      );
      expect(repeated.manifestArtifact.id).toBe(
        prepared.manifestArtifact.id,
      );
      expect(
        await postgres.database.one<{ count: number }>(
          `
            SELECT COUNT(*)::int AS count
            FROM submissions
            WHERE project_id = $1 AND report_snapshot_id = $2
              AND supporting_artifact_id = $3
          `,
          [projectId, REPORT_ID, currentSupportingArtifact.id],
        ),
      ).toEqual({ count: 1 });
      expect(prepared.submission).toMatchObject({
        project_id: projectId,
        status: "prepared",
        report_snapshot_id: REPORT_ID,
        supporting_artifact_id: currentSupportingArtifact.id,
        package_artifact_id: prepared.packageArtifact.id,
        manifest_artifact_id: prepared.manifestArtifact.id,
        external_reference: null,
        prepared_by: editorUserId,
        version: 0,
      });
      expect(prepared.submission.manifest_json).toMatchObject({
        state: "prepared",
        project: {
          id: projectId,
          name: PROJECT_NAME,
          entryNumber: "E14",
        },
        externalSubmission: {
          transmittedByApplication: false,
          status: "not-recorded",
        },
      });

      const packageBytes = await readFile(
        resolveStoredDataPath(
          prepared.packageArtifact.storage_path!,
          paths,
        ),
      );
      expect(
        createHash("sha256").update(packageBytes).digest("hex"),
      ).toBe(prepared.packageArtifact.content_sha256);
      const archive = unzipSync(packageBytes);
      expect(Object.keys(archive)).toEqual([
        "cost-report.pdf",
        "supporting-cost-data.xlsx",
        "MANUAL-SUBMISSION-CHECKLIST.txt",
        "submission-manifest.json",
      ]);
      expect(
        JSON.parse(
          strFromU8(archive["submission-manifest.json"]!),
        ),
      ).toMatchObject({
        state: "prepared",
        externalSubmission: {
          transmittedByApplication: false,
          status: "not-recorded",
        },
      });

      await expect(
        recordManualSubmission(
          postgres.database,
          actor(editorUserId, "editor", "submission-too-early"),
          prepared.submission.id,
          0,
          "ORGANIZER-RECEIPT-0042",
        ),
      ).rejects.toThrow("invalid-submission-transition");

      const exported = await markSubmissionExported(
        postgres.database,
        actor(editorUserId, "editor", "submission-export"),
        prepared.submission.id,
        0,
      );
      expect(exported).toMatchObject({
        status: "exported",
        exported_by: editorUserId,
        version: 1,
      });
      await expect(
        recordManualSubmission(
          postgres.database,
          actor(editorUserId, "editor", "submission-no-receipt"),
          prepared.submission.id,
          1,
          "   ",
        ),
      ).rejects.toThrow("submission-external-reference-required");

      const inFlightArtifactId = randomUUID();
      const inFlightClient = await postgres.database.pool.connect();
      try {
        await inFlightClient.query("BEGIN");
        await inFlightClient.query(
          `
            INSERT INTO artifacts(
              id, project_id, kind, status, metadata_json, created_by
            )
            VALUES ($1, $2, 'other', 'reserved', '{}'::jsonb, $3)
          `,
          [inFlightArtifactId, projectId, editorUserId],
        );
        let submissionSettled = false;
        const concurrentSubmission = recordManualSubmission(
          postgres.database,
          actor(
            editorUserId,
            "editor",
            "submission-blocked-by-in-flight-artifact",
          ),
          prepared.submission.id,
          1,
          "ORGANIZER-RECEIPT-0042",
        ).then(
          (value) => {
            submissionSettled = true;
            return { value, error: null };
          },
          (error: unknown) => {
            submissionSettled = true;
            return { value: null, error };
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(submissionSettled).toBe(false);
        await inFlightClient.query("COMMIT");
        const blockedSubmission = await concurrentSubmission;
        expect(blockedSubmission.value).toBeNull();
        expect(blockedSubmission.error).toBeInstanceOf(Error);
        expect((blockedSubmission.error as Error).message).toBe(
          "project-submission-workflows-in-progress",
        );
      } catch (error) {
        await inFlightClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        inFlightClient.release();
      }
      await postgres.database.query(
        `
          UPDATE artifacts
          SET status = 'failed',
              error_message = 'Recovered test reservation',
              version = version + 1
          WHERE id = $1 AND status = 'reserved'
        `,
        [inFlightArtifactId],
      );

      const submitted = await recordManualSubmission(
        postgres.database,
        actor(editorUserId, "editor", "submission-manual-receipt"),
        prepared.submission.id,
        1,
        "ORGANIZER-RECEIPT-0042",
      );
      expect(submitted).toMatchObject({
        status: "manually-submitted",
        external_reference: "ORGANIZER-RECEIPT-0042",
        submitted_by: editorUserId,
        version: 2,
      });
      expect(submitted.submitted_at).toEqual(expect.any(String));
      const submittedProject = await postgres.database.one<{
        status: string;
        version: number;
        updated_by: string;
      }>(
        "SELECT status, version, updated_by FROM projects WHERE id = $1",
        [projectId],
      );
      expect(submittedProject).toEqual({
        status: "submitted",
        version: 2,
        updated_by: editorUserId,
      });
      await expect(
        updateProject(
          postgres.database,
          actor(editorUserId, "editor", "submitted-project-implicit-edit"),
          projectId,
          {
            expectedVersion: submittedProject.version,
            name: "Implicit post-submission mutation",
          },
        ),
      ).rejects.toThrow("submitted-project-reopen-required");
      const reopened = await updateProject(
        postgres.database,
        actor(editorUserId, "editor", "submitted-project-explicit-reopen"),
        projectId,
        {
          expectedVersion: submittedProject.version,
          status: "review",
        },
      );
      expect(reopened).toMatchObject({
        status: "review",
        version: 3,
      });
    });

    it("rejects artifact digest lies and detects post-generation tampering", async () => {
      const invalidFilename = "invalid-generator-digest.bin";
      let dishonestDigestError: unknown = null;
      try {
        await createArtifact(
          postgres.database,
          paths,
          actor(editorUserId, "editor", "artifact-invalid-digest"),
          {
            projectId,
            kind: "other",
            filename: invalidFilename,
            mimeType: "application/octet-stream",
            generate: () => ({
              bytes: Buffer.from("artifact bytes with a dishonest digest"),
              sha256: "0".repeat(64),
            }),
          },
        );
      } catch (error) {
        dishonestDigestError = error;
      }
      expect
        .soft(dishonestDigestError, "dishonest digest must be rejected")
        .toBeInstanceOf(Error);
      const dishonest = await postgres.database.query<{
        status: string;
      }>(
        `
          SELECT status
          FROM artifacts
          WHERE metadata_json ->> 'filename' = $1
        `,
        [invalidFilename],
      );
      expect(dishonest.rows).toHaveLength(1);
      expect
        .soft(
          dishonest.rows[0]!.status,
          "a digest mismatch must not leave a complete artifact",
        )
        .toBe("failed");

      const invalidFileFilename = "invalid-file-generator-digest.bin";
      let dishonestFileDigestError: unknown = null;
      try {
        await createFileArtifact(
          postgres.database,
          paths,
          actor(editorUserId, "editor", "file-artifact-invalid-digest"),
          {
            projectId,
            kind: "other",
            filename: invalidFileFilename,
            mimeType: "application/octet-stream",
            generate: async (destination) => {
              const bytes = Buffer.from(
                "file artifact bytes with a dishonest digest",
              );
              await writeFile(destination, bytes, {
                flag: "wx",
                mode: 0o600,
              });
              return {
                byteSize: bytes.byteLength,
                sha256: "0".repeat(64),
              };
            },
          },
        );
      } catch (error) {
        dishonestFileDigestError = error;
      }
      expect(dishonestFileDigestError).toBeInstanceOf(Error);
      const dishonestFile = await postgres.database.one<{
        status: string;
      }>(
        `
          SELECT status
          FROM artifacts
          WHERE metadata_json ->> 'filename' = $1
        `,
        [invalidFileFilename],
      );
      expect(dishonestFile.status).toBe("failed");

      const previewPath = resolveStoredDataPath(
        previewArtifact.storage_path!,
        paths,
      );
      const preview = await openVerifiedFile(
        previewPath,
        previewArtifact.content_sha256!,
      );
      await preview.handle.close();
      await writeFile(previewPath, Buffer.from("tampered preview artifact"));
      await expect(
        openVerifiedFile(previewPath, previewArtifact.content_sha256!),
      ).rejects.toBeInstanceOf(FileIntegrityError);

      await expect(
        postgres.database.query(
          `
            UPDATE artifacts
            SET content_sha256 = $1
            WHERE id = $2
          `,
          ["f".repeat(64), currentSupportingArtifact.id],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      const auditRows = await postgres.database.query<AuditLedgerRow>(
        "SELECT * FROM audit_ledger ORDER BY sequence",
      );
      expect(verifyAuditLedgerRows(auditRows.rows)).toEqual({
        ok: true,
        checked: auditRows.rows.length,
        error: null,
      });
      expect(auditRows.rows.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          "cair.created",
          "cair.submitted",
          "cair.catalogue-resolved",
          "cost-amendment.created",
          "cost-amendment.item-added",
          "cost-amendment.item-updated",
          "cost-amendment.preview-snapshot-frozen",
          "artifact.completed",
          "submission.preparation-reserved",
          "submission.preparation-retried",
          "submission.preparation-completed",
          "artifact.retried",
          "submission.prepared",
          "submission.exported",
          "submission.manually-submitted",
          "project.status-changed-by-submission",
          "artifact.failed",
        ]),
      );
    });

    async function installCompleteReportFixture(): Promise<void> {
      const reportBytes = Buffer.from(
        "%PDF-1.7\n% immutable integration report fixture\n%%EOF\n",
      );
      const reportPath = path.join(
        paths.reportRoot,
        `${REPORT_ID}.pdf`,
      );
      await writeFile(reportPath, reportBytes, {
        flag: "wx",
        mode: 0o600,
      });
      const snapshot = {
        schemaVersion: 2,
        snapshotId: REPORT_ID,
        createdAt: REPORT_CREATED_AT,
        mode: "competition-ready",
        provenance: {
          developerDemo: false,
          contentSource: "persisted-project-records",
          syntheticTechnicalContent: false,
        },
        sources: {
          rulePack: {
            documentId: RULE_SOURCE_ID,
            version: "FSAE-A 2026 test rule",
            sha256: RULE_SHA256,
          },
          catalogue: {
            releaseId: CATALOGUE_RELEASE_ID,
            revision: "26_R1",
            sha256: CATALOGUE_SHA256,
          },
        },
        project: {
          id: projectId,
          name: PROJECT_NAME,
          season: 2026,
          entry_number: "E14",
          vehicle_type: "electric",
          rule_pack_version: "FSAE-A 2026 test rule",
          catalogue_revision: "26_R1",
        },
        breakdown: { ...zeroBreakdown },
        tree: {
          id: vehicleId,
          parent_id: null,
          kind: "vehicle",
          system_code: null,
          full_number: null,
          reference_id: null,
          name: PROJECT_NAME,
          description: "Immutable production report snapshot",
          revision: null,
          procurement_type: "made",
          quantity: "1",
          breakdown: { ...zeroBreakdown },
          costLines: [],
          children: [],
        },
        evidence: [],
      };
      await postgres.database.query(
        `
          INSERT INTO report_snapshots(
            id, project_id, mode, status, snapshot_json,
            validation_json, source_hashes_json,
            pdf_path, pdf_sha256, pdf_bytes, page_count,
            created_by, created_at, completed_at
          )
          VALUES (
            $1, $2, 'competition-ready', 'complete', $3::jsonb,
            $4::jsonb, $5::jsonb,
            $6, $7, $8, 1,
            $9, $10::timestamptz, $10::timestamptz
          )
        `,
        [
          REPORT_ID,
          projectId,
          JSON.stringify(snapshot),
          JSON.stringify({
            mode: "competition-ready",
            issues: [],
            blockers: 0,
            warnings: 0,
            notices: 0,
          }),
          JSON.stringify({
            localAddendum: RULE_SHA256,
            catalogue: CATALOGUE_SHA256,
          }),
          toStoredDataPath(reportPath, paths),
          createHash("sha256").update(reportBytes).digest("hex"),
          reportBytes.byteLength,
          adminUserId,
          REPORT_CREATED_AT,
        ],
      );
    }
  },
);

function actor(
  actorUserId: string,
  systemRole: ActorContext["systemRole"],
  operation: string,
): ActorContext {
  return {
    actorUserId,
    systemRole,
    requestId: `workflow-test:${operation}:${randomUUID()}`,
    ipAddressHash: "workflow-test-ip",
    userAgent: "Vitest PostgreSQL integration",
  };
}

async function installReferenceFixture(
  postgres: PostgresTestDatabase,
): Promise<void> {
  await postgres.database.transaction(async (transaction) => {
    await transaction.query(
      `
        INSERT INTO source_documents(
          id, kind, title, version, original_url, local_path,
          sha256, applicability, retrieved_at
        )
        VALUES
          (
            $1, 'governing-rule', 'Workflow Rule Source',
            'FSAE-A 2026 test rule', 'https://example.test/rule',
            'test-fixtures/rule.pdf', $2, 'Integration workflow fixture',
            '2026-07-30T00:00:00.000Z'
          ),
          (
            $3, 'governing-catalogue', 'Workflow Catalogue Source',
            '26_R1', 'https://example.test/catalogue',
            'test-fixtures/catalogue.xlsx', $4,
            'Integration workflow fixture',
            '2026-07-30T00:00:00.000Z'
          )
      `,
      [
        RULE_SOURCE_ID,
        RULE_SHA256,
        CATALOGUE_SOURCE_ID,
        CATALOGUE_SHA256,
      ],
    );
    await transaction.query(
      `
        INSERT INTO catalogue_releases(
          id, competition_year, revision_code, released_on,
          source_document_id
        )
        VALUES ($1, 2026, '26_R1', '2026-05-04', $2)
      `,
      [CATALOGUE_RELEASE_ID, CATALOGUE_SOURCE_ID],
    );
    await transaction.query(
      `
        INSERT INTO catalogue_items(
          id, release_id, kind, catalogue_id, name, category,
          unit, fixed_cost, coefficients_json, metadata_json,
          source_sheet, source_row, raw_json
        )
        VALUES (
          $1, $2, 'material', $3, 'Workflow material',
          'Integration fixture', 'each', 10, '{}'::jsonb, '{}'::jsonb,
          'Materials', 2, '{"fixture":true}'::jsonb
        )
      `,
      [CATALOGUE_ITEM_ID, CATALOGUE_RELEASE_ID, CATALOGUE_ID],
    );
  });
}
