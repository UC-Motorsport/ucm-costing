import {
  ApiError,
  type Artifact,
  type WorkflowIssue,
} from "@/lib/api"

export function artifactName(artifact: Artifact): string {
  const filename = artifact.metadata_json.filename
  return typeof filename === "string" && filename
    ? filename
    : `${artifact.kind} ${artifact.id}`
}

export function issuesFromError(error: unknown): WorkflowIssue[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) {
    return []
  }
  return error.details.filter(
    (issue): issue is WorkflowIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as WorkflowIssue).code === "string" &&
      typeof (issue as WorkflowIssue).message === "string",
  )
}

export function workflowMutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed"
}
