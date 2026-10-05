import { useEffect, useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Calculator,
  CircleAlert,
  LoaderCircle,
  PencilLine,
  Plus,
  Search,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { QueryError } from "@/components/query-error"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { stockSizeDimensions } from "./stock-size-dimensions"
import { Textarea } from "@/components/ui/textarea"
import {
  CatalogueProvenanceBadge,
} from "@/features/catalogue/catalogue-provenance"
import { catalogueSourceDescription } from "@/features/catalogue/catalogue-source"
import {
  api,
  universal,
  type CatalogueItem,
  type CatalogueItemKind,
  type CataloguePublicationInput,
} from "@/lib/api"

const catalogueKinds: Array<{ value: CatalogueItemKind; label: string }> = [
  { value: "material", label: "Materials" },
  { value: "process", label: "Processes" },
  { value: "multiplier", label: "Process multipliers" },
  { value: "fastener", label: "Fasteners" },
  { value: "tooling", label: "Tooling" },
  { value: "stock-size", label: "Stock sizes" },
]

interface CatalogueDraft {
  kind: CatalogueItemKind
  name: string
  category: string
  supplier: string
  unit: string
  unit2: string
  costMode: "fixed" | "formula"
  fixedCost: string
  formula: string
  c1: string
  c2: string
  c3: string
  c4: string
  size1Label: string
  size2Label: string
  size3Label: string
  size4Label: string
  reason: string
  evidence: string
}

const emptyDraft = (kind: CatalogueItemKind): CatalogueDraft => ({
  kind,
  name: "",
  category: "",
  supplier: "",
  unit: "",
  unit2: "",
  costMode: "fixed",
  fixedCost: "",
  formula: "",
  c1: "",
  c2: "",
  c3: "",
  c4: "",
  size1Label: "",
  size2Label: "",
  size3Label: "",
  size4Label: "",
  reason: "",
  evidence: "",
})

export default function CataloguePage({
  releaseId,
  revisionLabel,
  canWrite,
}: {
  releaseId: string
  revisionLabel: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<CatalogueItemKind>("material")
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CatalogueItem | null>(null)
  const [draft, setDraft] = useState<CatalogueDraft>(() =>
    emptyDraft("material"),
  )

  const catalogue = useQuery({
    queryKey: ["catalogue", releaseId, kind, search, 100],
    queryFn: () => api.catalogue(releaseId, kind, search, 100),
  })

  const publish = useMutation({
    mutationFn: () => {
      const body = publicationInput(releaseId, draft)
      return editing
        ? api.reviseCatalogueItem(editing.id, {
            ...body,
            expectedRevision: editing.revision,
          })
        : api.createTeamCatalogueItem(body)
    },
    onSuccess: async ({ item }) => {
      setDialogOpen(false)
      setEditing(null)
      setKind(item.kind)
      setSearch(item.name)
      await queryClient.invalidateQueries({ queryKey: ["catalogue"] })
      toast.success(
        item.provenance === "team"
          ? "Team catalogue row published"
          : "Catalogue edit published",
      )
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not publish row")
    },
  })

  const openCreate = () => {
    setEditing(null)
    setDraft(emptyDraft(kind))
    setDialogOpen(true)
  }
  const openEdit = (item: CatalogueItem) => {
    setEditing(item)
    setDraft(draftFromItem(item))
    setDialogOpen(true)
  }

  return (
    <section className="space-y-5" aria-labelledby="catalogue-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Shared costing source
          </div>
          <h2 id="catalogue-heading" className="mt-1 text-2xl font-semibold">
            Catalogue
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Browse {revisionLabel}, add team-specific rows, or publish a labelled
            effective edit. Official workbook rows remain unchanged underneath.
          </p>
        </div>
        {canWrite ? (
          <Button onClick={openCreate}>
            <Plus data-icon="inline-start" />
            Add team row
          </Button>
        ) : (
          <Badge variant="outline">Viewer · read-only</Badge>
        )}
      </div>

      <Alert>
        <CircleAlert />
        <AlertTitle>Shared immediately, history preserved</AlertTitle>
        <AlertDescription>
          New selections and explicit recalculations use the latest published
          row. Existing saved cost lines keep their recorded values until a user
          opens and recalculates them.
        </AlertDescription>
      </Alert>

      <Tabs value={kind} onValueChange={(value) => { setKind(value as CatalogueItemKind); setSearch("") }}>
        <TabsList aria-label="Catalogue sections" className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-auto sm:grid-cols-3 lg:grid-cols-6">
          {catalogueKinds.map((option) => <TabsTrigger key={option.value} value={option.value} className="h-8">{option.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={kind}>
      <Card>
        <CardHeader>
          <CardTitle>Find catalogue rows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FieldGroup className="grid gap-4 md:grid-cols-[240px_1fr]">
            <Field>
              <FieldLabel htmlFor="catalogue-kind">Catalogue section</FieldLabel>
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value as CatalogueItemKind)
                  setSearch("")
                }}
              >
                <SelectTrigger id="catalogue-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogueKinds.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="catalogue-page-search">Search</FieldLabel>
              <div className="relative">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="catalogue-page-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name or catalogue ID"
                  className="pl-9"
                />
              </div>
            </Field>
          </FieldGroup>

          {catalogue.isError && !catalogue.data ? (
            <QueryError
              error={catalogue.error}
              title="Could not load catalogue rows"
              onRetry={() => catalogue.refetch()}
              isRetrying={catalogue.isFetching}
            />
          ) : catalogue.isLoading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ) : catalogue.data?.items.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {catalogue.data.items.map((item) => (
                <CatalogueRowCard
                  key={item.id}
                  item={item}
                  canWrite={canWrite}
                  onEdit={() => openEdit(item)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              No matching catalogue rows.
            </div>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      <CataloguePublicationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        draft={draft}
        onDraftChange={setDraft}
        onPublish={() => publish.mutate()}
        publishing={publish.isPending}
      />
    </section>
  )
}

function CatalogueRowCard({
  item,
  canWrite,
  onEdit,
}: {
  item: CatalogueItem
  canWrite: boolean
  onEdit: () => void
}) {
  return (
    <article className="flex min-w-0 flex-col justify-between gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words font-medium">{item.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {catalogueSourceDescription(item)}
            </p>
          </div>
          <CatalogueProvenanceBadge
            provenance={item.provenance}
            revision={item.revision}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{item.category ?? "Uncategorised"}</Badge>
          <Badge variant="outline">Unit {item.unit ?? "not recorded"}</Badge>
          {item.fixedCost ? (
            <Badge variant="outline">U$ {universal(item.fixedCost)}</Badge>
          ) : (
            <Badge variant="outline">{item.kind === "stock-size" ? "Stock dimensions" : "Formula"}</Badge>
          )}
        </div>
        {item.kind === "stock-size" && <p className="mt-3 text-sm">{stockSizeDimensions(item)}</p>}
        {item.effectiveFormula && (
          <code className="mt-3 block overflow-x-auto rounded bg-muted px-2.5 py-2 text-xs">
            {item.effectiveFormula}
          </code>
        )}
        {item.latestChange && (
          <div className="mt-3 rounded border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {item.latestChange.createdBy.displayName}:
            </span>{" "}
            {item.latestChange.reason}
            {item.latestChange.evidence
              ? ` · Evidence: ${item.latestChange.evidence}`
              : ""}
          </div>
        )}
      </div>
      {canWrite && (
        <Button variant="outline" size="sm" className="self-start" onClick={onEdit}>
          <PencilLine data-icon="inline-start" />
          Edit effective row
        </Button>
      )}
    </article>
  )
}

function CataloguePublicationDialog({
  open,
  onOpenChange,
  editing,
  draft,
  onDraftChange,
  onPublish,
  publishing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: CatalogueItem | null
  draft: CatalogueDraft
  onDraftChange: (draft: CatalogueDraft) => void
  onPublish: () => void
  publishing: boolean
}) {
  const fieldId = useId()
  const validFixedCost =
    draft.costMode !== "fixed" ||
    (draft.fixedCost.trim() !== "" &&
      Number.isFinite(Number(draft.fixedCost)) &&
      Number(draft.fixedCost) >= 0)
  const validFormula =
    draft.costMode !== "formula" || draft.formula.trim().length > 0
  const valid =
    draft.name.trim().length > 0 &&
    draft.reason.trim().length >= 3 &&
    validFixedCost &&
    validFormula

  useEffect(() => {
    if (!open) return
    const firstInput = document.getElementById(`${fieldId}-catalogue-name`)
    firstInput?.focus()
  }, [fieldId, open])

  const change = <Key extends keyof CatalogueDraft>(
    key: Key,
    value: CatalogueDraft[Key],
  ) => onDraftChange({ ...draft, [key]: value })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Publish catalogue edit" : "Add team catalogue row"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `The ${editing.provenance === "team" ? "team baseline" : "official workbook row"} remains unchanged. This publishes effective revision ${editing.revision + 1}.`
              : "This row will be shared with everyone using this catalogue release and labelled Team row."}
          </DialogDescription>
        </DialogHeader>

        {editing && (
          <div className="rounded-lg border bg-muted/25 p-3 text-sm">
            <CatalogueProvenanceBadge
              provenance={editing.provenance}
              revision={editing.revision}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Baseline source: {catalogueSourceDescription(editing)}
            </p>
          </div>
        )}

        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-kind`}>Section</FieldLabel>
            <Select
              value={draft.kind}
              disabled={Boolean(editing)}
              onValueChange={(value) => change("kind", value as CatalogueItemKind)}
            >
              <SelectTrigger id={`${fieldId}-catalogue-kind`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalogueKinds.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-name`}>Name</FieldLabel>
            <Input
              id={`${fieldId}-catalogue-name`}
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-category`}>Category</FieldLabel>
            <Input
              id={`${fieldId}-catalogue-category`}
              value={draft.category}
              onChange={(event) => change("category", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-supplier`}>Supplier</FieldLabel>
            <Input
              id={`${fieldId}-catalogue-supplier`}
              value={draft.supplier}
              onChange={(event) => change("supplier", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-unit`}>Primary unit</FieldLabel>
            <Input
              id={`${fieldId}-catalogue-unit`}
              value={draft.unit}
              onChange={(event) => change("unit", event.target.value)}
              placeholder="kg, each, cm³…"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-unit-2`}>Secondary unit</FieldLabel>
            <Input
              id={`${fieldId}-catalogue-unit-2`}
              value={draft.unit2}
              onChange={(event) => change("unit2", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-cost-mode`}>Cost method</FieldLabel>
            <Select
              value={draft.costMode}
              onValueChange={(value) =>
                change("costMode", value as "fixed" | "formula")
              }
            >
              <SelectTrigger id={`${fieldId}-catalogue-cost-mode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed unit cost</SelectItem>
                <SelectItem value="formula">Formula</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.costMode === "fixed" ? (
            <Field data-invalid={!validFixedCost}>
              <FieldLabel htmlFor={`${fieldId}-catalogue-fixed-cost`}>
                Fixed unit cost (U$)
              </FieldLabel>
              <Input
                id={`${fieldId}-catalogue-fixed-cost`}
                inputMode="decimal"
                value={draft.fixedCost}
                onChange={(event) => change("fixedCost", event.target.value)}
                aria-invalid={!validFixedCost}
              />
              {!validFixedCost && <FieldError>Enter zero or a positive decimal.</FieldError>}
            </Field>
          ) : (
            <Field className="sm:col-span-2" data-invalid={!validFormula}>
              <FieldLabel htmlFor={`${fieldId}-catalogue-formula`}>Formula</FieldLabel>
              <Input
                id={`${fieldId}-catalogue-formula`}
                value={draft.formula}
                onChange={(event) => change("formula", event.target.value)}
                placeholder="=[C1]*[Size1]"
                aria-invalid={!validFormula}
              />
              <FieldDescription>
                Supports Size1-Size4, C1-C4, Area, Length, Density, arithmetic,
                exp, and sqrt. The server validates before publishing.
              </FieldDescription>
              {!validFormula && <FieldError>Enter a formula.</FieldError>}
            </Field>
          )}
        </FieldGroup>

        {draft.costMode === "formula" && (
          <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(["1", "2", "3", "4"] as const).map((index) => (
              <Field key={index}>
                <FieldLabel htmlFor={`${fieldId}-catalogue-c${index}`}>
                  C{index}
                </FieldLabel>
                <Input
                  id={`${fieldId}-catalogue-c${index}`}
                  inputMode="decimal"
                  value={draft[`c${index}`]}
                  onChange={(event) => change(`c${index}`, event.target.value)}
                />
              </Field>
            ))}
            {(["1", "2", "3", "4"] as const).map((index) => (
              <Field key={`size-${index}`}>
                <FieldLabel htmlFor={`${fieldId}-catalogue-size-${index}`}>
                  Size{index} label
                </FieldLabel>
                <Input
                  id={`${fieldId}-catalogue-size-${index}`}
                  value={draft[`size${index}Label`]}
                  onChange={(event) =>
                    change(`size${index}Label`, event.target.value)
                  }
                />
              </Field>
            ))}
          </FieldGroup>
        )}

        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-reason`}>
              Reason for this row
            </FieldLabel>
            <Textarea
              id={`${fieldId}-catalogue-reason`}
              value={draft.reason}
              onChange={(event) => change("reason", event.target.value)}
              placeholder="Why this team row or edit is appropriate"
            />
            {draft.reason.trim().length > 0 && draft.reason.trim().length < 3 && (
              <FieldError>Enter at least three characters.</FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-catalogue-evidence`}>
              Evidence or reference
            </FieldLabel>
            <Textarea
              id={`${fieldId}-catalogue-evidence`}
              value={draft.evidence}
              onChange={(event) => change("evidence", event.target.value)}
              placeholder="Quote, workbook note, review date…"
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onPublish} disabled={!valid || publishing}>
            {publishing ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Calculator data-icon="inline-start" />
            )}
            Publish {editing ? "revision" : "team row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function draftFromItem(item: CatalogueItem): CatalogueDraft {
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : ""
  return {
    kind: item.kind,
    name: item.name,
    category: item.category ?? "",
    supplier: item.supplier ?? "",
    unit: item.unit ?? "",
    unit2: item.unit2 ?? "",
    costMode: item.fixedCost !== null ? "fixed" : "formula",
    fixedCost: item.fixedCost ?? "",
    formula: item.effectiveFormula ?? "",
    c1: text(item.coefficients.c1),
    c2: text(item.coefficients.c2),
    c3: text(item.coefficients.c3),
    c4: text(item.coefficients.c4),
    size1Label: text(item.metadata.size1),
    size2Label: text(item.metadata.size2),
    size3Label: text(item.metadata.size3),
    size4Label: text(item.metadata.size4),
    reason: "",
    evidence: "",
  }
}

function publicationInput(
  releaseId: string,
  draft: CatalogueDraft,
): CataloguePublicationInput {
  const nullable = (value: string) => value.trim() || null
  return {
    releaseId,
    kind: draft.kind,
    name: draft.name.trim(),
    category: nullable(draft.category),
    supplier: nullable(draft.supplier),
    unit: nullable(draft.unit),
    unit2: nullable(draft.unit2),
    costMode: draft.costMode,
    fixedCost: draft.costMode === "fixed" ? draft.fixedCost.trim() : null,
    formula: draft.costMode === "formula" ? draft.formula.trim() : null,
    coefficients: {
      c1: nullable(draft.c1),
      c2: nullable(draft.c2),
      c3: nullable(draft.c3),
      c4: nullable(draft.c4),
    },
    size1Label: nullable(draft.size1Label),
    size2Label: nullable(draft.size2Label),
    size3Label: nullable(draft.size3Label),
    size4Label: nullable(draft.size4Label),
    reason: draft.reason.trim(),
    evidence: nullable(draft.evidence),
  }
}
