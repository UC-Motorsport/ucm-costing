import { useId, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  FolderCog,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  ApiError,
  api,
  type CostNode,
  type Meta,
} from "@/lib/api"

interface SystemManagementDialogProps {
  canWrite: boolean
  projectId: string
  vehicle: CostNode
  definitions: Meta["systems"]
}

export function SystemManagementDialog({
  canWrite,
  projectId,
  vehicle,
  definitions,
}: SystemManagementDialogProps) {
  const fieldId = useId()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [removalTarget, setRemovalTarget] = useState<CostNode | null>(null)
  const [customFormOpen, setCustomFormOpen] = useState(false)
  const [customCode, setCustomCode] = useState("")
  const [customName, setCustomName] = useState("")
  const systems = vehicle.children.filter((node) => node.kind === "system")
  const defaultCodes = new Set(definitions.map(({ code }) => code))
  const systemsByCode = new Map(
    systems.flatMap((system) =>
      system.system_code ? [[system.system_code, system] as const] : [],
    ),
  )
  const customSystems = systems.filter(
    (system) =>
      system.system_code && !defaultCodes.has(system.system_code),
  )

  const refreshWorkspace = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
      queryClient.invalidateQueries({
        queryKey: ["validation", projectId],
      }),
    ])
  }

  const addSystem = useMutation({
    mutationFn: (
      definition: Meta["systems"][number] & { custom?: boolean },
    ) =>
      api.createNode(vehicle.id, {
        expectedParentVersion: vehicle.version,
        kind: "system",
        systemCode: definition.code,
        name: definition.name,
        description: `${definition.name} system.`,
      }),
    onSuccess: async ({ node }, definition) => {
      toast.success(`${node.name} added`)
      await refreshWorkspace()
      if (definition.custom) {
        setCustomFormOpen(false)
        setCustomCode("")
        setCustomName("")
      }
    },
    onError: showMutationError,
  })

  const removeSystem = useMutation({
    mutationFn: (system: CostNode) =>
      api.deleteNode(system.id, system.version, true),
    onSuccess: async (_result, system) => {
      toast.success(`${system.name} removed`)
      setRemovalTarget(null)
      await refreshWorkspace()
    },
    onError: showMutationError,
  })

  const removingDescendants = removalTarget
    ? countDescendants(removalTarget)
    : 0
  const removingCostLines = removalTarget
    ? countCostLines(removalTarget)
    : 0
  const normalizedCustomCode = customCode.trim().toUpperCase()
  const normalizedCustomName = customName.trim()
  const reservedDefinition = definitions.find(
    ({ code }) => code === normalizedCustomCode,
  )
  const customCodeError =
    normalizedCustomCode === ""
      ? "Enter a short code."
      : !/^[A-Z][A-Z0-9]{1,2}$/.test(normalizedCustomCode)
        ? "Use 2–3 uppercase letters or numbers, starting with a letter."
        : reservedDefinition
          ? `${normalizedCustomCode} is the ${reservedDefinition.name} preset. Add that default instead.`
          : systemsByCode.has(normalizedCustomCode)
            ? "That code is already used in this vehicle."
            : null
  const customNameError =
    normalizedCustomName === "" ? "Enter a system name." : null
  const hasCustomDraft =
    customFormOpen && (customCode !== "" || customName !== "")

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (
          !nextOpen &&
          (addSystem.isPending || removeSystem.isPending || hasCustomDraft)
        ) {
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) {
          setRemovalTarget(null)
          setCustomFormOpen(false)
        }
      }}
    >
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label="Manage vehicle systems"
      >
        <FolderCog />
        <span className="hidden sm:inline">Manage systems</span>
        <span className="sm:hidden">Systems</span>
      </Button>
      <DialogContent
        className="max-h-[90vh] overflow-hidden sm:max-w-xl"
        showCloseButton={!hasCustomDraft}
      >
        {removalTarget ? (
          <>
            <DialogHeader>
              <DialogTitle>Remove {removalTarget.name}?</DialogTitle>
              <DialogDescription>
                This removes the system from the editable vehicle hierarchy
                and recalculates every workspace total.
              </DialogDescription>
            </DialogHeader>

            <Alert variant="destructive">
              <Trash2 />
              <AlertTitle>This cannot be undone in the live BOM</AlertTitle>
              <AlertDescription>
                {removingDescendants === 0
                  ? "The system is empty."
                  : `${removingDescendants} descendant${
                      removingDescendants === 1 ? "" : "s"
                    } will also be deleted.`}{" "}
                {removingCostLines > 0
                  ? `${removingCostLines} cost line${
                      removingCostLines === 1 ? "" : "s"
                    } and any attached evidence in this system are included.`
                  : "Any attached evidence in this system is included."}{" "}
                Generated report snapshots remain unchanged.
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRemovalTarget(null)}
                disabled={removeSystem.isPending}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                onClick={() => removeSystem.mutate(removalTarget)}
                disabled={removeSystem.isPending}
              >
                {removeSystem.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
                Remove system and contents
              </Button>
            </DialogFooter>
          </>
        ) : customFormOpen ? (
          <>
            <DialogHeader>
              <DialogTitle>Add custom system</DialogTitle>
              <DialogDescription>
                Use this only when the vehicle area does not fit one of the
                nine spreadsheet defaults.
              </DialogDescription>
            </DialogHeader>

            <FieldGroup className="grid gap-4 sm:grid-cols-[140px_1fr]">
              <Field
                data-invalid={
                  customCode !== "" && customCodeError !== null
                }
              >
                <FieldLabel htmlFor={`${fieldId}-custom-code`}>
                  Short code
                </FieldLabel>
                <Input
                  id={`${fieldId}-custom-code`}
                  value={customCode}
                  onChange={(event) =>
                    setCustomCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .slice(0, 3),
                    )
                  }
                  maxLength={3}
                  placeholder="e.g. CO"
                  className="font-mono uppercase"
                  aria-invalid={
                    customCode !== "" && customCodeError !== null
                  }
                  autoFocus
                />
                <FieldDescription>2–3 characters</FieldDescription>
                {customCode !== "" && customCodeError && (
                  <FieldError>{customCodeError}</FieldError>
                )}
              </Field>

              <Field
                data-invalid={
                  customName !== "" && customNameError !== null
                }
              >
                <FieldLabel htmlFor={`${fieldId}-custom-name`}>
                  System name
                </FieldLabel>
                <Input
                  id={`${fieldId}-custom-name`}
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  maxLength={200}
                  placeholder="e.g. Cooling"
                  aria-invalid={
                    customName !== "" && customNameError !== null
                  }
                />
                <FieldDescription>
                  Use the name the team uses in drawings and reports.
                </FieldDescription>
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setCustomFormOpen(false)
                  setCustomCode("")
                  setCustomName("")
                }}
                disabled={addSystem.isPending}
              >
                Back
              </Button>
              <Button
                onClick={() =>
                  addSystem.mutate({
                    code: normalizedCustomCode,
                    name: normalizedCustomName,
                    custom: true,
                  })
                }
                disabled={
                  addSystem.isPending ||
                  customCodeError !== null ||
                  customNameError !== null
                }
              >
                {addSystem.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus />
                )}
                Create system
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Manage vehicle systems</DialogTitle>
              <DialogDescription>
                Every workspace starts with the nine spreadsheet systems.
                Most teams can leave these defaults unchanged.
              </DialogDescription>
            </DialogHeader>

            <div
              className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border"
              role="list"
              aria-label="Vehicle systems"
            >
              {definitions.map((definition) => {
                const system = systemsByCode.get(definition.code)
                const isAdding =
                  addSystem.isPending &&
                  addSystem.variables?.code === definition.code

                return (
                  <SystemListRow
                    key={definition.code}
                    definition={definition}
                    system={system}
                    canWrite={canWrite}
                    custom={false}
                    pending={
                      addSystem.isPending || removeSystem.isPending
                    }
                    isAdding={isAdding}
                    onAdd={() => addSystem.mutate(definition)}
                    onRemove={() => system && setRemovalTarget(system)}
                  />
                )
              })}
              {customSystems.map((system) => (
                <SystemListRow
                  key={system.id}
                  definition={{
                    code: system.system_code!,
                    name: system.name,
                  }}
                  system={system}
                  canWrite={canWrite}
                  custom
                  pending={addSystem.isPending || removeSystem.isPending}
                  isAdding={false}
                  onAdd={() => undefined}
                  onRemove={() => setRemovalTarget(system)}
                />
              ))}
            </div>

            {canWrite ? (
              <Button
                variant="outline"
                className="justify-self-start"
                onClick={() => setCustomFormOpen(true)}
                disabled={addSystem.isPending || removeSystem.isPending}
              >
                <Plus />
                Add custom system
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                This workspace is read-only. Reopen a submitted workspace or
                ask an editor to change its systems.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SystemListRow({
  definition,
  system,
  canWrite,
  custom,
  pending,
  isAdding,
  onAdd,
  onRemove,
}: {
  definition: Meta["systems"][number]
  system?: CostNode
  canWrite: boolean
  custom: boolean
  pending: boolean
  isAdding: boolean
  onAdd: () => void
  onRemove: () => void
}) {
  const descendantCount = system ? countDescendants(system) : 0

  return (
    <div
      className="flex min-h-14 items-center gap-3 px-3 py-2"
      role="listitem"
    >
      <Badge
        variant="outline"
        className="w-10 justify-center font-mono"
      >
        {definition.code}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          <span className="truncate">{definition.name}</span>
          {custom && (
            <Badge variant="secondary" className="h-5 shrink-0">
              Custom
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {system
            ? `${descendantCount} item${
                descendantCount === 1 ? "" : "s"
              } below this system`
            : "Not included in this vehicle"}
        </p>
      </div>
      {system ? (
        <>
          {!custom && (
            <span className="hidden items-center gap-1 text-xs text-emerald-700 sm:flex">
              <Check className="size-3.5" />
              Included
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={!canWrite || pending}
            aria-label={`Remove ${definition.name}`}
          >
            <Trash2 />
            Remove
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={!canWrite || pending}
          aria-label={`Add ${definition.name}`}
        >
          {isAdding ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Plus />
          )}
          Add
        </Button>
      )}
    </div>
  )
}

function countDescendants(node: CostNode): number {
  return node.children.reduce(
    (count, child) => count + 1 + countDescendants(child),
    0,
  )
}

function countCostLines(node: CostNode): number {
  return (
    node.costLines.length +
    node.children.reduce(
      (count, child) => count + countCostLines(child),
      0,
    )
  )
}

function showMutationError(error: unknown) {
  toast.error(
    error instanceof ApiError || error instanceof Error
      ? error.message
      : "Request failed",
  )
}
