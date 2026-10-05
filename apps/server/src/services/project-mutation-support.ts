import type {
  DbExecutor,
  TransactionHandle,
} from "../db/database";
import { VersionConflictError } from "./project-lifecycle-service";

export async function lockProjectForMutation(
  transaction: TransactionHandle,
  projectId: string,
): Promise<void> {
  const project = await transaction.maybeOne<{ id: string }>(
    "SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
}

export async function touchProject(
  transaction: TransactionHandle,
  projectId: string,
  actorUserId: string,
): Promise<void> {
  const touched = await transaction.query(
    `
      UPDATE projects
      SET version = version + 1, updated_by = $1, updated_at = now()
      WHERE id = $2
      RETURNING id
    `,
    [actorUserId, projectId],
  );
  if (touched.rowCount !== 1) {
    throw new Error("project-not-found");
  }
}

export function assertExpectedVersion(
  actual: number,
  expected: number,
  entityName: string,
): void {
  if (actual !== expected) {
    throw new VersionConflictError(
      `${entityName} changed from version ${expected} to ${actual}`,
    );
  }
}

export async function projectIdForNode(
  database: DbExecutor,
  nodeId: string,
): Promise<string> {
  const row = await database.maybeOne<{ project_id: string }>(
    "SELECT project_id FROM cost_nodes WHERE id = $1",
    [nodeId],
  );
  if (!row) {
    throw new Error("node-not-found");
  }
  return row.project_id;
}
