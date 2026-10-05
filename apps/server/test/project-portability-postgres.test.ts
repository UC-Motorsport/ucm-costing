import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getAppPaths,
  resolveStoredDataPath,
  toStoredDataPath,
  type AppPaths,
} from "../src/config";
import { bootstrapAdministrator, createUser } from "../src/security/auth-service";
import {
  assertProjectPermission,
  type ActorContext,
} from "../src/security/authorization";
import {
  commitProjectArchive,
  exportProjectArchive,
  previewProjectArchive,
} from "../src/services/project-archive-service";
import {
  commitProjectCopy,
  previewProjectCopy,
} from "../src/services/project-copy-service";
import { storeEvidenceIdempotently } from "../src/services/evidence-service";
import { listActiveProjects } from "../src/services/project-lifecycle-service";
import { installReferenceData } from "../src/services/reference-data-service";
import {
  createSeasonWorkspaceRecord,
  ensureTeamWorkspace,
  getTeamWorkspaceId,
} from "../src/services/workspace-service";
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from "./helpers/postgres";

describe.skipIf(!hasPostgresTestDatabase())(
  "multi-season copy and portable archives",
  () => {
    let postgres: PostgresTestDatabase;
    let temporaryRoot: string;
    let paths: AppPaths;
    let admin: ActorContext;
    let editor: ActorContext;
    let currentProjectId: string;
    let historicalProjectId: string;
    let sourceAssemblyId: string;
    let targetSystemId: string;

    beforeAll(async () => {
      postgres = await createPostgresTestDatabase();
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ucm-portability-"));
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
      await mkdir(paths.uploadRoot, { recursive: true });
      await installReferenceData(postgres.database);
      const administrator = await bootstrapAdministrator(postgres.database, {
        email: "portability-admin@example.test",
        displayName: "Portability Administrator",
      });
      const actorBase = {
        requestId: "portability-test",
        userAgent: null,
        ipAddressHash: null,
      };
      admin = {
        ...actorBase,
        actorUserId: administrator.id,
        systemRole: "admin",
      };
      const editorUser = await createUser(
        postgres.database,
        { ...actorBase, actorUserId: administrator.id },
        {
          email: "portability-editor@example.test",
          displayName: "Portability Editor",
          role: "editor",
        },
      );
      editor = {
        ...actorBase,
        actorUserId: editorUser.id,
        systemRole: "editor",
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
      const historicalSystem = await postgres.database.one<{ id: string }>(
        "SELECT id FROM cost_nodes WHERE project_id = $1 AND kind = 'system' AND system_code = 'DR'",
        [historicalProjectId],
      );
      const targetSystem = await postgres.database.one<{ id: string }>(
        "SELECT id FROM cost_nodes WHERE project_id = $1 AND kind = 'system' AND system_code = 'DR'",
        [currentProjectId],
      );
      targetSystemId = targetSystem.id;
      sourceAssemblyId = randomUUID();
      const sourcePartId = randomUUID();
      await postgres.database.query(
        `
          INSERT INTO cost_nodes(
            id, project_id, parent_id, kind, system_code, reference_id,
            full_number, name, description, procurement_type, quantity,
            internal_note, sort_order
          )
          VALUES
            ($1, $2, $3, 'assembly', 'DR', '010000',
             'E13-25-DR-010000-A', 'Historical drive assembly',
             'A verified historical assembly', 'made', 1,
             'Historical source note', 10),
            ($4, $2, $1, 'part', 'DR', '010001',
             'E13-25-DR-010001-A', 'Historical drive part',
             'A verified historical part', 'made', 2,
             '', 0)
        `,
        [sourceAssemblyId, historicalProjectId, historicalSystem.id, sourcePartId],
      );
      const catalogueItem = await postgres.database.one<{ id: string; fixed_cost: string }>(
        `
          SELECT id, fixed_cost::text
          FROM catalogue_items
          WHERE kind = 'material' AND fixed_cost IS NOT NULL
          ORDER BY id
          LIMIT 1
        `,
      );
      await postgres.database.query(
        `
          INSERT INTO cost_lines(
            id, node_id, kind, catalogue_item_id, description,
            use_description, unit_cost, quantity, multiplier,
            fraction_included, size_inputs_json, calculation_json,
            subtotal, sort_order
          )
          VALUES (
            $1, $2, 'material', $3, 'Historical material', '',
            $4::numeric, 2, 1, 1, '{}'::jsonb, '{}'::jsonb,
            ($4::numeric * 2), 0
          )
        `,
        [randomUUID(), sourcePartId, catalogueItem.id, catalogueItem.fixed_cost],
      );
      const evidenceBytes = Buffer.from("verified historical evidence", "utf8");
      const evidenceId = randomUUID();
      const evidencePath = path.join(paths.uploadRoot, historicalProjectId, `${evidenceId}.txt`);
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, evidenceBytes);
      await postgres.database.query(
        `
          INSERT INTO evidence(
            id, node_id, project_id, kind, display_name, content_sha256,
            byte_size, storage_path, mime_type, visibility, report_caption
          )
          VALUES ($1, $2, $3, 'other', 'history.txt', $4, $5, $6,
                  'text/plain', 'report', 'Historical reference')
        `,
        [
          evidenceId,
          sourcePartId,
          historicalProjectId,
          createHash("sha256").update(evidenceBytes).digest("hex"),
          evidenceBytes.byteLength,
          toStoredDataPath(evidencePath, paths),
        ],
      );
    });

    afterAll(async () => {
      await postgres.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    });

    it("lists both seasons while keeping historical writes locked", async () => {
      expect((await listActiveProjects(postgres.database)).map(({ season }) => season)).toEqual([
        2026,
        2025,
      ]);
      await expect(getTeamWorkspaceId(postgres.database)).resolves.toBe(currentProjectId);
      await expect(
        assertProjectPermission(postgres.database, editor, historicalProjectId, "write"),
      ).rejects.toThrow("project-historical-read-only");
      await expect(
        assertProjectPermission(postgres.database, editor, historicalProjectId, "read"),
      ).resolves.toBe("editor");
      await expect(
        assertProjectPermission(
          postgres.database,
          editor,
          historicalProjectId,
          "write",
          { allowHistorical: true },
        ),
      ).resolves.toBe("editor");
    });

    it("previews and idempotently copies a subtree with internal evidence and lineage", async () => {
      await postgres.database.query("UPDATE cost_nodes SET drawing_required = false, image_required = false, image_requirement_reason = 'Standard bought component' WHERE id = $1", [sourceAssemblyId]);
      const request = {
        sourceProjectId: historicalProjectId,
        sourceNodeId: sourceAssemblyId,
        targetProjectId: currentProjectId,
        targetParentId: targetSystemId,
        includeDescendants: true,
        copyEvidence: true,
      };
      const before = await postgres.database.one<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM cost_nodes WHERE project_id = $1",
        [currentProjectId],
      );
      const preview = await previewProjectCopy(postgres.database, editor, request);
      expect(preview.conflicts).toEqual([]);
      expect(preview.totals).toMatchObject({ nodes: 2, costLines: 1, evidence: 1 });
      expect(
        await postgres.database.one<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM cost_nodes WHERE project_id = $1",
          [currentProjectId],
        ),
      ).toEqual(before);
      const commitInput = {
        ...request,
        previewHash: preview.previewHash,
        idempotencyKey: "copy-portability-test-1",
      };
      const committed = await commitProjectCopy(postgres.database, paths, editor, commitInput);
      expect(committed).toMatchObject({ copiedCostLines: 1, copiedEvidence: 1, alreadyCommitted: false });
      const repeated = await commitProjectCopy(postgres.database, paths, editor, commitInput);
      expect(repeated).toMatchObject({ operationId: committed.operationId, alreadyCommitted: true });
      const copiedRoot = await postgres.database.one<{ system_code: string; full_number: string }>(
        "SELECT system_code, full_number FROM cost_nodes WHERE id = $1",
        [committed.rootNodeId],
      );
      expect(copiedRoot).toEqual({ system_code: "DR", full_number: "E13-26-DR-010000-A" });
      expect(await postgres.database.one("SELECT drawing_required, image_required, image_requirement_reason FROM cost_nodes WHERE id = $1", [committed.rootNodeId])).toEqual({drawing_required:false,image_required:false,image_requirement_reason:"Standard bought component"});
      expect(
        await postgres.database.one<{ visibility: string }>(
          "SELECT visibility FROM evidence WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
          [currentProjectId],
        ),
      ).toEqual({ visibility: "internal" });
      expect(
        await postgres.database.one<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM cost_node_lineage WHERE target_project_id = $1",
          [currentProjectId],
        ),
      ).toEqual({ count: 2 });
    });

    it("exports deterministically, dry-runs, and restores a verified round trip", async () => {
      const first = await exportProjectArchive(postgres.database, paths, admin, currentProjectId);
      const second = await exportProjectArchive(postgres.database, paths, admin, currentProjectId);
      expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
      expect(first.manifestSha256).toBe(second.manifestSha256);
      const projectsBefore = await postgres.database.one<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM projects",
      );
      const target = {
        targetSeason: 2027,
        targetName: "Restored UC Motorsport 2027",
        targetEntryNumber: "E13",
        targetIsHistorical: false,
      };
      const preview = await previewProjectArchive(postgres.database, first.bytes, target);
      expect(preview.conflicts).toEqual([]);
      expect(
        await postgres.database.one<{ count: number }>("SELECT COUNT(*)::int AS count FROM projects"),
      ).toEqual(projectsBefore);
      const commitInput = {
        ...target,
        expectedArchiveSha256: first.archiveSha256,
        previewHash: preview.previewHash,
        idempotencyKey: "archive-portability-test-1",
      };
      const restored = await commitProjectArchive(
        postgres.database,
        paths,
        admin,
        first.bytes,
        commitInput,
      );
      expect(restored).toMatchObject({
        season: 2027,
        createdNodes: first.manifest.nodes.length,
        createdCostLines: first.manifest.costLines.length,
        createdEvidence: first.manifest.evidence.length,
        alreadyImported: false,
      });
      expect((await postgres.database.query("SELECT id FROM cost_nodes WHERE project_id = $1 AND drawing_required = false AND image_required = false AND image_requirement_reason = 'Standard bought component'", [restored.projectId])).rows).toHaveLength(1);
      const repeated = await commitProjectArchive(
        postgres.database,
        paths,
        admin,
        first.bytes,
        commitInput,
      );
      expect(repeated).toMatchObject({ projectId: restored.projectId, alreadyImported: true });
      const restoredEvidence = await postgres.database.one<{
        storage_path: string;
        content_sha256: string;
      }>(
        "SELECT storage_path, content_sha256 FROM evidence WHERE project_id = $1 LIMIT 1",
        [restored.projectId],
      );
      expect(
        createHash("sha256")
          .update(await readFile(resolveStoredDataPath(restoredEvidence.storage_path, paths)))
          .digest("hex"),
      ).toBe(restoredEvidence.content_sha256);
    });

    it("stores a historical PDF sidecar idempotently and rejects same-name hash drift", async () => {
      const bytes = Buffer.from("%PDF-1.4\n% verified sidecar\n", "ascii");
      const file = {
        fieldname: "file",
        originalname: "historical-evidence-chunk-999.pdf",
        encoding: "7bit",
        mimetype: "application/pdf",
        size: bytes.byteLength,
        buffer: bytes,
        destination: "",
        filename: "historical-evidence-chunk-999.pdf",
        path: "",
        stream: undefined as never,
      } satisfies Express.Multer.File;
      const input = {
        kind: "other",
        visibility: "report",
        reportCaption: "Verified historical source pages",
      };
      const first = await storeEvidenceIdempotently(
        postgres.database,
        paths,
        admin,
        historicalProjectId,
        file,
        input,
        { allowHistorical: true },
      );
      const second = await storeEvidenceIdempotently(
        postgres.database,
        paths,
        admin,
        historicalProjectId,
        file,
        input,
        { allowHistorical: true },
      );
      expect(first.alreadyStored).toBe(false);
      expect(second).toMatchObject({
        alreadyStored: true,
        evidence: { id: first.evidence.id },
      });
      expect(
        await postgres.database.one<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM evidence WHERE project_id = $1 AND display_name = $2",
          [historicalProjectId, file.originalname],
        ),
      ).toEqual({ count: 1 });

      const changed = {
        ...file,
        size: bytes.byteLength + 1,
        buffer: Buffer.concat([bytes, Buffer.from("x")]),
      };
      await expect(
        storeEvidenceIdempotently(
          postgres.database,
          paths,
          admin,
          historicalProjectId,
          changed,
          input,
          { allowHistorical: true },
        ),
      ).rejects.toThrow("archive-sidecar-identity-conflict");
    });

    it("rejects unsafe archive paths before extraction", async () => {
      const unsafe = zipSync({
        "../outside": strToU8("no"),
        "manifest.json": strToU8("{}"),
      });
      await expect(
        previewProjectArchive(postgres.database, unsafe, {
          targetSeason: 2028,
          targetName: "Unsafe archive",
          targetEntryNumber: "E13",
          targetIsHistorical: false,
        }),
      ).rejects.toThrow("archive-path-not-allowed");
    });
  },
);
