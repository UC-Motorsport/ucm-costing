import type { ReactNode } from "react"
import { CircleAlert, LoaderCircle, RotateCw } from "lucide-react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface QueryErrorProps {
  error?: unknown
  title?: ReactNode
  description?: ReactNode
  onRetry?: () => unknown | Promise<unknown>
  retryLabel?: string
  isRetrying?: boolean
  compact?: boolean
  className?: string
}

export function QueryError({
  error,
  title = "Could not load data",
  description,
  onRetry,
  retryLabel = "Retry",
  isRetrying = false,
  compact = false,
  className,
}: QueryErrorProps) {
  const detail =
    description ??
    queryErrorMessage(
      error,
      "The request failed. Check the connection and try again.",
    )

  return (
    <Alert
      variant="destructive"
      className={cn(
        "border-red-200 bg-red-50/70 text-red-950",
        compact ? "py-2.5" : "p-4",
        className,
      )}
      aria-atomic="true"
      aria-busy={isRetrying || undefined}
    >
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div>{detail}</div>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 border-red-300 bg-white text-red-950 hover:bg-red-100"
            onClick={() => void onRetry()}
            disabled={isRetrying}
          >
            {isRetrying ? (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RotateCw data-icon="inline-start" aria-hidden="true" />
            )}
            {isRetrying ? "Retrying…" : retryLabel}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function queryErrorMessage(
  error: unknown,
  fallback = "The request failed.",
): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === "string" && error.trim()) {
    return error
  }
  return fallback
}
