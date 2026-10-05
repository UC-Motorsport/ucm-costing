import type { AuditContext } from "../audit/audit-ledger";
import type { Queryable } from "../db/database";
import type { SystemRole } from "./auth-service";

export type ProjectRole = "owner" | "editor" | "viewer";
export type ProjectPermission = "read" | "write" | "administer";

export interface ActorContext extends AuditContext {
  actorUserId: string;
  systemRole: SystemRole;
}

export interface ProjectPermissionOptions {
  /**
   * Archive and restore are the only mutations allowed to address an archived
   * project. Every other write must restore the project first.
   */
  allowArchived?: boolean;
  /**
   * The explicit project lifecycle reopen operation is the only application
   * mutation allowed to address a submitted project. Callers must opt in; all
   * ordinary write/administer checks fail closed.
   */
  allowSubmitted?: boolean;
  /**
   * Dedicated import/copy maintenance may populate a historical workspace
   * without making ordinary historical mutations available.
   */
  allowHistorical?: boolean;
}

export async function assertProjectPermission(
  database: Queryable,
  actor: ActorContext,
  projectId: string,
  permission: ProjectPermission,
  options: ProjectPermissionOptions = {},
): Promise<ProjectRole | "system-admin"> {
  const project = await database.maybeOne<{
    archived_at: string | null;
    status: "draft" | "review" | "submitted";
    is_historical: boolean;
  }>(
    `
      SELECT archived_at, status, is_historical
      FROM projects
      WHERE id = $1
      ${permission === "read" ? "" : "FOR SHARE"}
    `,
    [projectId],
  );
  if (!project) {
    throw new Error("project-not-found");
  }
  if (
    permission !== "read" &&
    project.is_historical &&
    !options.allowHistorical
  ) {
    throw new Error("project-historical-read-only");
  }
  if (
    permission !== "read" &&
    project.archived_at &&
    !options.allowArchived
  ) {
    throw new Error("project-archived-read-only");
  }
  if (
    permission !== "read" &&
    project.status === "submitted" &&
    !options.allowSubmitted
  ) {
    throw new Error("project-submitted-read-only");
  }
  if (actor.systemRole === "admin") {
    return "system-admin";
  }
  if (permission === "administer") {
    throw new Error("permission-denied");
  }
  if (permission === "write" && actor.systemRole === "viewer") {
    throw new Error("permission-denied");
  }
  return actor.systemRole;
}
