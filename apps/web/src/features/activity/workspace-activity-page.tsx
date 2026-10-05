import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Clock3, Hash, LoaderCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api, type AuditEntry } from "@/lib/api"

export function WorkspaceActivityPage({ projectId }: { projectId: string }) {
  const activity = useQuery({
    queryKey: ["workspace-activity", projectId],
    queryFn: () => api.workspaceActivity(projectId),
  })
  const [additionalEntries, setAdditionalEntries] = useState<AuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)

  useEffect(() => {
    setAdditionalEntries([])
    setNextCursor(activity.data?.nextCursor ?? null)
  }, [activity.data])

  const loadMore = useMutation({
    mutationFn: () => api.workspaceActivity(projectId, nextCursor!),
    onSuccess: (result) => {
      setAdditionalEntries((current) => [...current, ...result.entries])
      setNextCursor(result.nextCursor)
    },
  })

  const entries = [...(activity.data?.entries ?? []), ...additionalEntries]

  if (activity.isLoading) {
    return (
      <div
        className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" />
        Loading activity…
      </div>
    )
  }

  if (activity.isError) {
    return (
      <Alert variant="destructive">
        <Clock3 />
        <AlertTitle>Could not load activity</AlertTitle>
        <AlertDescription>
          {activity.error instanceof Error
            ? activity.error.message
            : "Request failed"}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity ledger</CardTitle>
        <p className="text-sm text-muted-foreground">
          These entries are returned from the append-only, hash-linked server
          ledger. Times are server-recorded.
        </p>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No ledger entries are available yet.
          </div>
        ) : (
          <ol className="space-y-3" aria-label="Activity entries">
            {entries.map((entry) => (
              <li key={entry.sequence} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {humanizeAction(entry.action)}
                      </span>
                      <Badge variant="outline">
                        Sequence {entry.sequence}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entry.actor
                        ? `${entry.actor.displayName} · ${entry.actor.email}`
                        : "System actor"}{" "}
                      ·{" "}
                      <time dateTime={entry.occurredAt}>
                        {new Date(entry.occurredAt).toLocaleString("en-NZ")}
                      </time>
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{entry.entityType}</div>
                    <div className="mt-0.5 max-w-64 truncate font-mono">
                      {entry.entityId}
                    </div>
                  </div>
                </div>
                <details className="mt-3 rounded-md bg-muted/30 p-3 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Integrity and change details
                  </summary>
                  <dl className="mt-3 grid gap-3">
                    <div>
                      <dt className="flex items-center gap-1 text-muted-foreground">
                        <Hash className="size-3" />
                        Entry hash
                      </dt>
                      <dd className="mt-1 break-all font-mono">
                        {entry.entryHash}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Previous hash</dt>
                      <dd className="mt-1 break-all font-mono">
                        {entry.previousHash ?? "Genesis entry"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Request ID</dt>
                      <dd className="mt-1 break-all font-mono">
                        {entry.requestId}
                      </dd>
                    </div>
                    <LedgerJson label="Before" value={entry.before} />
                    <LedgerJson label="After" value={entry.after} />
                    <LedgerJson label="Metadata" value={entry.metadata} />
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        )}
        {nextCursor && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => loadMore.mutate()}
              disabled={loadMore.isPending}
            >
              {loadMore.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              Load older activity
            </Button>
          </div>
        )}
        {loadMore.isError && (
          <p className="mt-3 text-center text-sm text-destructive" role="alert">
            {loadMore.error instanceof Error
              ? loadMore.error.message
              : "Older activity could not be loaded."}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function LedgerJson({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-[11px]">
          {JSON.stringify(value, null, 2)}
        </pre>
      </dd>
    </div>
  )
}

function humanizeAction(action: string): string {
  const words = action.replace(/[._-]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
