import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import {
  allowedChildKinds,
  canCreateChild,
  canNodeOwnCostLines,
  extendCostBreakdown,
  type NodeKind,
} from "@ucm/domain"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRightLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { PreviousCosting } from "./previous-costing"
import { StockSizePicker } from "@/features/catalogue/stock-size-picker"
import { Import2025CostLineDialog } from "@/features/bom/import-2025-cost-dialog"
import { ControlledIdentifier } from "@/features/bom/controlled-identifier"
import {
  composeControlledNumber,
  referenceWithSide,
  nodeSide,
  findNumberConflict,
  isControlledNumberForContext,
  parseControlledNumber,
  suggestControlledReference,
} from "@/features/bom/controlled-identifier-utils"
import {
  fixedRateAmountDescription,
  fixedRateAmountLabel,
  formatFixedRateAmount,
} from "@/features/catalogue/catalogue-measure"
import {
  CatalogueProvenanceBadge,
} from "@/features/catalogue/catalogue-provenance"
import { catalogueSourceDescription } from "@/features/catalogue/catalogue-source"
import { evidenceKindLabel } from "@/features/evidence/evidence-kind-label"
import { EvidenceList } from "@/features/evidence/evidence-list"
import { NodeChildrenList } from "@/features/bom/node-children-list"
import { SystemAssemblyTree } from "@/features/bom/system-assembly-tree"
import {
  resolveValidationIssueTarget,
  type NodeEditorSection,
} from "@/features/validation/issue-target"
import { useUnsavedChangesRegistration } from "@/hooks/use-unsaved-changes"
import {
  ApiError,
  api,
  universal,
  type CatalogueItem,
  type CostLine,
  type CostNode,
  type Evidence,
  type ProjectDetail,
  type ValidationIssue,
} from "@/lib/api"
import { cn } from "@/lib/utils"

type EditableNodeKind = Extract<
  NodeKind,
  "assembly" | "subassembly" | "part"
>
type CostKind = CostLine["kind"]
type NodeEditorTab = "details" | "costing" | "evidence" | "children"

const costKinds: readonly CostKind[] = [
  "material",
  "process",
  "fastener",
  "tooling",
]
const toolingProductionClasses = [
  {
    value: "3000",
    label: "Standard tooling · PVF 3000",
  },
  {
    value: "120",
    label: "Composite monocoque · PVF 120",
  },
] as const

const costKindDotClasses = {
  material: "bg-sky-500",
  process: "bg-amber-500",
  fastener: "bg-violet-500",
  tooling: "bg-emerald-500",
} satisfies Record<CostKind, string>

const evidenceRequirements = [
  {
    kind: "image",
    label: "Isometric image",
    description: "3D render or clear photo.",
    required: true,
  },
  {
    kind: "drawing",
    label: "Technical drawing",
    description: "Dimensioned PDF or image.",
    required: true,
  },
  {
    kind: "datasheet",
    label: "Component datasheet",
    description: "For electrical components.",
    required: false,
  },
] as const satisfies readonly {
  kind: Evidence["kind"]
  label: string
  description: string
  required: boolean
}[]

const requiredEvidenceCount = evidenceRequirements.filter(
  ({ required }) => required,
).length

const additionalEvidenceKinds = [
  "manufacturing",
  "bulk-deviation",
  "other",
] as const satisfies readonly Evidence["kind"][]

interface EvidenceUploadDraft {
  files: File[]
  caption: string
}

const emptyEvidenceUploadDraft: EvidenceUploadDraft = {
  files: [],
  caption: "",
}

export interface NodeEditorWorkspaceProps {
  node: CostNode
  nodes: readonly CostNode[]
  project: ProjectDetail["project"]
  readOnly?: boolean
  validationIssues?: ValidationIssue[]
  initialSection?: NodeEditorSection | "default"
  onClose: () => void
  backLabel?: string
  previousNode?: CostNode | null
  nextNode?: CostNode | null
  onNavigate?: (nodeId: string) => void
  visual?: (actions: {
    chooseEvidenceFile: (kind: "image" | "drawing") => void
    canUploadEvidence: boolean
  }) => ReactNode
  onCreated: (
    nodeId: string,
    parentId: string,
    savedDraftKey?: string,
  ) => void
  onDeleted: (nodeId: string) => void
}

export function NodeEditorWorkspace({
  node,
  nodes,
  project,
  readOnly = false,
  validationIssues = [],
  initialSection = "default",
  onClose,
  backLabel = "Back to bill of materials",
  previousNode = null,
  nextNode = null,
  onNavigate,
  visual,
  onCreated,
  onDeleted,
}: NodeEditorWorkspaceProps) {
  const queryClient = useQueryClient()
  const fieldId = useId()
  const tabsListRef = useRef<HTMLDivElement>(null)
  const imageEvidenceInputRef = useRef<HTMLInputElement>(null)
  const drawingEvidenceInputRef = useRef<HTMLInputElement>(null)
  const childKinds = useMemo(
    () =>
      allowedChildKinds(node.kind).filter(
        (kind): kind is EditableNodeKind =>
          kind === "assembly" ||
          kind === "subassembly" ||
          kind === "part",
      ),
    [node.kind],
  )
  const oppositeParent =
    node.kind === "part" &&
    nodeSide(node) &&
    parseControlledNumber(node.full_number ?? "")
      ? nodes.find((candidate) => candidate.id === node.parent_id)
      : undefined
  const supportsCosting = canNodeOwnCostLines(node.kind)
  const supportsChildren = childKinds.length > 0
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [revision, setRevision] = useState("")
  const [fullNumber, setFullNumber] = useState("")
  const [referenceId, setReferenceId] = useState("")
  const [internalNote, setInternalNote] = useState("")
  const [saveConflict, setSaveConflict] = useState(false)
  const [baseVersion, setBaseVersion] = useState(node.version)
  const [procurement, setProcurement] =
    useState<CostNode["procurement_type"]>("unknown")
  const [activeTab, setActiveTab] = useState<NodeEditorTab>(() =>
    availableTabForEditorSection(
      initialSection,
      supportsCosting,
      supportsChildren,
    ),
  )

  // Refreshes caused by cost/evidence mutations must not erase unsaved record
  // edits. Switching to another node intentionally resets the draft.
  useEffect(() => {
    setName(node.name)
    setDescription(node.description)
    setQuantity(node.quantity)
    setRevision(node.revision ?? "")
    setFullNumber(node.full_number ?? "")
    setReferenceId(node.reference_id ?? "")
    setInternalNote(node.internal_note)
    setSaveConflict(false)
    setBaseVersion(node.version)
    setProcurement(node.procurement_type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
      queryClient.invalidateQueries({ queryKey: ["validation", project.id] }),
      queryClient.invalidateQueries({ queryKey: ["reports", project.id] }),
    ])
  }

  const save = useMutation({
    onMutate: () => setSaveConflict(false),
    mutationFn: () => {
      return api.updateNode(node.id, {
        expectedVersion: baseVersion,
        name: name.trim(),
        description: description.trim(),
        referenceId: nullable(referenceId),
        revision: nullable(revision),
        fullNumber: nullable(fullNumber),
        internalNote: internalNote.trim(),
        ...(node.kind === "system"
          ? {}
          : {
              quantity,
              procurementType: procurement,
            }),
      })
    },
    onSuccess: async ({ node: saved }) => {
      setName(saved.name)
      setDescription(saved.description)
      setQuantity(saved.quantity)
      setRevision(saved.revision ?? "")
      setFullNumber(saved.full_number ?? "")
      setReferenceId(saved.reference_id ?? "")
      setInternalNote(saved.internal_note)
      setProcurement(saved.procurement_type)
      setBaseVersion(saved.version)
      setSaveConflict(false)
      toast.success(`${nodeKindLabel(node.kind)} saved`)
      await invalidate()
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "version-conflict") {
        setSaveConflict(true)
        toast.error(
          "This item changed elsewhere. Your draft is preserved; reload the latest server version before editing again.",
        )
        await invalidate()
        return
      }
      showMutationError(error)
    },
  })

  const issuesByTab = useMemo(() => {
    const grouped: Record<NodeEditorTab, ValidationIssue[]> = {
      details: [],
      costing: [],
      evidence: [],
      children: [],
    }

    for (const issue of validationIssues) {
      const target = resolveValidationIssueTarget(issue)
      if (
        target?.kind !== "node" ||
        target.nodeId !== node.id
      ) {
        continue
      }
      grouped[tabForEditorSection(target.section)].push(issue)
    }

    return grouped
  }, [node.id, validationIssues])
  const numberConflict = findNumberConflict(fullNumber, nodes, node.id)
  const fullNumberIssue = numberConflict
    ? {
        title: `Full number already used by ${numberConflict.name}`,
        detail: "Choose another side or number. Left and right counterparts can share the same base number.",
      }
    : issuesByTab.details.find(
        (issue) =>
          issue.code === "vehicle-number-missing" ||
          issue.code === "assembly-number-missing" ||
          issue.code === "part-number-missing",
      ) ?? null
  const revisionIssue =
    issuesByTab.details.find(
      (issue) =>
        issue.code === "vehicle-revision-missing" ||
        issue.code === "assembly-revision-missing" ||
        issue.code === "part-revision-missing",
    ) ?? null
  const procurementIssue =
    issuesByTab.details.find(
      (issue) => issue.code === "made-bought-unset",
    ) ?? null
  const fullNumberInvalid = Boolean(
    numberConflict || (fullNumberIssue && !fullNumber.trim()),
  )
  const revisionInvalid = Boolean(revisionIssue && !revision.trim())
  const procurementInvalid = Boolean(
    procurementIssue && procurement === "unknown",
  )
  const suggestedReference = useMemo(() => {
    if (
      (node.kind !== "assembly" &&
        node.kind !== "subassembly" &&
        node.kind !== "part") ||
      isControlledNumberForContext(fullNumber, {
        entryNumber: project.entry_number,
        season: project.season,
        systemCode: node.system_code,
      })
    ) {
      return null
    }

    return suggestControlledReference(
      { ...node, full_number: fullNumber },
      nodes,
    )
  }, [fullNumber, node, nodes, project.entry_number, project.season])
  const changeFullNumber = (value: string) => {
    setFullNumber(value)
    const parsed = parseControlledNumber(value)
    if (!parsed) return
    setReferenceId(referenceWithSide(parsed.reference, parsed.side))
    setRevision(parsed.revision)
  }
  const changeRevision = (value: string) => {
    setRevision(value)
    const nextFullNumber = composeControlledNumber({
      entryNumber: project.entry_number,
      season: project.season,
      systemCode: node.system_code,
      reference:
        parseControlledNumber(fullNumber)?.reference ?? referenceId,
      revision: value,
      side: nodeSide({ full_number: fullNumber, reference_id: referenceId }),
    })
    if (nextFullNumber) setFullNumber(nextFullNumber)
  }
  const chooseEvidenceFile = (kind: "image" | "drawing") => {
    const input =
      kind === "image"
        ? imageEvidenceInputRef.current
        : drawingEvidenceInputRef.current

    input?.click()
    setActiveTab("evidence")
  }
  const quantityValid = node.kind === "system" || isPositiveDecimal(quantity)
  const recordDirty =
    name !== node.name ||
    description !== node.description ||
    quantity !== node.quantity ||
    revision !== (node.revision ?? "") ||
    fullNumber !== (node.full_number ?? "") ||
    referenceId !== (node.reference_id ?? "") ||
    internalNote !== node.internal_note ||
    procurement !== node.procurement_type

  const reloadLatestRecord = () => {
    setName(node.name)
    setDescription(node.description)
    setQuantity(node.quantity)
    setRevision(node.revision ?? "")
    setFullNumber(node.full_number ?? "")
    setReferenceId(node.reference_id ?? "")
    setInternalNote(node.internal_note)
    setProcurement(node.procurement_type)
    setBaseVersion(node.version)
    setSaveConflict(false)
  }

  useUnsavedChangesRegistration(
    `node-record:${node.id}`,
    recordDirty,
    { label: `${node.name} record` },
  )

  useEffect(() => {
    const nextTab = availableTabForEditorSection(
      initialSection,
      supportsCosting,
      supportsChildren,
    )
    setActiveTab(nextTab)

    const frame = window.requestAnimationFrame(() => {
      tabsListRef.current
        ?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        )
        ?.scrollIntoView({ block: "nearest", inline: "nearest" })
      const heading = document.getElementById(headingIdForTab(nextTab))
      if (initialSection !== "default") {
        heading?.scrollIntoView({ block: "start" })
      }
      heading?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    initialSection,
    node.id,
    supportsChildren,
    supportsCosting,
  ])

  const reference =
    fullNumber ||
    referenceId ||
    `${node.system_code ?? "UCM"} item`
  const metadataLine =
    node.kind === "system"
      ? `${node.children.length} direct ${
          node.children.length === 1 ? "assembly" : "assemblies"
        }`
      : [
          node.kind === "part" ? procurementLabel(procurement) : null,
          revision.trim() ? `Revision ${revision.trim()}` : "Revision not set",
          `Quantity ${quantity || "not set"} in parent`,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ")

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-[58px] z-20 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 shadow-sm supports-[backdrop-filter]:backdrop-blur-sm">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={onClose}
        >
          <ArrowLeft data-icon="inline-start" />
          {backLabel}
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {onNavigate && (
            <div
              className="flex items-center gap-2"
              aria-label="Move between bill of materials items"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!previousNode}
                title={previousNode?.name}
                onClick={() => previousNode && onNavigate(previousNode.id)}
              >
                <ChevronLeft />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!nextNode}
                title={nextNode?.name}
                onClick={() => nextNode && onNavigate(nextNode.id)}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          )}
          <span
            className="ml-1 text-xs font-medium text-muted-foreground"
            aria-live="polite"
          >
            {save.isPending
              ? "Saving…"
              : recordDirty
                ? "Unsaved changes"
                : "Saved"}
          </span>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={
              readOnly ||
              save.isPending ||
              saveConflict ||
              !recordDirty ||
              !name.trim() ||
              !quantityValid ||
              Boolean(numberConflict)
            }
          >
            {save.isPending && (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin"
              />
            )}
            Save {nodeKindLabel(node.kind).toLowerCase()}
          </Button>
        </div>
      </div>

      {oppositeParent && !readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {recordDirty && (
            <p className="text-xs text-muted-foreground">
              Save your changes before creating the opposite side.
            </p>
          )}
          <CreateChildDialog
            parent={oppositeParent}
            kind="part"
            nodes={nodes}
            project={project}
            oppositeSource={node}
            disabled={recordDirty || save.isPending}
            onSaved={invalidate}
            onCreated={onCreated}
          />
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as NodeEditorTab)}
        className="gap-0"
      >
        <Card className="gap-0">
          <CardHeader className="gap-0 pb-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {node.kind}
              </Badge>
              {node.system_code && (
                <Badge variant="secondary">{node.system_code}</Badge>
              )}
              <span className="truncate font-mono text-xs text-muted-foreground">
                {reference}
              </span>
            </div>
            <CardTitle className="mt-3 text-2xl">{node.name}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {metadataLine}
            </p>
            <ControlledIdentifier
              key={`${node.id}:${baseVersion}`}
              entryNumber={project.entry_number}
              season={project.season}
              systemCode={node.system_code}
              fullNumber={fullNumber}
              referenceId={referenceId}
              revision={revision}
              showSide={node.kind === "part"}
              onFullNumberChange={readOnly ? undefined : changeFullNumber}
              onRevisionChange={readOnly ? undefined : changeRevision}
              fullNumberInvalid={fullNumberInvalid}
              fullNumberError={
                fullNumberIssue
                  ? {
                      id: `${fieldId}-number-error`,
                      title: fullNumberIssue.title,
                      detail: fullNumberIssue.detail,
                    }
                  : null
              }
              revisionInvalid={revisionInvalid}
              revisionErrorId={`${fieldId}-revision-error`}
              suggestedReference={suggestedReference}
              suggestionLabel={`Suggested ${nodeKindLabel(node.kind).toLowerCase()} number`}
              className="-mx-4 mt-5 w-[calc(100%+2rem)]"
            />
            {visual ? (
              <div className="-mx-4 w-[calc(100%+2rem)]">
                {visual({
                  chooseEvidenceFile,
                  canUploadEvidence: supportsCosting && !readOnly,
                })}
              </div>
            ) : null}
            <TabsList
              ref={tabsListRef}
              variant="line"
              aria-label="Item sections"
              className="-mx-4 w-[calc(100%+2rem)] justify-start gap-3 overflow-x-auto overflow-y-hidden rounded-none border-b px-4 py-0 sm:gap-5 group-data-horizontal/tabs:h-11"
            >
              <NodeEditorTabTrigger
                value="details"
                label="Details"
                issues={issuesByTab.details}
              />
              {supportsCosting && (
                <>
                  <NodeEditorTabTrigger
                    value="costing"
                    label="Costing"
                    issues={issuesByTab.costing}
                  />
                  <NodeEditorTabTrigger
                    value="evidence"
                    label="Evidence"
                    issues={issuesByTab.evidence}
                  />
                </>
              )}
              {supportsChildren && (
                <NodeEditorTabTrigger
                  value="children"
                  label="Children"
                  issues={issuesByTab.children}
                />
              )}
            </TabsList>
          </CardHeader>

          <TabsContent
            forceMount
            value="details"
            className="mt-0 hidden data-[state=active]:block"
          >
            <fieldset disabled={readOnly} className="contents">
              <CardContent className="flex flex-col gap-6 pt-5">
                <section aria-labelledby="node-record-heading">
                  <div className="mb-4">
                    <h3
                      id="node-record-heading"
                      tabIndex={-1}
                      className="scroll-mt-24 font-semibold outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
                    >
                      Item record
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Vehicle and system context are inherited and cannot be
                      changed from this editor.
                    </p>
                  </div>

                  <FieldGroup className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-name`}>
                        Name
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-name`}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-invalid={!name.trim()}
                      />
                      {!name.trim() && (
                        <FieldError>A name is required.</FieldError>
                      )}
                    </Field>

                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-reference`}>
                        Full {nodeKindLabel(node.kind).toLowerCase()} number
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-reference`}
                        value={fullNumber}
                        readOnly
                        placeholder="Set the number segments above"
                        className="font-mono"
                      />
                      <FieldDescription>
                        Updates from the number segments{node.kind === "part" ? ", side," : ""} and revision above.
                      </FieldDescription>
                    </Field>

                    <Field data-invalid={revisionInvalid}>
                      <FieldLabel htmlFor={`${fieldId}-revision`}>
                        Revision
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-revision`}
                        value={revision}
                        onChange={(event) =>
                          changeRevision(event.target.value)
                        }
                        aria-invalid={revisionInvalid}
                        aria-describedby={
                          revisionInvalid
                            ? `${fieldId}-revision-error`
                            : undefined
                        }
                      />
                      {revisionInvalid && revisionIssue && (
                        <FieldError
                          id={`${fieldId}-revision-error`}
                          title={revisionIssue.detail}
                        >
                          {revisionIssue.title}
                        </FieldError>
                      )}
                    </Field>

                    {node.kind !== "system" && (
                      <Field data-invalid={!quantityValid}>
                        <FieldLabel htmlFor={`${fieldId}-quantity`}>
                          Quantity in parent
                        </FieldLabel>
                        <Input
                          id={`${fieldId}-quantity`}
                          inputMode="decimal"
                          value={quantity}
                          onChange={(event) =>
                            setQuantity(event.target.value)
                          }
                          aria-invalid={!quantityValid}
                        />
                        {!quantityValid && (
                          <FieldError>
                            Enter a quantity greater than zero.
                          </FieldError>
                        )}
                      </Field>
                    )}

                    {node.kind === "part" && (
                      <Field data-invalid={procurementInvalid}>
                        <FieldLabel htmlFor={`${fieldId}-procurement`}>
                          Made or bought
                        </FieldLabel>
                        <Select
                          value={procurement}
                          onValueChange={(value) =>
                            setProcurement(
                              value as CostNode["procurement_type"],
                            )
                          }
                        >
                          <SelectTrigger
                            id={`${fieldId}-procurement`}
                            className="w-full"
                            aria-invalid={procurementInvalid}
                            aria-describedby={
                              procurementInvalid
                                ? `${fieldId}-procurement-error`
                                : undefined
                            }
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="unknown">
                                Unconfirmed
                              </SelectItem>
                              <SelectItem value="made">Made</SelectItem>
                              <SelectItem value="bought">
                                Bought
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {procurementInvalid && procurementIssue && (
                          <FieldError
                            id={`${fieldId}-procurement-error`}
                            title={procurementIssue.detail}
                          >
                            {procurementIssue.title}
                          </FieldError>
                        )}
                      </Field>
                    )}

                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`${fieldId}-description`}>
                        Report description
                      </FieldLabel>
                      <Textarea
                        id={`${fieldId}-description`}
                        value={description}
                        onChange={(event) =>
                          setDescription(event.target.value)
                        }
                        rows={3}
                      />
                    </Field>

                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`${fieldId}-internal-note`}>
                        Internal note
                      </FieldLabel>
                      <Textarea
                        id={`${fieldId}-internal-note`}
                        value={internalNote}
                        onChange={(event) =>
                          setInternalNote(event.target.value)
                        }
                        rows={3}
                      />
                      <FieldDescription>
                        Internal notes never enter a generated report.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>

                  {saveConflict && (
                    <Alert variant="destructive" className="mt-4">
                      <CircleAlert />
                      <AlertTitle>Reload before saving</AlertTitle>
                      <AlertDescription>
                        <p>
                          This draft is still visible for reference, but saving
                          is locked because a newer server version exists.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={reloadLatestRecord}
                          disabled={save.isPending}
                        >
                          Reload latest and discard draft
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}

                </section>

                {(node.kind === "assembly" ||
                  node.kind === "subassembly" ||
                  node.kind === "part") && (
                  <>
                    <Separator />
                    <MoveHierarchyDialog
                      node={node}
                      nodes={nodes}
                      recordDirty={recordDirty}
                      onChanged={invalidate}
                    />
                  </>
                )}

                {(node.kind === "assembly" ||
                  node.kind === "subassembly" ||
                  node.kind === "part") && (
                  <>
                    <Separator />
                    <DeleteNodeDialog
                      node={node}
                      onChanged={invalidate}
                      onDeleted={onDeleted}
                    />
                  </>
                )}
              </CardContent>
            </fieldset>
          </TabsContent>

          {supportsCosting && (
            <>
              <TabsContent
                forceMount
                value="costing"
                className="mt-0 hidden data-[state=active]:block"
              >
                <CardContent className="pt-5">
                  <CostLinesPanel
                    node={node}
                    project={project}
                    readOnly={readOnly}
                    onChanged={invalidate}
                  />
                </CardContent>
              </TabsContent>
              <TabsContent
                forceMount
                value="evidence"
                className="mt-0 hidden data-[state=active]:block"
              >
                <CardContent className="pt-5">
                  <EvidencePanel
                    projectId={project.id}
                    node={node}
                    readOnly={readOnly}
                    onDrawingSaved={(savedId, previousVersion, nextVersion) => {
                      if (savedId === node.id) {
                        setBaseVersion((current) => current === previousVersion ? nextVersion : current)
                      }
                    }}
                    imageInputRef={imageEvidenceInputRef}
                    drawingInputRef={drawingEvidenceInputRef}
                    onChanged={invalidate}
                  />
                </CardContent>
              </TabsContent>
            </>
          )}

          {supportsChildren && (
            <TabsContent
              forceMount
              value="children"
              className="mt-0 hidden data-[state=active]:block"
            >
              <CardContent className="pt-5">
                {node.kind === "system" ? (
                  <section
                    aria-labelledby="children-heading"
                    className="mb-8"
                  >
                    <div className="mb-4">
                      <h3
                        id="children-heading"
                        tabIndex={-1}
                        className="scroll-mt-24 font-semibold outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
                      >
                        Assembly tree
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Generated automatically from this system's hierarchy.
                        Scroll the diagram to inspect larger systems.
                      </p>
                    </div>
                    <SystemAssemblyTree system={node} />
                  </section>
                ) : null}
                <section
                  aria-labelledby={
                    node.kind === "system"
                      ? "assemblies-heading"
                      : "children-heading"
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3
                        id={
                          node.kind === "system"
                            ? "assemblies-heading"
                            : "children-heading"
                        }
                        tabIndex={-1}
                        className="scroll-mt-24 font-semibold outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
                      >
                        {node.kind === "system" ? "Assemblies" : "Children"}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {node.children.length} direct child
                        {node.children.length === 1 ? "" : "ren"}. Only
                        rule-valid child types are offered.
                      </p>
                    </div>
                    {!readOnly && (
                      <div className="flex flex-wrap gap-2">
                        {childKinds.map((kind) => (
                          <CreateChildDialog
                            key={kind}
                            parent={node}
                            kind={kind}
                            nodes={nodes}
                            project={project}
                            onSaved={invalidate}
                            onCreated={onCreated}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {node.children.length > 0 ? (
                    <NodeChildrenList
                      key={node.id}
                      parent={node}
                      readOnly={readOnly}
                      onOpen={onCreated}
                      onRefresh={invalidate}
                      onReordered={async (previousVersion, parentVersion) => {
                        setBaseVersion((current) =>
                          current === previousVersion ? parentVersion : current,
                        )
                        await invalidate()
                      }}
                    />
                  ) : (
                    <div className="mt-4 rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                      No child records yet.
                    </div>
                  )}
                </section>
              </CardContent>
            </TabsContent>
          )}
        </Card>
      </Tabs>
    </div>
  )
}

function NodeEditorTabTrigger({
  value,
  label,
  issues,
}: {
  value: NodeEditorTab
  label: string
  issues: ValidationIssue[]
}) {
  return (
    <TabsTrigger
      value={value}
      className="flex-none rounded-none px-0 text-[13px] data-active:text-primary after:bg-primary group-data-horizontal/tabs:after:bottom-0 focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:underline-offset-4"
    >
      {label}
      {issues.length > 0 && (
        <Badge
          variant="destructive"
          className="h-5 px-1.5 text-[10px] leading-none"
          title={issues.map((issue) => issue.title).join("\n")}
        >
          {issues.length} issue{issues.length === 1 ? "" : "s"}
        </Badge>
      )}
    </TabsTrigger>
  )
}

function tabForEditorSection(
  section: NodeEditorSection | "default",
): NodeEditorTab {
  if (section === "cost-lines") return "costing"
  if (section === "evidence") return "evidence"
  if (section === "children") return "children"
  return "details"
}

function availableTabForEditorSection(
  section: NodeEditorSection | "default",
  supportsCosting: boolean,
  supportsChildren: boolean,
): NodeEditorTab {
  const requestedTab =
    section === "default" && supportsChildren
      ? "children"
      : tabForEditorSection(section)

  if (
    (requestedTab === "costing" || requestedTab === "evidence") &&
    !supportsCosting
  ) {
    return "details"
  }
  if (requestedTab === "children" && !supportsChildren) {
    return "details"
  }
  return requestedTab
}

function headingIdForTab(tab: NodeEditorTab): string {
  if (tab === "costing") return "cost-lines-heading"
  if (tab === "evidence") return "evidence-heading"
  if (tab === "children") return "children-heading"
  return "node-record-heading"
}

function procurementLabel(
  value: CostNode["procurement_type"],
): string {
  if (value === "made") return "Made"
  if (value === "bought") return "Bought"
  return "Made or bought not set"
}

function oppositePartName(source: CostNode): string {
  const side = nodeSide(source) === "L" ? "R" : "L"
  return /\b(left|right|l|r)$/i.test(source.name)
    ? source.name.replace(/\b(left|right|l|r)$/i, side)
    : `${source.name} ${side}`
}

function CreateChildDialog({
  parent,
  kind,
  nodes,
  project,
  onSaved,
  onCreated,
  oppositeSource,
  disabled = false,
}: {
  parent: CostNode
  oppositeSource?: CostNode
  disabled?: boolean
  kind: EditableNodeKind
  nodes: readonly CostNode[]
  project: ProjectDetail["project"]
  onSaved: () => Promise<void>
  onCreated: (
    nodeId: string,
    parentId: string,
    savedDraftKey?: string,
  ) => void
}) {
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [revision, setRevision] = useState("")
  const [fullNumber, setFullNumber] = useState("")
  const [referenceId, setReferenceId] = useState("")
  const [internalNote, setInternalNote] = useState("")
  const [procurement, setProcurement] =
    useState<CostNode["procurement_type"]>("unknown")
  const draftRegistrationKey =
    `create-child:${parent.id}:${kind}:${oppositeSource?.id ?? "new"}`
  const suggestedReference = useMemo(() => {
    if (oppositeSource) {
      const parsed = parseControlledNumber(oppositeSource.full_number ?? "")
      if (parsed) {
        return referenceWithSide(
          parsed.reference,
          parsed.side === "L" ? "R" : "L",
        )
      }
    }
    const childDraft: CostNode = {
      ...parent,
      id: `new-${kind}`,
      parent_id: parent.id,
      kind,
      raw_hla: null,
      raw_subassembly: null,
      raw_part_number: null,
      reference_id: null,
      full_number: null,
      revision: null,
      sort_order: parent.children.length,
      children: [],
      costLines: [],
    }
    return suggestControlledReference(childDraft, nodes) ?? ""
  }, [kind, nodes, parent, oppositeSource])
  const suggestedFullNumber = composeControlledNumber({
    entryNumber: project.entry_number,
    season: project.season,
    systemCode: parent.system_code,
    reference: suggestedReference,
    revision: "A",
  })

  useEffect(() => {
    if (!open) return
    setName(oppositeSource ? oppositePartName(oppositeSource) : "")
    setDescription(oppositeSource?.description ?? "")
    setQuantity(oppositeSource?.quantity ?? "1")
    setRevision("A")
    setFullNumber(suggestedFullNumber)
    setReferenceId(suggestedReference)
    setInternalNote("")
    setProcurement(oppositeSource?.procurement_type ?? "unknown")
    // Snapshot the hierarchy suggestion when the dialog opens so background
    // workspace refreshes cannot erase an in-progress child draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind])

  const changeFullNumber = (value: string) => {
    setFullNumber(value)
    const parsed = parseControlledNumber(value)
    if (!parsed) return
    setReferenceId(referenceWithSide(parsed.reference, parsed.side))
    setRevision(parsed.revision)
  }

  const numberConflict = findNumberConflict(fullNumber, nodes)
  const quantityValid = isPositiveDecimal(quantity)
  const create = useMutation({
    mutationFn: () =>
      api.createNode(parent.id, {
        expectedParentVersion: parent.version,
        kind,
        name: name.trim(),
        description: description.trim(),
        quantity,
        revision: nullable(revision),
        fullNumber: nullable(fullNumber),
        referenceId: nullable(referenceId),
        internalNote: internalNote.trim(),
        procurementType: procurement,
      }),
    onSuccess: async ({ node }) => {
      toast.success(`${nodeKindLabel(kind)} created`)
      setOpen(false)
      await onSaved()
      onCreated(node.id, parent.id, draftRegistrationKey)
    },
    onError: showMutationError,
  })
  const hasDraft =
    open &&
    (name !== "" ||
      description !== "" ||
      quantity !== "1" ||
      revision !== "A" ||
      fullNumber !== suggestedFullNumber ||
      referenceId !== suggestedReference ||
      internalNote !== "" ||
      procurement !== "unknown")

  useUnsavedChangesRegistration(
    draftRegistrationKey,
    hasDraft,
    { label: `New ${nodeKindLabel(kind).toLowerCase()}` },
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !hasDraft) setOpen(nextOpen)
      }}
    >
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Plus data-icon="inline-start" />
        {oppositeSource
          ? "Create opposite-side part"
          : `Add ${nodeKindLabel(kind).toLowerCase()}`}
      </Button>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!hasDraft}
      >
        <DialogHeader>
          <DialogTitle>
            {oppositeSource
              ? "Create opposite-side part"
              : `Add ${nodeKindLabel(kind).toLowerCase()} to ${parent.name}`}
          </DialogTitle>
          <DialogDescription>
            {oppositeSource
              ? `Create a separate ${nodeSide(oppositeSource) === "L" ? "right" : "left"} part beside ${oppositeSource.name}, with the same base number. Review its details below; add its own costs and evidence after creation.`
              : `Vehicle and ${parent.system_code ?? "system"} context are inherited from the selected parent. The next available number and revision A are ready to edit.`}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={!name.trim()}>
            <FieldLabel htmlFor={`${fieldId}-child-name`}>Name</FieldLabel>
            <Input
              id={`${fieldId}-child-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={!name.trim()}
              autoFocus
            />
            {!name.trim() && <FieldError>A name is required.</FieldError>}
          </Field>

          <ControlledIdentifier
            entryNumber={project.entry_number}
            season={project.season}
            systemCode={parent.system_code}
            fullNumber={fullNumber}
            referenceId={referenceId}
            revision={revision}
            showSide={kind === "part"}
            fullNumberInvalid={Boolean(numberConflict)}
            fullNumberError={
              numberConflict
                ? {
                    id: `${fieldId}-duplicate`,
                    title: `Full number already used by ${numberConflict.name}`,
                    detail: "Choose another side or number.",
                  }
                : null
            }
            onFullNumberChange={changeFullNumber}
            onRevisionChange={setRevision}
            className="sm:col-span-2"
          />
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${fieldId}-child-full-number`}>
              Full {nodeKindLabel(kind).toLowerCase()} number
            </FieldLabel>
            <Input
              id={`${fieldId}-child-full-number`}
              value={fullNumber}
              readOnly
              className="font-mono"
            />
            <FieldDescription>
              {kind === "part"
                ? "Left and right counterparts share a base number. Use None for a part that fits either side."
                : "Updates from the number segments and revision above."}
            </FieldDescription>
          </Field>

          <Field data-invalid={!quantityValid}>
            <FieldLabel htmlFor={`${fieldId}-child-quantity`}>
              Quantity in parent
            </FieldLabel>
            <Input
              id={`${fieldId}-child-quantity`}
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              aria-invalid={!quantityValid}
            />
            {!quantityValid && (
              <FieldError>Enter a quantity greater than zero.</FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${fieldId}-child-procurement`}>
              Made or bought
            </FieldLabel>
            <Select
              value={procurement}
              onValueChange={(value) =>
                setProcurement(value as CostNode["procurement_type"])
              }
            >
              <SelectTrigger
                id={`${fieldId}-child-procurement`}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="unknown">Unconfirmed</SelectItem>
                  <SelectItem value="made">Made</SelectItem>
                  <SelectItem value="bought">Bought</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${fieldId}-child-description`}>
              Report description
            </FieldLabel>
            <Textarea
              id={`${fieldId}-child-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${fieldId}-child-note`}>
              Internal note
            </FieldLabel>
            <Textarea
              id={`${fieldId}-child-note`}
              value={internalNote}
              onChange={(event) => setInternalNote(event.target.value)}
              rows={2}
            />
            <FieldDescription>
              Internal notes remain outside every generated report.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={
              create.isPending ||
              !name.trim() ||
              !quantityValid ||
              Boolean(numberConflict)
            }
          >
            {create.isPending && (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin"
              />
            )}
            Create {nodeKindLabel(kind).toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CostLinesPanel({
  node,
  project,
  readOnly,
  onChanged,
}: {
  node: CostNode
  project: ProjectDetail["project"]
  readOnly: boolean
  onChanged: () => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteSelection, setDeleteSelection] = useState<CostLine[] | null>(
    null,
  )
  const selectedLines = node.costLines.filter((line) => selected.has(line.id))
  const remove = useMutation({
    mutationFn: (lines: CostLine[]) =>
      api.deleteCostLines(
        node.id,
        lines.map((line) => ({ id: line.id, expectedVersion: line.version })),
      ),
    onSuccess: async () => {
      setSelected(new Set())
      setDeleteSelection(null)
      toast.success("Selected cost items removed")
      await onChanged()
    },
    onError: async (error) => {
      showMutationError(error)
      setDeleteSelection(null)
      await onChanged()
    },
  })
  const reorder = useMutation({
    mutationFn: ({ kind, lines }: { kind: CostKind; lines: CostLine[] }) =>
      api.reorderCostLines(
        node.id,
        kind,
        lines.map((line) => ({ id: line.id, expectedVersion: line.version })),
      ),
    onSuccess: async () => {
      toast.success("Cost item order saved")
      await onChanged()
    },
    onError: async (error) => {
      showMutationError(error)
      await onChanged()
    },
  })
  const busy = remove.isPending || reorder.isPending
  const moveLine = (lines: CostLine[], index: number, direction: -1 | 1) => {
    const next = [...lines]
    ;[next[index], next[index + direction]] = [
      next[index + direction]!,
      next[index]!,
    ]
    reorder.mutate({ kind: next[0]!.kind, lines: next })
  }
  const directLineGroups = costKinds
    .map((kind) => {
      const lines = node.costLines.filter((line) => line.kind === kind)
      return {
        kind,
        lines,
        subtotal: lines.reduce((sum, line) => sum + Number(line.subtotal), 0),
      }
    })
    .filter(({ lines }) => lines.length > 0)

  return (
    <section aria-labelledby="cost-lines-heading">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-4">
        <div className="min-w-0">
          <h3
            id="cost-lines-heading"
            tabIndex={-1}
            className="scroll-mt-32 text-base font-semibold outline-none focus-visible:text-primary"
          >
            Cost sheet
          </h3>
        </div>
        <div className="ml-auto flex flex-wrap items-end justify-end gap-4">
          <div className="text-right">
            <div className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Total for quantity {node.quantity}, incl. children
            </div>
            <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight tabular-nums">
              U${" "}
              {universal(
                extendCostBreakdown(node.breakdown, node.quantity).total,
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              U$ {universal(node.breakdown.total)} per item
            </div>
          </div>
          {!readOnly && (
            <div className="flex flex-wrap justify-end gap-2">
              <Import2025CostLineDialog node={node} onSaved={onChanged} />
              <CostLineDialog
                node={node}
                project={project}
                onSaved={onChanged}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Cost lines below are per item.
          {!readOnly && " Move rows within each category using the arrows."}
        </p>
        {!readOnly && node.costLines.length > 0 && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                aria-label="Select all cost items"
                checked={selectedLines.length === node.costLines.length}
                ref={(input) => {
                  if (input)
                    input.indeterminate =
                      selectedLines.length > 0 &&
                      selectedLines.length < node.costLines.length
                }}
                disabled={busy}
                onChange={(event) =>
                  setSelected(
                    new Set(
                      event.target.checked
                        ? node.costLines.map((line) => line.id)
                        : [],
                    ),
                  )
                }
              />
              {selectedLines.length > 0
                ? `${selectedLines.length} selected`
                : "Select all"}
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedLines.length === 0 || busy}
              onClick={() => setDeleteSelection(selectedLines)}
            >
              <Trash2 /> Delete selected
            </Button>
          </div>
        )}
      </div>
      <Dialog
        open={deleteSelection !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleteSelection(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deleteSelection?.length} cost items?
            </DialogTitle>
            <DialogDescription>
              Selected items will be removed together and totals recalculated.
              Existing report snapshots stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 overflow-y-auto space-y-2 text-sm">
            {deleteSelection?.map((line) => (
              <li key={line.id}>
                {line.description} — U$ {universal(line.subtotal)}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleteSelection(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleteSelection && remove.mutate(deleteSelection)}
            >
              Delete {deleteSelection?.length} items
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        role="region"
        aria-label="Direct cost lines spreadsheet. Scroll horizontally to see all columns."
        tabIndex={0}
        className="mt-4 overflow-x-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-center justify-end gap-0.5 border-b bg-muted/25 px-3 py-1.5 text-[10px] font-medium text-muted-foreground sm:hidden">
          Swipe for cost columns
          <ChevronRight className="size-3" aria-hidden="true" />
        </div>
        <table className="w-full min-w-[800px] table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[36%]" />
            <col className="w-[13%]" />
            <col className="w-[8%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/45 text-left">
              <CostSheetHeading className="sticky left-0 z-10 bg-muted shadow-[1px_0_0_0_var(--border)]">
                Cost item
              </CostSheetHeading>
              <CostSheetHeading numeric>Unit cost</CostSheetHeading>
              <CostSheetHeading numeric>Amount</CostSheetHeading>
              <CostSheetHeading numeric>Factor</CostSheetHeading>
              <CostSheetHeading numeric>Subtotal</CostSheetHeading>
              <th scope="col" className="w-20 px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {directLineGroups.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No direct cost lines on this item yet.
                </td>
              </tr>
            ) : (
              directLineGroups.map(({ kind, lines, subtotal }) => (
                <Fragment key={kind}>
                  <CostLineGroupRow
                    kind={kind}
                    lineCount={lines.length}
                    subtotal={subtotal}
                  />
                  {lines.map((line, index) => (
                    <CostLineTableRow
                      key={line.id}
                      node={node}
                      line={line}
                      project={project}
                      readOnly={readOnly}
                      onChanged={onChanged}
                      selected={selected.has(line.id)}
                      onSelect={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (checked) next.add(line.id)
                          else next.delete(line.id)
                          return next
                        })
                      }
                      busy={busy}
                      onMoveUp={
                        index > 0 ? () => moveLine(lines, index, -1) : undefined
                      }
                      onMoveDown={
                        index < lines.length - 1
                          ? () => moveLine(lines, index, 1)
                          : undefined
                      }
                    />
                  ))}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function CostLineGroupRow({
  kind,
  lineCount,
  subtotal,
}: {
  kind: CostKind
  lineCount: number
  subtotal: number
}) {
  const label = nodeKindLabel(kind)

  return (
    <tr className="border-y bg-muted/30">
      <th
        scope="rowgroup"
        className="sticky left-0 z-[2] bg-muted px-3 py-2 text-left shadow-[1px_0_0_0_var(--border)]"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              costKindDotClasses[kind],
            )}
            aria-hidden="true"
          />
          <span className="text-[10px] font-semibold tracking-[0.08em] text-foreground uppercase">
            {label}
          </span>
          <span className="text-[10px] font-medium text-muted-foreground">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>
        </div>
      </th>
      <td colSpan={3} aria-hidden="true" />
      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums">
        <span className="sr-only">{label} subtotal: </span>
        U$ {universal(subtotal)}
      </td>
      <td aria-hidden="true" />
    </tr>
  )
}

function CostSheetHeading({
  children,
  numeric = false,
  className,
}: {
  children: ReactNode
  numeric?: boolean
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase",
        numeric && "text-right",
        className,
      )}
    >
      {children}
    </th>
  )
}

function CostLineTableRow({
  node,
  line,
  project,
  readOnly,
  onChanged,
  selected,
  onSelect,
  busy,
  onMoveUp,
  onMoveDown,
}: {
  node: CostNode
  line: CostLine
  project: ProjectDetail["project"]
  readOnly: boolean
  onChanged: () => Promise<void>
  selected: boolean
  onSelect: (checked: boolean) => void
  busy: boolean
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const isTooling = line.kind === "tooling"
  const unit = line.catalogue_unit?.trim() || null
  const usesUnitAmount = Boolean(line.catalogue_uses_unit_amount && unit)
  const amount = formatFixedRateAmount(line.quantity, unit, usesUnitAmount)
  const rate = usesUnitAmount
    ? `U$ ${universal(line.unit_cost)}/${unit}`
    : `U$ ${universal(line.unit_cost)}${unit ? ` (catalogue unit ${unit})` : " (unit not recorded)"}`
  const calculation = isTooling
    ? `U$ ${universal(line.unit_cost)}${unit ? ` (catalogue unit ${unit})` : " (unit not recorded)"} × quantity ${line.quantity} × ${line.fraction_included} ÷ ${line.production_volume_factor ?? "—"} = U$ ${universal(line.subtotal)}`
    : `${rate} × ${usesUnitAmount ? amount : `quantity ${line.quantity}`} × ${line.multiplier} = U$ ${universal(line.subtotal)}`

  return (
    <tr
      className="group transition-colors hover:bg-muted/25"
      title={calculation}
    >
      <td className="sticky left-0 z-[1] overflow-hidden bg-background px-3 py-2.5 align-top shadow-[1px_0_0_0_var(--border)] transition-colors group-hover:bg-muted/25">
        <div className="flex items-start gap-2">
          {!readOnly && (
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-primary"
              aria-label={`Select ${line.description}`}
              checked={selected}
              disabled={busy}
              onChange={(event) => onSelect(event.target.checked)}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="break-words font-medium text-foreground">
              <span className="sr-only">{nodeKindLabel(line.kind)}: </span>
              {line.description}
            </div>
            {line.use_description && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {line.use_description}
              </div>
            )}
            {line.stock_size_name && (
              <div className="mt-1 text-xs text-muted-foreground">
                Stock size: {line.stock_size_name}
              </div>
            )}
            {!line.catalogue_item_id && (
              <div className="mt-1 text-xs font-medium text-destructive">
                Source unlinked
              </div>
            )}
            {line.catalogue_item_id && line.catalogue_provenance && (
              <CatalogueProvenanceBadge
                provenance={line.catalogue_provenance}
                revision={line.catalogue_revision ?? 0}
                className="mt-1"
              />
            )}
            <span className="sr-only">Calculation: {calculation}</span>
          </div>
        </div>
      </td>
      <CostSheetNumber
        value={`U$ ${universal(line.unit_cost)}`}
        detail={unit ? `Catalogue unit: ${unit}` : "Unit not recorded"}
      />
      <CostSheetNumber
        value={amount}
        detail={usesUnitAmount ? "Catalogue-rate amount" : "Quantity"}
      />
      <td className="px-3 py-3 text-right align-middle">
        {isTooling ? (
          <div className="font-mono text-xs tabular-nums">
            <div>×{line.fraction_included}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              ÷ {line.production_volume_factor ?? "—"} volume
            </div>
          </div>
        ) : (
          <div className="font-mono text-xs tabular-nums">
            <div>×{line.multiplier}</div>
            {line.multiplier_name && (
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {line.multiplier_name}
              </div>
            )}
          </div>
        )}
      </td>
      <CostSheetNumber value={`U$ ${universal(line.subtotal)}`} emphasized />
      <td className="px-2 py-2 align-middle">
        {!readOnly && (
          <div className="flex justify-end gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${line.description} up`}
              disabled={busy || !onMoveUp}
              onClick={onMoveUp}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${line.description} down`}
              disabled={busy || !onMoveDown}
              onClick={onMoveDown}
            >
              <ArrowDown />
            </Button>
            <CostLineDialog
              node={node}
              line={line}
              project={project}
              onSaved={onChanged}
            />
            <DeleteCostLineDialog line={line} onChanged={onChanged} />
          </div>
        )}
      </td>
    </tr>
  )
}

function CostSheetNumber({
  value,
  detail,
  emphasized = false,
}: {
  value: string
  detail?: string
  emphasized?: boolean
}) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-3 text-right align-middle font-mono text-xs tabular-nums",
        emphasized && "text-sm font-semibold text-foreground",
      )}
    >
      <div>{value}</div>
      {detail && (
        <div className="mt-0.5 font-sans text-[10px] text-muted-foreground">
          {detail}
        </div>
      )}
    </td>
  )
}

function CostLineDialog({
  node,
  line,
  project,
  initialKind,
  onSaved,
}: {
  node: CostNode
  line?: CostLine
  project: ProjectDetail["project"]
  initialKind?: CostKind
  onSaved: () => Promise<void>
}) {
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<CostKind>("material")
  const [useStockSize, setUseStockSize] = useState(false)
  const [stockSizeId, setStockSizeId] = useState("")
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [useDescription, setUseDescription] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [multiplierSearch, setMultiplierSearch] = useState("")
  const [selectedMultiplierId, setSelectedMultiplierId] = useState<
    string | null
  >(null)
  const [fraction, setFraction] = useState("1")
  const [productionVolume, setProductionVolume] = useState("3000")
  const [sizeInputs, setSizeInputs] = useState<Record<string, string>>({})
  const [saveConflict, setSaveConflict] = useState(false)

  useEffect(() => {
    if (!open) return
    const nextKind = line?.kind ?? initialKind ?? "material"
    setKind(nextKind)
    setSearch(line?.description ?? "")
    setSelectedId(line?.catalogue_item_id ?? null)
    setUseDescription(line?.use_description ?? "")
    setQuantity(line?.quantity ?? "1")
    setMultiplierSearch("")
    setSelectedMultiplierId(
      nextKind === "process"
        ? (line?.multiplier_catalogue_item_id ?? null)
        : null,
    )
    setFraction(line?.fraction_included ?? "1")
    setProductionVolume(line?.production_volume_factor ?? "3000")
    const previousInputs = parseSizeInputs(line?.size_inputs_json)
    setSizeInputs(previousInputs)
    setUseStockSize(Boolean(previousInputs.stockSizeCatalogueItemId))
    setStockSizeId(previousInputs.stockSizeCatalogueItemId ?? "")
    setSaveConflict(false)
    // Keep an in-progress cost-line draft intact across background refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKind, open, line?.id])

  const catalogue = useQuery({
    queryKey: ["catalogue", project.catalogue_release_id, kind, search],
    queryFn: () =>
      api.catalogue(project.catalogue_release_id, kind, search),
    enabled: open,
  })
  const exactItem = useQuery({
    queryKey: [
      "catalogue-item",
      project.catalogue_release_id,
      selectedId,
    ],
    queryFn: () =>
      api.catalogueItem(project.catalogue_release_id, selectedId!),
    enabled: open && Boolean(selectedId),
  })
  const selected =
    exactItem.data?.item ??
    catalogue.data?.items.find((item) => item.id === selectedId) ??
    null

  const defaultMultiplierQuery = useQuery({
    queryKey: [
      "catalogue",
      project.catalogue_release_id,
      "multiplier",
      "None",
      20,
    ],
    queryFn: () =>
      api.catalogue(project.catalogue_release_id, "multiplier", "None", 20),
    enabled: open && kind !== "tooling",
  })
  const defaultMultiplier =
    defaultMultiplierQuery.data?.items.find(
      (item) =>
        item.name.trim().toLowerCase() === "none" && item.fixedCost === "1",
    ) ?? null
  const multipliers = useQuery({
    queryKey: [
      "catalogue",
      project.catalogue_release_id,
      "multiplier",
      multiplierSearch,
      100,
    ],
    queryFn: () =>
      api.catalogue(
        project.catalogue_release_id,
        "multiplier",
        multiplierSearch,
        100,
      ),
    enabled: open && kind === "process",
  })
  const effectiveMultiplierId =
    kind === "tooling"
      ? null
      : kind === "process"
        ? selectedMultiplierId ?? defaultMultiplier?.id ?? null
        : line?.kind === kind && line.multiplier_catalogue_item_id
          ? line.multiplier_catalogue_item_id
          : defaultMultiplier?.id ?? null
  const listedMultiplier =
    multipliers.data?.items.find(
      (item) => item.id === effectiveMultiplierId,
    ) ??
    defaultMultiplierQuery.data?.items.find(
      (item) => item.id === effectiveMultiplierId,
    ) ??
    null
  const exactMultiplier = useQuery({
    queryKey: [
      "catalogue-item",
      project.catalogue_release_id,
      effectiveMultiplierId,
    ],
    queryFn: () =>
      api.catalogueItem(project.catalogue_release_id, effectiveMultiplierId!),
    enabled: open && Boolean(effectiveMultiplierId) && !listedMultiplier,
  })
  const selectedMultiplier = exactMultiplier.data?.item ?? listedMultiplier

  const formulaVariables = selected
    ? requiredFormulaVariables(selected.effectiveFormula)
    : []
  const selectedInvalid =
    !selected?.fixedCost &&
    (selected?.effectiveFormulaValidation?.ok === false ||
      !selected?.effectiveFormula)
  const missingInputs = formulaVariables.some(
    (name) => !sizeInputs[name]?.trim(),
  )
  const quantityValid = isPositiveDecimal(quantity)
  const quantityLabel = fixedRateAmountLabel(selected)
  const quantityDescription = fixedRateAmountDescription(selected)
  const toolingInputsValid =
    kind !== "tooling" ||
    (isNonNegativeDecimal(fraction) &&
      isPublishedToolingPvf(productionVolume))

  const save = useMutation({
    onMutate: () => setSaveConflict(false),
    mutationFn: () => {
      if (!selected) throw new Error("Select a catalogue row")
      if (useStockSize && !stockSizeId) throw new Error("Select a stock profile")
      const body = {
        kind,
        catalogueItemId: selected.id,
        description: selected.name,
        useDescription: useDescription.trim(),
        quantity,
        multiplierCatalogueItemId:
          kind === "tooling" ? null : effectiveMultiplierId,
        fractionIncluded: fraction,
        productionVolumeFactor:
          kind === "tooling" ? productionVolume : null,
        sizeInputs: {
          ...Object.fromEntries(Object.entries(sizeInputs).filter(([key]) => key !== "stockSizeCatalogueItemId")),
          ...(useStockSize && stockSizeId ? { stockSizeCatalogueItemId: stockSizeId } : {}),
        },
      }
      return line
        ? api.updateCostLine(line.id, {
            ...body,
            expectedVersion: line.version,
          })
        : api.createCostLine(node.id, body)
    },
    onSuccess: async () => {
      toast.success(line ? "Cost line updated" : "Catalogue cost line added")
      setOpen(false)
      await onSaved()
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "version-conflict") {
        setSaveConflict(true)
        toast.error(
          "This cost line changed elsewhere. Your edit was not applied; close and reopen it to load the latest version.",
        )
        await onSaved()
        return
      }
      showMutationError(error)
    },
  })

  const changeKind = (category: CostKind | "stock-size") => {
    const nextKind = category === "stock-size" ? "material" : category
    setUseStockSize(category === "stock-size")
    setStockSizeId("")
    setKind(nextKind)
    setSearch("")
    setSelectedId(null)
    setMultiplierSearch("")
    setSelectedMultiplierId(null)
    setSizeInputs({})
    setFraction("1")
    setProductionVolume("3000")
  }
  const costDraftDirty =
    open &&
    (useStockSize !== Boolean(parseSizeInputs(line?.size_inputs_json).stockSizeCatalogueItemId) ||
      stockSizeId !== (parseSizeInputs(line?.size_inputs_json).stockSizeCatalogueItemId ?? "") ||
      kind !== (line?.kind ?? initialKind ?? "material") ||
      search !== (line?.description ?? "") ||
      selectedId !== (line?.catalogue_item_id ?? null) ||
      useDescription !== (line?.use_description ?? "") ||
      quantity !== (line?.quantity ?? "1") ||
      selectedMultiplierId !==
        ((line?.kind ?? initialKind) === "process"
          ? (line?.multiplier_catalogue_item_id ?? null)
          : null) ||
      multiplierSearch !== "" ||
      fraction !== (line?.fraction_included ?? "1") ||
      productionVolume !==
        (line?.production_volume_factor ?? "3000") ||
      JSON.stringify(sizeInputs) !==
        JSON.stringify(parseSizeInputs(line?.size_inputs_json)))

  useUnsavedChangesRegistration(
    `cost-line:${line?.id ?? `${node.id}:${initialKind ?? "new"}`}`,
    costDraftDirty,
    { label: line ? `${line.description} cost line` : "New cost line" },
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !costDraftDirty) setOpen(nextOpen)
      }}
    >
      {line ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${line.description}`}
          onClick={() => setOpen(true)}
        >
          <Pencil />
        </Button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus data-icon="inline-start" />
          Add{" "}
          {initialKind
            ? nodeKindLabel(initialKind).toLowerCase()
            : "line"}
        </Button>
      )}

      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!costDraftDirty}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {line ? "Edit catalogue cost line" : "Add a catalogue cost line"}
          </DialogTitle>
        </DialogHeader>

        {line && <PreviousCosting line={line} />}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-cost-kind`}>
              Cost category
            </FieldLabel>
            <Select
              value={useStockSize ? "stock-size" : kind}
              onValueChange={(value) => changeKind(value as CostKind | "stock-size")}
            >
              <SelectTrigger
                id={`${fieldId}-cost-kind`}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="stock-size">Stock sizes</SelectItem>
                  {costKinds.map((value) => (
                    <SelectItem key={value} value={value}>
                      {nodeKindLabel(value)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {useStockSize && <StockSizePicker releaseId={project.catalogue_release_id} value={stockSizeId} onChange={setStockSizeId} />}
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-search`}>
              {useStockSize ? "Material price · " : "Search "}{project.catalogue_revision}
            </FieldLabel>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id={`${fieldId}-catalogue-search`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or catalogue ID"
                className="pl-9"
              />
            </div>
          </Field>

          {catalogue.isError && catalogue.data && (
            <QueryError
              error={catalogue.error}
              title="Catalogue results may be out of date"
              onRetry={() => catalogue.refetch()}
              isRetrying={catalogue.isFetching}
              compact
            />
          )}

          <div
            className="max-h-48 overflow-y-auto rounded-lg border"
            aria-label={`${nodeKindLabel(kind)} catalogue results`}
          >
            {catalogue.isLoading ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : catalogue.isError && !catalogue.data ? (
              <QueryError
                error={catalogue.error}
                title="Could not search the catalogue"
                onRetry={() => catalogue.refetch()}
                isRetrying={catalogue.isFetching}
                compact
                className="m-3"
              />
            ) : catalogue.data?.items.length ? (
              catalogue.data.items.map((item) => (
                <button
                  type="button"
                  aria-pressed={selectedId === item.id}
                  key={item.id}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                    selectedId === item.id && "bg-primary/5",
                  )}
                  onClick={() => {
                    setSelectedId(item.id)
                    const matchesImportedDescription = !line?.catalogue_item_id &&
                      line?.description.trim().toLowerCase() === item.name.trim().toLowerCase()
                    if (item.id !== selectedId && !matchesImportedDescription) setSizeInputs({})
                  }}
                >
                  <span
                    className={cn(
                      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                      selectedId === item.id &&
                        "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {selectedId === item.id && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {item.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <CatalogueProvenanceBadge
                        provenance={item.provenance}
                        revision={item.revision}
                      />
                      <span>{catalogueSourceDescription(item)}</span>
                      <span>· Unit {item.unit ?? "not recorded"}</span>
                    </span>
                  </span>
                  <span className="text-xs font-medium tabular-nums">
                    {item.fixedCost
                      ? `U$ ${universal(item.fixedCost)}`
                      : item.effectiveFormula
                        ? "Formula"
                        : "Unavailable"}
                  </span>
                </button>
              ))
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No matching catalogue rows.
              </div>
            )}
          </div>

          {exactItem.isError && (
            <QueryError
              error={exactItem.error}
              title="Could not load the selected catalogue row"
              onRetry={() => exactItem.refetch()}
              isRetrying={exactItem.isFetching}
              compact
            />
          )}

          {selected && (
            <CatalogueSelection
              item={selected}
              invalid={selectedInvalid}
              variables={formulaVariables}
              sizeInputs={sizeInputs}
              onSizeInputsChange={setSizeInputs}
            />
          )}

          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-cost-use`}>
                Use on this item
              </FieldLabel>
              <Input
                id={`${fieldId}-cost-use`}
                value={useDescription}
                onChange={(event) =>
                  setUseDescription(event.target.value)
                }
                placeholder="What this line applies to"
              />
            </Field>

            <Field data-invalid={!quantityValid}>
              <FieldLabel htmlFor={`${fieldId}-cost-quantity`}>
                {quantityLabel}
              </FieldLabel>
              <Input
                id={`${fieldId}-cost-quantity`}
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                aria-invalid={!quantityValid}
              />
              {quantityDescription && (
                <FieldDescription>{quantityDescription}</FieldDescription>
              )}
              {!quantityValid && (
                <FieldError>Enter an amount greater than zero.</FieldError>
              )}
            </Field>

            {kind === "tooling" ? (
              <>
                <Field data-invalid={!isNonNegativeDecimal(fraction)}>
                  <FieldLabel htmlFor={`${fieldId}-cost-fraction`}>
                    Fraction included
                  </FieldLabel>
                  <Input
                    id={`${fieldId}-cost-fraction`}
                    inputMode="decimal"
                    value={fraction}
                    onChange={(event) => setFraction(event.target.value)}
                    aria-invalid={!isNonNegativeDecimal(fraction)}
                  />
                  {!isNonNegativeDecimal(fraction) && (
                    <FieldError>
                      Enter zero or a positive decimal.
                    </FieldError>
                  )}
                </Field>

                <Field data-invalid={!isPublishedToolingPvf(productionVolume)}>
                  <FieldLabel htmlFor={`${fieldId}-cost-pvf`}>
                    Production class
                  </FieldLabel>
                  <Select
                    value={productionVolume}
                    onValueChange={setProductionVolume}
                  >
                    <SelectTrigger
                      id={`${fieldId}-cost-pvf`}
                      className="w-full"
                      aria-invalid={!isPublishedToolingPvf(productionVolume)}
                    >
                      <SelectValue placeholder="Select a production class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {!isPublishedToolingPvf(productionVolume) &&
                          productionVolume && (
                            <SelectItem value={productionVolume} disabled>
                              Legacy/custom · PVF {productionVolume}
                            </SelectItem>
                          )}
                        {toolingProductionClasses.map((productionClass) => (
                          <SelectItem
                            key={productionClass.value}
                            value={productionClass.value}
                          >
                            {productionClass.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Use PVF 120 only for composite-monocoque tooling; all
                    standard tooling uses PVF 3000.
                  </FieldDescription>
                  {!isPublishedToolingPvf(productionVolume) && (
                    <FieldError>
                      Choose one of the published 2026 production classes.
                    </FieldError>
                  )}
                </Field>
              </>
            ) : kind === "process" ? (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${fieldId}-cost-multiplier-search`}>
                  Process multiplier
                </FieldLabel>
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id={`${fieldId}-cost-multiplier-search`}
                    value={multiplierSearch}
                    onChange={(event) =>
                      setMultiplierSearch(event.target.value)
                    }
                    placeholder="Search multiplier name or catalogue ID"
                    className="pl-9"
                  />
                </div>
                {multipliers.isError && !multipliers.data ? (
                  <QueryError
                    error={multipliers.error}
                    title="Could not search catalogue multipliers"
                    onRetry={() => multipliers.refetch()}
                    isRetrying={multipliers.isFetching}
                    compact
                  />
                ) : (
                  <div
                    className="max-h-44 overflow-y-auto rounded-lg border"
                    role="listbox"
                    aria-label="Process multiplier results"
                  >
                    {multipliers.isLoading ? (
                      <div className="flex flex-col gap-2 p-3">
                        <Skeleton className="h-10" />
                        <Skeleton className="h-10" />
                      </div>
                    ) : multipliers.data?.items.length ? (
                      multipliers.data.items.map((item) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={effectiveMultiplierId === item.id}
                          key={item.id}
                          disabled={!item.fixedCost}
                          className={cn(
                            "flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50",
                            effectiveMultiplierId === item.id && "bg-primary/5",
                          )}
                          onClick={() => setSelectedMultiplierId(item.id)}
                        >
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-full border",
                              effectiveMultiplierId === item.id &&
                                "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {effectiveMultiplierId === item.id && (
                              <Check className="size-3" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {item.name}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <CatalogueProvenanceBadge
                                provenance={item.provenance}
                                revision={item.revision}
                              />
                              <span>{catalogueSourceDescription(item)}</span>
                            </span>
                          </span>
                          <span className="font-mono text-sm font-semibold tabular-nums">
                            ×{item.fixedCost ?? "—"}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="p-5 text-center text-sm text-muted-foreground">
                        No matching multipliers.
                      </div>
                    )}
                  </div>
                )}
                {selectedMultiplier ? (
                  <FieldDescription>
                    Selected #{selectedMultiplier.catalogueId}{" "}
                    {selectedMultiplier.name} · ×{selectedMultiplier.fixedCost}.
                    {" "}{catalogueSourceDescription(selectedMultiplier)}.
                  </FieldDescription>
                ) : (
                  <FieldError>
                    The catalogue's None ×1 multiplier could not be resolved.
                  </FieldError>
                )}
              </Field>
            ) : (
              <Field className="sm:col-span-2">
                <FieldLabel>Multiplier</FieldLabel>
                {defaultMultiplierQuery.isError || exactMultiplier.isError ? (
                  <QueryError
                    error={defaultMultiplierQuery.error ?? exactMultiplier.error}
                    title="Could not load the default multiplier"
                    onRetry={() => {
                      void defaultMultiplierQuery.refetch()
                      void exactMultiplier.refetch()
                    }}
                    isRetrying={
                      defaultMultiplierQuery.isFetching ||
                      exactMultiplier.isFetching
                    }
                    compact
                  />
                ) : defaultMultiplierQuery.isLoading ||
                  exactMultiplier.isLoading ? (
                  <Skeleton className="h-16" />
                ) : selectedMultiplier ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/35 px-3 py-2.5">
                    <div>
                      <div className="text-sm font-medium">
                        {selectedMultiplier.name} ×{selectedMultiplier.fixedCost}
                      </div>
                      {selectedMultiplier.id !== defaultMultiplier?.id && (
                        <div className="text-xs text-muted-foreground">
                          Existing catalogue multiplier preserved on this line.
                        </div>
                      )}
                    </div>
                    <Badge variant="outline">
                      {selectedMultiplier.id === defaultMultiplier?.id
                        ? "Default"
                        : "Existing"}
                    </Badge>
                    <CatalogueProvenanceBadge
                      provenance={selectedMultiplier.provenance}
                      revision={selectedMultiplier.revision}
                    />
                  </div>
                ) : (
                  <FieldError>
                    The catalogue's None ×1 multiplier could not be resolved.
                  </FieldError>
                )}
              </Field>
            )}
          </FieldGroup>
        </FieldGroup>

        {saveConflict && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Reload before saving</AlertTitle>
            <AlertDescription>
              The draft is preserved for reference, but saving is locked until
              this dialog is closed and reopened against the latest line.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              saveConflict ||
              !selected ||
              selectedInvalid ||
              missingInputs ||
              (useStockSize && !stockSizeId) ||
              !quantityValid ||
              !toolingInputsValid ||
              (kind !== "tooling" && !selectedMultiplier)
            }
          >
            {save.isPending && (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin"
              />
            )}
            {line ? "Recalculate and save" : "Calculate and add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CatalogueSelection({
  item,
  invalid,
  variables,
  sizeInputs,
  onSizeInputsChange,
}: {
  item: CatalogueItem
  invalid: boolean
  variables: string[]
  sizeInputs: Record<string, string>
  onSizeInputsChange: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >
}) {
  const fieldId = useId()
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{item.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {catalogueSourceDescription(item)}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <CatalogueProvenanceBadge
            provenance={item.provenance}
            revision={item.revision}
          />
          <Badge variant="outline">
            Unit: {item.unit ?? "not recorded"}
            {item.unit2 ? ` · ${item.unit2}` : ""}
          </Badge>
          <Badge variant="outline">
            {item.fixedCost ? "Fixed cost" : "Formula cost"}
          </Badge>
        </div>
      </div>

      {item.formulaCorrection ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <div className="mb-1 text-muted-foreground">Source formula</div>
            <code className="block overflow-x-auto rounded bg-background p-2 text-[11px]">
              {item.sourceFormula}
            </code>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground">Applied formula</div>
            <code className="block overflow-x-auto rounded bg-background p-2 text-[11px]">
              {item.effectiveFormula}
            </code>
          </div>
        </div>
      ) : (
        item.effectiveFormula && (
          <code className="mt-3 block overflow-x-auto rounded bg-background p-2 text-[11px]">
            {item.effectiveFormula}
          </code>
        )
      )}

      {item.formulaCorrection && (
        <Alert className="mt-3">
          <CircleAlert />
          <AlertTitle>Catalogue correction applied</AlertTitle>
          <AlertDescription>
            {item.formulaCorrection.reason} The original workbook value remains
            visible above for traceability.
          </AlertDescription>
        </Alert>
      )}

      {item.latestChange && (
        <Alert className="mt-3">
          <CircleAlert />
          <AlertTitle>
            {item.provenance === "team" ? "Team row" : "Edited catalogue row"}
          </AlertTitle>
          <AlertDescription>
            {item.latestChange.reason} Published by{" "}
            {item.latestChange.createdBy.displayName}.
            {item.latestChange.evidence
              ? ` Evidence: ${item.latestChange.evidence}`
              : ""}
          </AlertDescription>
        </Alert>
      )}

      {invalid ? (
        <Alert variant="destructive" className="mt-3">
          <CircleAlert />
          <AlertTitle>Catalogue row cannot be calculated</AlertTitle>
          <AlertDescription>
            This source row is incomplete or malformed and has no verified
            calculation correction. It remains visible for traceability but
            cannot be used.
          </AlertDescription>
        </Alert>
      ) : (
        variables.length > 0 && (
          <FieldGroup className="mt-4 grid gap-3 sm:grid-cols-2">
            {variables.map((variable) => (
              <Field key={variable}>
                <FieldLabel htmlFor={`${fieldId}-${variable}`}>
                  {formulaInputLabelWithUnit(item, variable)}
                </FieldLabel>
                <Input
                  id={`${fieldId}-${variable}`}
                  inputMode="decimal"
                  value={sizeInputs[variable] ?? ""}
                  onChange={(event) =>
                    onSizeInputsChange((current) => ({
                      ...current,
                      [variable]: event.target.value,
                    }))
                  }
                  placeholder={formulaInputUnit(item, variable)}
                />
              </Field>
            ))}
          </FieldGroup>
        )
      )}
    </div>
  )
}

function DeleteCostLineDialog({
  line,
  onChanged,
}: {
  line: CostLine
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.deleteCostLine(line.id, line.version),
    onSuccess: async () => {
      toast.success("Cost line removed")
      setOpen(false)
      await onChanged()
    },
    onError: showMutationError,
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${line.description}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this cost line?</DialogTitle>
          <DialogDescription>
            “{line.description}” and its U$ {universal(line.subtotal)} subtotal
            will be removed from every ancestor total. Existing report
            snapshots remain immutable.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            {remove.isPending && (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin"
              />
            )}
            Remove line
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MoveHierarchyDialog({
  node,
  nodes,
  recordDirty,
  onChanged,
}: {
  node: CostNode
  nodes: readonly CostNode[]
  recordDirty: boolean
  onChanged: () => Promise<void>
}) {
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<EditableNodeKind>(
    node.kind as EditableNodeKind,
  )
  const [targetParentId, setTargetParentId] = useState("")
  const excludedIds = useMemo(() => {
    const ids = new Set([node.id])
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of nodes) {
        if (
          candidate.parent_id &&
          ids.has(candidate.parent_id) &&
          !ids.has(candidate.id)
        ) {
          ids.add(candidate.id)
          changed = true
        }
      }
    }
    return ids
  }, [node.id, nodes])
  const parentsFor = (nextKind: EditableNodeKind) =>
    nodes.filter(
      (candidate) =>
        candidate.system_code === node.system_code &&
        !excludedIds.has(candidate.id) &&
        canCreateChild(candidate.kind, nextKind),
    )
  const eligibleParents = parentsFor(kind)
  const targetParent = eligibleParents.find(
    (candidate) => candidate.id === targetParentId,
  )
  const noChange = node.kind === kind && node.parent_id === targetParentId

  const openDialog = () => {
    const initialKind = node.kind as EditableNodeKind
    const initialParents = parentsFor(initialKind)
    setKind(initialKind)
    setTargetParentId(
      initialParents.some((candidate) => candidate.id === node.parent_id)
        ? (node.parent_id ?? "")
        : (initialParents[0]?.id ?? ""),
    )
    setOpen(true)
  }

  const move = useMutation({
    mutationFn: () => {
      if (!targetParent) throw new Error("Choose a destination")
      return api.moveNode(node.id, {
        expectedVersion: node.version,
        targetParentId: targetParent.id,
        expectedTargetParentVersion: targetParent.version,
        kind,
      })
    },
    onSuccess: async () => {
      toast.success(`${node.name} moved`)
      setOpen(false)
      await onChanged()
    },
    onError: showMutationError,
  })

  const changeKind = (nextKind: EditableNodeKind) => {
    const nextParents = parentsFor(nextKind)
    setKind(nextKind)
    setTargetParentId(
      nextParents.some((candidate) => candidate.id === targetParentId)
        ? targetParentId
        : (nextParents[0]?.id ?? ""),
    )
  }

  return (
    <section aria-labelledby={`${fieldId}-hierarchy-heading`}>
      <h3 id={`${fieldId}-hierarchy-heading`} className="font-semibold">
        Hierarchy placement
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Correct this item's level or move it elsewhere in {node.system_code}.
        Its costs, evidence, and children stay attached.
      </p>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOpen(false)
        }}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={recordDirty}
          title={recordDirty ? "Save or discard record edits before moving" : undefined}
          onClick={openDialog}
        >
          <ArrowRightLeft data-icon="inline-start" />
          Move or change level
        </Button>
        {recordDirty && (
          <p className="mt-2 text-xs text-amber-700">
            Save or discard the record edits above before moving this item.
          </p>
        )}

        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Move or change hierarchy level</DialogTitle>
            <DialogDescription>
              Choose the corrected level and its parent inside the same system.
              Nothing is copied or matched automatically.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-move-kind`}>New level</FieldLabel>
              <Select
                value={kind}
                disabled={node.kind === "part"}
                onValueChange={(value) =>
                  changeKind(value as EditableNodeKind)
                }
              >
                <SelectTrigger id={`${fieldId}-move-kind`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="assembly">Assembly</SelectItem>
                    <SelectItem value="subassembly">Subassembly</SelectItem>
                    {node.kind === "part" && (
                      <SelectItem value="part">Part</SelectItem>
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {node.kind === "part" && (
                <FieldDescription>
                  Parts stay parts when moved; only their parent changes.
                </FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-move-parent`}>Place under</FieldLabel>
              {eligibleParents.length > 0 ? (
                <Select value={targetParentId} onValueChange={setTargetParentId}>
                  <SelectTrigger id={`${fieldId}-move-parent`} className="w-full">
                    <SelectValue placeholder="Choose a parent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {eligibleParents.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name} · {nodeKindLabel(candidate.kind)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <FieldError>
                  There is no valid {kind} destination in this system yet.
                </FieldError>
              )}
            </Field>
          </FieldGroup>

          {targetParent && (
            <div className="rounded-lg border bg-muted/25 p-4 text-sm">
              <div className="font-medium">
                {node.name} will {kind === "part" ? "remain" : "become"}{" "}
                {kind === "assembly" ? "an" : "a"}{" "}
                {nodeKindLabel(kind).toLowerCase()} under {targetParent.name}.
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Cost lines, children, evidence, and imported source references
                stay attached.
              </p>
            </div>
          )}

          <Alert>
            <CircleAlert />
            <AlertTitle>Controlled numbers are preserved</AlertTitle>
            <AlertDescription>
              This move does not rewrite this item's controlled number or its
              descendants. Review those identifiers after the hierarchy is correct.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => move.mutate()}
              disabled={!targetParent || noChange || move.isPending}
            >
              {move.isPending && (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              )}
              Confirm move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function DeleteNodeDialog({
  node,
  onChanged,
  onDeleted,
}: {
  node: CostNode
  onChanged: () => Promise<void>
  onDeleted: (nodeId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const descendants = countDescendants(node)
  const directAndNestedLines = countCostLines(node)
  const remove = useMutation({
    mutationFn: () => api.deleteNode(node.id, node.version, true),
    onSuccess: async () => {
      toast.success(`${nodeKindLabel(node.kind)} deleted`)
      setOpen(false)
      onDeleted(node.id)
      await onChanged()
    },
    onError: showMutationError,
  })

  return (
    <section>
      <h3 className="font-semibold text-destructive">Delete item</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Deletion affects the editable BOM only. Generated report snapshots
        remain unchanged.
      </p>
      <Button
        variant="destructive"
        size="sm"
        className="mt-3"
        onClick={() => setOpen(true)}
      >
        <Trash2 data-icon="inline-start" />
        Delete {nodeKindLabel(node.kind).toLowerCase()}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {node.name}?</DialogTitle>
            <DialogDescription>
              This removes the selected {node.kind}
              {descendants > 0
                ? `, ${descendants} descendant${descendants === 1 ? "" : "s"}`
                : ""}
              {directAndNestedLines > 0
                ? `, and ${directAndNestedLines} cost line${directAndNestedLines === 1 ? "" : "s"}`
                : ""}
              . Imported source rows remain in the audit trail with their live
              node link cleared.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>This cannot be undone in the live BOM</AlertTitle>
            <AlertDescription>
              Use a database backup if you may need to restore this editable
              hierarchy later.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              Delete item and contents
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function EvidencePanel({
  projectId,
  node,
  onDrawingSaved,
  readOnly,
  imageInputRef,
  drawingInputRef,
  onChanged,
}: {
  projectId: string
  node: CostNode
  onDrawingSaved: (
    nodeId: string,
    previousVersion: number,
    nextVersion: number,
  ) => void
  readOnly: boolean
  imageInputRef: RefObject<HTMLInputElement | null>
  drawingInputRef: RefObject<HTMLInputElement | null>
  onChanged: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const fieldId = useId()
  const [drafts, setDrafts] = useState<
    Partial<Record<Evidence["kind"], EvidenceUploadDraft>>
  >({})
  const nodeId = node.id
  const imageRequired = node.image_required !== false
  const [imageExemptionOpen, setImageExemptionOpen] = useState(false)
  const [imageReason, setImageReason] = useState("")
  const imageRequirement = useMutation({
    mutationFn: (required: boolean) => api.updateNode(node.id, {
      expectedVersion: node.version,
      imageRequired: required,
      imageRequirementReason: required ? "" : imageReason.trim(),
    }),
    onSuccess: async ({ node: saved }) => {
      onDrawingSaved(saved.id, saved.version - 1, saved.version)
      setImageExemptionOpen(false)
      await onChanged()
      toast.success("Isometric image requirement updated")
    },
    onError: async (error) => {
      showMutationError(error)
      await onChanged()
    },
  })
  const drawingRequired = node.drawing_required !== false
  const drawingRequirement = useMutation({
    mutationFn: (required: boolean) =>
      api.updateNode(node.id, {
        expectedVersion: node.version,
        drawingRequired: required,
      }),
    onSuccess: async ({ node: saved }) => {
      // This mutation changes only the drawing flag. Keep any local detail
      // draft while advancing its version, unless it was already stale.
      onDrawingSaved(saved.id, saved.version - 1, saved.version)
      await onChanged()
      toast.success("Drawing requirement updated")
    },
    onError: async (error) => {
      showMutationError(error)
      await onChanged()
    },
  })
  const [additionalKind, setAdditionalKind] =
    useState<Evidence["kind"]>("manufacturing")
  const evidence = useQuery({
    queryKey: ["evidence", projectId],
    queryFn: () => api.evidence(projectId),
  })
  const related =
    evidence.data?.evidence.filter((item) => item.node_id === nodeId) ?? []
  const reportEvidence = related.filter((item) => item.visibility === "report")
  const attachedKinds = new Set(reportEvidence.map((item) => item.kind))
  const requiredComplete = evidenceRequirements.filter(
    (requirement) =>
      requirement.required &&
      (attachedKinds.has(requirement.kind) ||
        (requirement.kind === "drawing" && !drawingRequired) ||
        (requirement.kind === "image" && !imageRequired)),
  ).length
  const hasUnsavedEvidence = Object.values(drafts).some((draft) =>
    Boolean(draft?.files.length || draft?.caption),
  )

  const updateDraft = (
    kind: Evidence["kind"],
    update: Partial<EvidenceUploadDraft>,
  ) => {
    setDrafts((current) => ({
      ...current,
      [kind]: {
        ...emptyEvidenceUploadDraft,
        ...current[kind],
        ...update,
      },
    }))
  }

  useUnsavedChangesRegistration(
    `evidence-upload:${nodeId}`,
    hasUnsavedEvidence,
    { label: "Evidence upload" },
  )

  const uploadEvidence = useMutation({
    mutationFn: async ({
      kind,
      files,
      caption,
    }: {
      kind: Evidence["kind"]
      files: File[]
      caption: string
    }) => {
      try {
        for (const file of files) {
          await api.uploadEvidence(projectId, file, {
            kind,
            nodeId,
            reportCaption:
              files.length > 1 ? `${caption} — ${file.name}` : caption,
          })
          // Remove each successful upload immediately so retries only send remaining files.
          setDrafts((current) => ({
            ...current,
            [kind]: {
              ...(current[kind] ?? emptyEvidenceUploadDraft),
              files: (current[kind]?.files ?? []).filter(
                (pending) => pending !== file,
              ),
            },
          }))
        }
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["evidence", projectId] }),
          onChanged(),
        ])
      }
    },
    onSuccess: (_, { kind, files }) => {
      toast.success(
        files.length > 1
          ? `${files.length} drawings attached`
          : `${evidenceKindLabel(kind)} attached`,
      )
      setDrafts((current) => {
        const next = { ...current }
        delete next[kind]
        return next
      })
    },
    onError: showMutationError,
  })

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="evidence-heading"
            tabIndex={-1}
            className="scroll-mt-24 font-semibold outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
          >
            Attachments
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Attach report-visible visuals, or mark an image or drawing as not required.
            Include a datasheet when useful.
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            requiredComplete === requiredEvidenceCount &&
              "border-emerald-200 text-emerald-700",
          )}
        >
          {evidence.isLoading
            ? "Loading…"
            : evidence.isError && !evidence.data
              ? "Unavailable"
              : `${requiredComplete} of ${requiredEvidenceCount} required`}
        </Badge>
      </div>

      <div
        role="list"
        aria-label="Evidence requirements"
        className="mt-4 divide-y overflow-hidden rounded-lg border"
      >
        {evidenceRequirements.map((requirement) => {
          const attached = attachedKinds.has(requirement.kind)
          const exempt = (requirement.kind === "drawing" && !drawingRequired) ||
            (requirement.kind === "image" && !imageRequired)
          const excluded = !attached && related.some((item) => item.kind === requirement.kind)
          const draft = drafts[requirement.kind] ?? emptyEvidenceUploadDraft
          const uploading =
            uploadEvidence.isPending &&
            uploadEvidence.variables?.kind === requirement.kind

          return (
            <section
              key={requirement.kind}
              role="listitem"
              className="px-3 py-3"
            >
              <div
                className={cn(
                  "grid gap-3",
                  draft.files.length === 0 &&
                    !readOnly &&
                    "sm:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] sm:items-center",
                )}
              >
                <div className="flex items-center gap-3">
                  {attached || exempt ? (
                    <Check className="size-4 shrink-0 text-emerald-700" />
                  ) : requirement.required ? (
                    <CircleAlert className="size-4 shrink-0 text-amber-700" />
                  ) : (
                    <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <h4 className="text-sm font-medium">
                        {requirement.label}
                      </h4>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {exempt
                          ? "Not required"
                          : requirement.required
                            ? "Required"
                            : "Optional"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {requirement.description}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0",
                      (attached || exempt) &&
                        "border-emerald-200 text-emerald-700",
                      !attached &&
                        !exempt &&
                        requirement.required &&
                        "border-amber-200 text-amber-800",
                    )}
                  >
                    {exempt
                      ? "Not required"
                      : attached
                        ? `${reportEvidence.filter((item) => item.kind === requirement.kind).length} attached`
                        : excluded
                          ? "Excluded from report"
                        : requirement.required
                          ? "Missing"
                          : "Not attached"}
                  </Badge>
                </div>
                {!readOnly && (
                  <EvidenceUploadFields
                    idPrefix={`${fieldId}-${requirement.kind}`}
                    kind={requirement.kind}
                    label={requirement.label}
                    fileInputRef={
                      requirement.kind === "image"
                        ? imageInputRef
                        : requirement.kind === "drawing"
                          ? drawingInputRef
                          : undefined
                    }
                    draft={draft}
                    pending={uploadEvidence.isPending}
                    uploading={uploading}
                    inlineWhenEmpty
                    onFileChange={(files) =>
                      updateDraft(requirement.kind, { files })
                    }
                    onCaptionChange={(caption) =>
                      updateDraft(requirement.kind, { caption })
                    }
                    onAttach={() =>
                      uploadEvidence.mutate({
                        kind: requirement.kind,
                        files: draft.files,
                        caption: draft.caption.trim(),
                      })
                    }
                  />
                )}
              </div>
              {requirement.kind === "image" && (
                <div className="mt-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={!imageRequired}
                      disabled={readOnly || imageRequirement.isPending || drawingRequirement.isPending}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setImageReason(node.image_requirement_reason ?? "")
                          setImageExemptionOpen(true)
                        } else {
                          imageRequirement.mutate(true)
                        }
                      }}
                    />
                    Isometric image not required
                  </label>
                  {!imageRequired && node.image_requirement_reason && (
                    <p className="mt-1 ml-6 text-xs text-muted-foreground">
                      Reason: {node.image_requirement_reason}
                    </p>
                  )}
                </div>
              )}
              {requirement.kind === "drawing" && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={!drawingRequired}
                    disabled={readOnly || drawingRequirement.isPending || imageRequirement.isPending}
                    onChange={(event) =>
                      drawingRequirement.mutate(!event.target.checked)
                    }
                  />
                  Drawing not required
                </label>
              )}
            </section>
          )
        })}
      </div>

      <Dialog open={imageExemptionOpen} onOpenChange={(open) => {
        if (!imageRequirement.isPending) setImageExemptionOpen(open)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Isometric image not required</DialogTitle>
            <DialogDescription>
              Record why {node.name} does not need an isometric image for costing.
              You can make it required again at any time.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-image-reason`}>Reason</FieldLabel>
            <Textarea id={`${fieldId}-image-reason`} value={imageReason}
              onChange={(event) => setImageReason(event.target.value)}
              maxLength={500} disabled={imageRequirement.isPending}
              placeholder="Explain why an isometric image is not needed" />
          </Field>
          <DialogFooter>
            <Button variant="outline" disabled={imageRequirement.isPending}
              onClick={() => setImageExemptionOpen(false)}>Cancel</Button>
            <Button disabled={!imageReason.trim() || imageRequirement.isPending}
              onClick={() => imageRequirement.mutate(false)}>Save exemption</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!readOnly && (
        <details className="mt-3 rounded-lg border">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium marker:text-muted-foreground">
            Other supporting evidence
          </summary>
          <div className="border-t px-3 py-3">
            <Field className="max-w-xs">
              <FieldLabel htmlFor={`${fieldId}-additional-kind`}>
                Evidence type
              </FieldLabel>
              <Select
                value={additionalKind}
                onValueChange={(value) =>
                  setAdditionalKind(value as Evidence["kind"])
                }
              >
                <SelectTrigger
                  id={`${fieldId}-additional-kind`}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {additionalEvidenceKinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {evidenceKindLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <EvidenceUploadFields
              idPrefix={`${fieldId}-${additionalKind}`}
              kind={additionalKind}
              label={evidenceKindLabel(additionalKind)}
              draft={drafts[additionalKind] ?? emptyEvidenceUploadDraft}
              pending={uploadEvidence.isPending}
              uploading={
                uploadEvidence.isPending &&
                uploadEvidence.variables?.kind === additionalKind
              }
              onFileChange={(files) => updateDraft(additionalKind, { files })}
              onCaptionChange={(caption) =>
                updateDraft(additionalKind, { caption })
              }
              onAttach={() => {
                const draft = drafts[additionalKind]
                uploadEvidence.mutate({
                  kind: additionalKind,
                  files: draft!.files,
                  caption: draft!.caption.trim(),
                })
              }}
            />
          </div>
        </details>
      )}

      <div className="mt-5">
        {evidence.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : evidence.isError && !evidence.data ? (
          <QueryError
            error={evidence.error}
            title="Could not load evidence"
            onRetry={() => evidence.refetch()}
            isRetrying={evidence.isFetching}
          />
        ) : evidence.data && related.length > 0 ? (
          <>
            {evidence.isError && (
              <QueryError
                error={evidence.error}
                title="Evidence may be out of date"
                description="Showing the last successful response."
                onRetry={() => evidence.refetch()}
                isRetrying={evidence.isFetching}
                compact
                className="mb-3"
              />
            )}
            <h4 className="mb-2 text-sm font-semibold">Attached files</h4>
            <EvidenceList
              items={related}
              projectId={projectId}
              canWrite={!readOnly}
              onChanged={onChanged}
            />
          </>
        ) : null}
      </div>
    </section>
  )
}

function EvidenceUploadFields({
  idPrefix,
  kind,
  label,
  fileInputRef: providedFileInputRef,
  draft,
  pending,
  uploading,
  inlineWhenEmpty = false,
  onFileChange,
  onCaptionChange,
  onAttach,
}: {
  idPrefix: string
  kind: Evidence["kind"]
  label: string
  fileInputRef?: RefObject<HTMLInputElement | null>
  draft: EvidenceUploadDraft
  pending: boolean
  uploading: boolean
  inlineWhenEmpty?: boolean
  onFileChange: (files: File[]) => void
  onCaptionChange: (caption: string) => void
  onAttach: () => void
}) {
  const internalFileInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = providedFileInputRef ?? internalFileInputRef

  return (
    <FieldGroup
      className={cn(
        "grid gap-3",
        inlineWhenEmpty && draft.files.length === 0
          ? "sm:mt-0"
          : "mt-3 sm:pl-7",
        draft.files.length > 0
          ? "sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] sm:items-end"
          : !inlineWhenEmpty && "sm:max-w-sm",
      )}
    >
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-file`} className="sr-only">
          {kind === "image" ? "Image" : "File"}
        </FieldLabel>
        <input
          ref={fileInputRef}
          key={
            draft.files.map((file) => file.name).join("|") || `${kind}-empty`
          }
          id={`${idPrefix}-file`}
          aria-label={`${label} file`}
          aria-hidden="true"
          tabIndex={-1}
          type="file"
          multiple={kind === "drawing"}
          disabled={pending}
          className="sr-only"
          accept={
            kind === "image"
              ? ".png,.jpg,.jpeg,image/png,image/jpeg"
              : ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          }
          onChange={(event) =>
            onFileChange(Array.from(event.target.files ?? []))
          }
        />
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`${draft.files.length > 0 ? "Replace" : "Choose"} ${label.toLowerCase()} file`}
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip data-icon="inline-start" />
            {draft.files.length > 0
              ? "Replace file"
              : kind === "image"
                ? "Choose image"
                : kind === "drawing"
                  ? "Choose drawings"
                  : "Choose file"}
          </Button>
          {draft.files.length > 0 && (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={draft.files.map((file) => file.name).join(", ")}
            >
              {draft.files.map((file) => file.name).join(", ")}
            </span>
          )}
        </div>
      </Field>
      {draft.files.length > 0 && (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-caption`}>
              Report caption
            </FieldLabel>
            <Input
              id={`${idPrefix}-caption`}
              aria-label={`${label} report caption`}
              value={draft.caption}
              onChange={(event) => onCaptionChange(event.target.value)}
              placeholder="What this file shows"
            />
          </Field>
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={onAttach}
            disabled={pending || !draft.caption.trim()}
          >
            {uploading ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Paperclip data-icon="inline-start" />
            )}
            Attach{" "}
            {draft.files.length > 1
              ? `${draft.files.length} drawings`
              : label.toLowerCase()}
          </Button>
        </>
      )}
    </FieldGroup>
  )
}

function requiredFormulaVariables(formula: string | null): string[] {
  if (!formula) return []
  const matches = formula.match(/\[(size[1-4]|area|length|density)\]/gi) ?? []
  return [...new Set(matches.map((match) => match.slice(1, -1).toLowerCase()))]
}

function formulaInputLabel(item: CatalogueItem, variable: string): string {
  const correctedLabel = item.formulaCorrection?.inputs[variable]?.label
  if (correctedLabel) return correctedLabel
  const sourceLabel = item.metadata[variable]
  if (typeof sourceLabel === "string" && sourceLabel.trim()) {
    return sourceLabel
  }
  return variable
    .replace(/(\d)/, " $1")
    .replace(/^./, (first) => first.toUpperCase())
}

function formulaInputLabelWithUnit(
  item: CatalogueItem,
  variable: string,
): string {
  const label = formulaInputLabel(item, variable)
  const unit = formulaInputUnit(item, variable)
  return unit === "Value" ? label : `${label} (${unit})`
}

function formulaInputUnit(item: CatalogueItem, variable: string): string {
  const correctedUnit = item.formulaCorrection?.inputs[variable]?.unit
  if (correctedUnit) return correctedUnit
  if (variable === "size1") return item.unit ?? "Value"
  if (variable === "size2") return item.unit2 ?? "Value"
  return "Value"
}

function parseSizeInputs(value: string | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, String(item)]),
    )
  } catch {
    return {}
  }
}

function nodeKindLabel(kind: NodeKind | CostKind): string {
  if (kind === "subassembly") return "Subassembly"
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function isPositiveDecimal(value: string): boolean {
  const number = Number(value)
  return value.trim() !== "" && Number.isFinite(number) && number > 0
}

function isPublishedToolingPvf(value: string): value is "120" | "3000" {
  return value === "120" || value === "3000"
}

function isNonNegativeDecimal(value: string): boolean {
  const number = Number(value)
  return value.trim() !== "" && Number.isFinite(number) && number >= 0
}

function countDescendants(node: CostNode): number {
  return node.children.reduce(
    (total, child) => total + 1 + countDescendants(child),
    0,
  )
}

function countCostLines(node: CostNode): number {
  return (
    node.costLines.length +
    node.children.reduce(
      (total, child) => total + countCostLines(child),
      0,
    )
  )
}

function showMutationError(error: unknown) {
  if (error instanceof ApiError) {
    toast.error(error.message)
    return
  }
  toast.error(error instanceof Error ? error.message : "Request failed")
}
