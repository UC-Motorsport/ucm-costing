import { AlertTriangle, Download, Hash, LoaderCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  artifactName,
  issuesFromError,
} from "@/features/reports/workflow-utils"
import { type Artifact, type WorkflowIssue } from "@/lib/api"

export function ArtifactList({
  artifacts,
  loading,
  empty,
}: {
  artifacts: Artifact[]
  loading: boolean
  empty: string
}) {
  if (loading) return <LoadingRows label="Loading artifacts…" />
  if (artifacts.length === 0) return <EmptyState>{empty}</EmptyState>

  return (
    <div className="divide-y rounded-lg border">
      {artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className="flex flex-wrap items-center justify-between gap-3 p-3"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {artifactName(artifact)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {new Date(artifact.created_at).toLocaleString("en-NZ")} ·{" "}
              {artifact.byte_size
                ? `${(Number(artifact.byte_size) / 1024).toFixed(1)} KB`
                : artifact.status}
            </div>
            {artifact.content_sha256 && (
              <div className="mt-1 flex max-w-xl items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
                <Hash className="size-3 shrink-0" />
                SHA-256 {artifact.content_sha256}
              </div>
            )}
          </div>
          {artifact.downloadUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={artifact.downloadUrl}>
                <Download />
                Download
              </a>
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

export function WorkflowIssues({ issues }: { issues: WorkflowIssue[] }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Final lock blocked</AlertTitle>
      <AlertDescription>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {issues.map((issue) => (
            <li key={issue.code}>
              {issue.message}{" "}
              <code className="text-[10px]">({issue.code})</code>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function MutationError({ error }: { error: unknown }) {
  if (!error) return null
  const issues = issuesFromError(error)

  return (
    <Alert variant="destructive" className="mt-3">
      <AlertTriangle />
      <AlertTitle>Operation could not be completed</AlertTitle>
      <AlertDescription>
        <p>{error instanceof Error ? error.message : "Request failed"}</p>
        {issues.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function LoadingRows({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircle className="size-4 animate-spin" />
      {label}
    </div>
  )
}
