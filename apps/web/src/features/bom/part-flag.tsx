import { useId, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleCheck, CircleMinus, Flag, MessageSquare } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { api, ApiError, type CostNode } from "@/lib/api"
import { cn } from "@/lib/utils"

const statusLabels = {
  none: "No status",
  "needs-attention": "Needs attention",
  done: "Done",
} as const

type WorkStatus = keyof typeof statusLabels

export function PartFlag({ node, canWrite }: { node: CostNode; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WorkStatus>("none")
  const [comment, setComment] = useState("")
  const [baseVersion, setBaseVersion] = useState(node.version)
  const [conflict, setConflict] = useState(false)
  const currentStatus = node.work_status ?? "none"
  const label = statusLabels[currentStatus]
  const Icon = currentStatus === "done" ? CircleCheck : Flag

  const loadLatest = () => {
    setStatus(node.work_status ?? "none")
    setComment(node.flag_comment ?? "")
    setBaseVersion(node.version)
    setConflict(false)
    save.reset()
  }
  const save = useMutation({
    mutationFn: () => api.updateNode(node.id, {
      expectedVersion: baseVersion,
      workStatus: status,
      flagComment: comment,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspace"] })
      setOpen(false)
      toast.success("Part status saved")
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "version-conflict") {
        setConflict(true)
        await queryClient.invalidateQueries({ queryKey: ["workspace"] })
      }
    },
  })

  if (node.kind !== "part") return null

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (save.isPending) return
      if (next) loadLatest()
      setOpen(next)
    }}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("mr-1 shrink-0", currentStatus === "needs-attention" ? "text-amber-700" : currentStatus === "done" ? "text-emerald-700" : "text-muted-foreground")}
          aria-label={`Part status for ${node.name}: ${label}${node.flag_comment ? ", has comment" : ""}`}
          title={`${label}${node.flag_comment ? `: ${node.flag_comment}` : " — add a flag or comment"}`}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Icon aria-hidden="true" />
          {node.flag_comment ? <span className="sr-only">Has comment</span> : null}
        </Button>
      </DialogTrigger>
      <DialogContent onDoubleClick={(event) => event.stopPropagation()} showCloseButton={!save.isPending}>
        <DialogHeader>
          <DialogTitle>Part status</DialogTitle>
          <DialogDescription className="break-words">{node.name}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault()
          if (canWrite && !conflict && !save.isPending) save.mutate()
        }}>
          <fieldset className="space-y-2" disabled={!canWrite || save.isPending}>
            <legend className="text-sm font-medium">Status</legend>
            <div className="grid grid-cols-3 gap-2">
              {(["none", "needs-attention", "done"] as const).map((value) => {
                const StatusIcon = value === "done" ? CircleCheck : value === "needs-attention" ? Flag : CircleMinus
                return (
                  <label key={value} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${id}-status`}
                      value={value}
                      checked={status === value}
                      onChange={() => setStatus(value)}
                      className="peer sr-only"
                    />
                    <span className={cn(
                      "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border px-1.5 py-2 text-center text-xs font-medium transition-colors hover:bg-muted peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:cursor-default peer-disabled:opacity-60",
                      status === value
                        ? value === "needs-attention"
                          ? "border-amber-600 bg-amber-50 text-amber-800 hover:bg-amber-50"
                          : value === "done"
                            ? "border-emerald-600 bg-emerald-50 text-emerald-800 hover:bg-emerald-50"
                            : "border-foreground bg-muted text-foreground"
                        : "border-input text-muted-foreground",
                    )}>
                      <StatusIcon className="size-4" aria-hidden="true" />
                      {statusLabels[value]}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor={`${id}-comment`}><MessageSquare className="size-4" />Comment (optional)</Label>
            <Textarea id={`${id}-comment`} value={comment} readOnly={!canWrite} disabled={save.isPending} maxLength={2000} rows={4} onChange={(event) => setComment(event.target.value)} placeholder="What should the team know?" />
            <p className="text-xs text-muted-foreground">{comment.length}/2000 characters. This status does not change validation blockers.</p>
          </div>
          {save.isError ? <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{conflict ? "This part changed elsewhere. Your draft has been kept. Reload the latest status before editing again." : "Could not save the status. Your draft has been kept; please try again."}</p>
            {conflict ? <Button type="button" variant="outline" onClick={loadLatest}>Reload latest status</Button> : null}
          </div> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>{canWrite ? "Cancel" : "Close"}</Button>
            {canWrite ? <Button type="submit" disabled={save.isPending || conflict}>{save.isPending ? "Saving…" : "Save status"}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
