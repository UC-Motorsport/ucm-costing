import { useMutation } from "@tanstack/react-query"
import { ArrowDown, ArrowUp } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ApiError, api, type CostNode } from "@/lib/api"

export function NodeChildrenList({
  parent,
  readOnly,
  onOpen,
  onReordered,
  onRefresh,
}: {
  parent: CostNode
  readOnly: boolean
  onOpen: (childId: string, parentId: string) => void
  onReordered: (previousVersion: number, parentVersion: number) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const reorder = useMutation({
    mutationFn: ({
      childIds,
      expectedVersion,
    }: {
      childIds: string[]
      expectedVersion: number
    }) => api.reorderNodeChildren(parent.id, expectedVersion, childIds),
    onSuccess: async (result, input) => {
      await onReordered(input.expectedVersion, result.parentVersion)
      toast.success("Child order saved")
    },
    onError: async (error) => {
      if (
        error instanceof ApiError &&
        (error.code === "version-conflict" ||
          error.code === "invalid-node-child-order")
      ) {
        toast.error(
          "The children changed elsewhere. The latest order has been loaded; try your move again.",
        )
        await onRefresh()
      } else {
        toast.error(error.message)
      }
    },
  })
  const canReorder = !readOnly && parent.children.length > 1
  const move = (index: number, direction: -1 | 1) => {
    const childIds = parent.children.map((child) => child.id)
    const destination = index + direction
    if (destination < 0 || destination >= childIds.length) return
    ;[childIds[index], childIds[destination]] = [
      childIds[destination]!,
      childIds[index]!,
    ]
    reorder.mutate({ childIds, expectedVersion: parent.version })
  }

  return (
    <div className="mt-4">
      {canReorder && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {reorder.isPending
            ? "Saving child order…"
            : reorder.isSuccess
              ? "Order saved. Use the arrows to rearrange children."
              : "Use the arrows to rearrange children. Changes save automatically."}
        </p>
      )}
      <ol
        aria-label={`Children of ${parent.name}`}
        className="divide-y rounded-lg border"
      >
        {parent.children.map((child, index) => (
          <li
            key={child.id}
            className="flex items-center gap-2 px-3 py-3 sm:gap-3"
          >
            <span
              className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={child.name}>
                {child.name}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="shrink-0 capitalize">
                  {child.kind}
                </Badge>
                <span
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={child.full_number ?? child.reference_id ?? undefined}
                >
                  {child.full_number ??
                    child.reference_id ??
                    "Number not assigned"}
                </span>
              </div>
            </div>
            {canReorder && (
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move ${child.name} up`}
                  title="Move up"
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move ${child.name} down`}
                  title="Move down"
                  disabled={
                    index === parent.children.length - 1 || reorder.isPending
                  }
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={reorder.isPending}
              onClick={() => onOpen(child.id, parent.id)}
            >
              Open
            </Button>
          </li>
        ))}
      </ol>
    </div>
  )
}
