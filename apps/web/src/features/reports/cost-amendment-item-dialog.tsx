import { useEffect, useId, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, LoaderCircle, Search } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  CatalogueProvenanceBadge,
} from "@/features/catalogue/catalogue-provenance"
import { catalogueSourceDescription } from "@/features/catalogue/catalogue-source"
import { fixedRateAmountLabel } from "@/features/catalogue/catalogue-measure"
import { MutationError } from "@/features/reports/workflow-ui"
import {
  api,
  universal,
  type CatalogueItem,
  type CostAmendmentDetail,
  type CostAmendmentItem,
  type CostAmendmentItemInput,
  type CostLine,
} from "@/lib/api"
import { cn } from "@/lib/utils"

type CostKind = CostLine["kind"]
type Classification = CostAmendmentItem["classification"]

const costKinds: CostKind[] = [
  "material",
  "process",
  "fastener",
  "tooling",
]
const classifications: Array<{
  value: Classification
  label: string
}> = [
  { value: "new", label: "New part or cost" },
  { value: "deleted", label: "Deleted part or cost" },
  { value: "modified", label: "Modified part" },
  { value: "quantity-change", label: "Quantity change" },
  { value: "unresolved", label: "Unresolved classification" },
]

export function CostAmendmentItemDialog({
  open,
  onOpenChange,
  detail,
  item,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: CostAmendmentDetail
  item?: CostAmendmentItem
  onSaved: (detail: CostAmendmentDetail) => Promise<void>
}) {
  const fieldId = useId()
  const [partIdentity, setPartIdentity] = useState("")
  const [kind, setKind] = useState<CostKind>("material")
  const [search, setSearch] = useState("")
  const [catalogueItemId, setCatalogueItemId] = useState("")
  const [description, setDescription] = useState("")
  const [classification, setClassification] =
    useState<Classification>("new")
  const [action, setAction] =
    useState<CostAmendmentItem["action"]>("add")
  const [changeGroupId, setChangeGroupId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [originalQuantity, setOriginalQuantity] = useState("0")
  const [revisedQuantity, setRevisedQuantity] = useState("1")
  const [sizeInputs, setSizeInputs] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const initialPart = item?.source_json.partIdentity ?? ""
    const basePart = detail.baseReport.parts.find(
      ({ id }) => id === initialPart,
    )
    setPartIdentity(initialPart || detail.baseReport.parts[0]?.id || "")
    setKind(item?.cost_box ?? "material")
    setSearch(item?.source_json.catalogueItemName ?? "")
    setCatalogueItemId(item?.source_json.catalogueItemId ?? "")
    setDescription(item?.description ?? "")
    setClassification(item?.classification ?? "new")
    setAction(item?.action ?? "add")
    setChangeGroupId(item?.change_group_id ?? "")
    setQuantity(item?.quantity ?? "1")
    setOriginalQuantity(
      item?.original_quantity ?? (basePart?.quantity || "0"),
    )
    setRevisedQuantity(item?.revised_quantity ?? "1")
    setSizeInputs(item?.source_json.sizeInputs ?? {})
  }, [detail.baseReport.parts, item, open])

  const catalogue = useQuery({
    queryKey: [
      "catalogue",
      detail.baseReport.catalogueReleaseId,
      kind,
      search,
    ],
    queryFn: () =>
      api.catalogue(
        detail.baseReport.catalogueReleaseId,
        kind,
        search.trim(),
      ),
    enabled: open,
  })
  const exactItem = useQuery({
    queryKey: [
      "catalogue-item",
      detail.baseReport.catalogueReleaseId,
      catalogueItemId,
    ],
    queryFn: () =>
      api.catalogueItem(
        detail.baseReport.catalogueReleaseId,
        catalogueItemId,
      ),
    enabled: open && Boolean(catalogueItemId),
  })
  const selectedCatalogueItem =
    exactItem.data?.item ??
    catalogue.data?.items.find(({ id }) => id === catalogueItemId) ??
    null
  const selectedPart =
    detail.baseReport.parts.find(({ id }) => id === partIdentity) ?? null
  const formulaVariables = selectedCatalogueItem
    ? requiredFormulaVariables(selectedCatalogueItem.effectiveFormula)
    : []
  const missingFormulaInputs = formulaVariables.some(
    (variable) => !sizeInputs[variable]?.trim(),
  )
  const formulaInvalid =
    !selectedCatalogueItem?.fixedCost &&
    (selectedCatalogueItem?.effectiveFormulaValidation?.ok === false ||
      !selectedCatalogueItem?.effectiveFormula)
  const amountLabel = fixedRateAmountLabel(selectedCatalogueItem)
  const costedAmountLabel =
    amountLabel === "Quantity"
      ? "Quantity costed on this row"
      : `Costed ${amountLabel.charAt(0).toLowerCase()}${amountLabel.slice(1)}`
  const quantitiesValid =
    isPositiveDecimal(quantity) &&
    isNonNegativeDecimal(originalQuantity) &&
    isNonNegativeDecimal(revisedQuantity)
  const classificationValid =
    (classification !== "new" ||
      (action === "add" && Number(originalQuantity) === 0)) &&
    (classification !== "deleted" ||
      (action === "remove" && Number(revisedQuantity) === 0)) &&
    (!["modified", "quantity-change"].includes(classification) ||
      Boolean(changeGroupId.trim()))
  const canSave =
    Boolean(partIdentity) &&
    Boolean(catalogueItemId) &&
    Boolean(description.trim()) &&
    Boolean(selectedCatalogueItem) &&
    !formulaInvalid &&
    !missingFormulaInputs &&
    quantitiesValid &&
    classificationValid

  const save = useMutation({
    mutationFn: () => {
      const body: CostAmendmentItemInput = {
        expectedAmendmentVersion: detail.amendment.version,
        action,
        partIdentity,
        catalogueItemId,
        sizeInputs,
        description: description.trim(),
        classification,
        changeGroupId: changeGroupId.trim() || null,
        quantity,
        originalQuantity,
        revisedQuantity,
        sortOrder: item?.sort_order,
      }
      return item
        ? api.updateCostAmendmentItem(
            detail.amendment.id,
            item.id,
            body,
          )
        : api.addCostAmendmentItem(detail.amendment.id, body)
    },
    onSuccess: async (updated) => {
      await onSaved(updated)
      onOpenChange(false)
    },
  })

  const changeClassification = (next: Classification) => {
    setClassification(next)
    const partQuantity = selectedPart?.quantity ?? "1"
    if (next === "new") {
      setAction("add")
      setOriginalQuantity("0")
      setRevisedQuantity(quantity)
    } else if (next === "deleted") {
      setAction("remove")
      setQuantity(partQuantity)
      setOriginalQuantity(partQuantity)
      setRevisedQuantity("0")
    } else {
      setOriginalQuantity(partQuantity)
      setRevisedQuantity(partQuantity)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {item ? "Edit amendment item" : "Add amendment item"}
          </DialogTitle>
          <DialogDescription>
            Part identity comes from the immutable base report. The server
            derives the official catalogue source, cost box, formula result,
            unit cost, and subtotal.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm sm:col-span-2">
            <span className="font-medium">Base report part</span>
            <Select
              value={partIdentity}
              onValueChange={(value) => {
                setPartIdentity(value)
                const part = detail.baseReport.parts.find(
                  ({ id }) => id === value,
                )
                if (!item && part) {
                  if (classification === "deleted") {
                    setQuantity(part.quantity)
                    setOriginalQuantity(part.quantity)
                  } else if (
                    classification === "modified" ||
                    classification === "quantity-change"
                  ) {
                    setOriginalQuantity(part.quantity)
                    setRevisedQuantity(part.quantity)
                  }
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select immutable base-report part" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {detail.baseReport.parts.map((part) => (
                  <SelectItem key={part.id} value={part.id}>
                    {part.fullNumber ?? part.referenceId ?? "Unnumbered"} ·{" "}
                    {part.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {selectedPart && (
            <div className="rounded-md bg-muted px-3 py-2 text-xs sm:col-span-2">
              Base quantity {selectedPart.quantity} · material U${" "}
              {universal(selectedPart.breakdown.material)} · process U${" "}
              {universal(selectedPart.breakdown.process)} · fastener U${" "}
              {universal(selectedPart.breakdown.fastener)} · tooling U${" "}
              {universal(selectedPart.breakdown.tooling)}
            </div>
          )}

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Classification</span>
            <Select
              value={classification}
              onValueChange={(value) =>
                changeClassification(value as Classification)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {classifications.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Cost change direction</span>
            <Select
              value={action}
              onValueChange={(value) =>
                setAction(value as CostAmendmentItem["action"])
              }
              disabled={
                classification === "new" ||
                classification === "deleted"
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add">Addition</SelectItem>
                <SelectItem value="remove">Removal</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {(classification === "modified" ||
            classification === "quantity-change") && (
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Change group reference</span>
              <Input
                value={changeGroupId}
                onChange={(event) => setChangeGroupId(event.target.value)}
                maxLength={200}
                placeholder="Pairs related add/remove rows"
              />
            </label>
          )}
          <label className="grid gap-1.5 text-sm sm:col-span-2">
            <span className="font-medium">Description</span>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2_000}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{costedAmountLabel}</span>
            <Input
              inputMode="decimal"
              value={quantity}
              onChange={(event) => {
                const value = event.target.value
                setQuantity(value)
                if (classification === "new") setRevisedQuantity(value)
              }}
              aria-invalid={!isPositiveDecimal(quantity)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Original vehicle quantity</span>
            <Input
              inputMode="decimal"
              value={originalQuantity}
              onChange={(event) => setOriginalQuantity(event.target.value)}
              disabled={classification === "new"}
              aria-invalid={!isNonNegativeDecimal(originalQuantity)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Revised vehicle quantity</span>
            <Input
              inputMode="decimal"
              value={revisedQuantity}
              onChange={(event) => setRevisedQuantity(event.target.value)}
              disabled={classification === "deleted"}
              aria-invalid={!isNonNegativeDecimal(revisedQuantity)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Official cost box</span>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as CostKind)
                setCatalogueItemId("")
                setSizeInputs({})
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {costKinds.map((costKind) => (
                  <SelectItem key={costKind} value={costKind}>
                    {capitalize(costKind)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="grid gap-1.5 text-sm sm:col-span-2">
            <span className="font-medium">
              Search catalogue {detail.baseReport.catalogueRevision}
            </span>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or catalogue ID"
                className="pl-9"
              />
            </div>
          </label>
          <div
            className="max-h-48 overflow-y-auto rounded-lg border sm:col-span-2"
            aria-label={`${capitalize(kind)} catalogue results`}
          >
            {catalogue.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">
                Loading official catalogue…
              </div>
            ) : catalogue.isError && !catalogue.data ? (
              <QueryError
                error={catalogue.error}
                title="Could not search the official catalogue"
                onRetry={() => catalogue.refetch()}
                isRetrying={catalogue.isFetching}
                compact
                className="m-3"
              />
            ) : catalogue.data?.items.length ? (
              catalogue.data.items.map((candidate) => (
                <CatalogueResult
                  key={candidate.id}
                  item={candidate}
                  selected={candidate.id === catalogueItemId}
                  onSelect={() => {
                    setCatalogueItemId(candidate.id)
                    setSizeInputs({})
                  }}
                />
              ))
            ) : (
              <div className="p-5 text-center text-sm text-muted-foreground">
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
              className="sm:col-span-2"
            />
          )}
          {selectedCatalogueItem && (
            <div className="space-y-3 rounded-lg border p-3 sm:col-span-2">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{selectedCatalogueItem.name}</span>
                  <CatalogueProvenanceBadge
                    provenance={selectedCatalogueItem.provenance}
                    revision={selectedCatalogueItem.revision}
                  />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {catalogueSourceDescription(selectedCatalogueItem)} ·{" "}
                  {selectedCatalogueItem.fixedCost
                    ? `fixed U$ ${universal(selectedCatalogueItem.fixedCost)}`
                    : selectedCatalogueItem.effectiveFormula
                      ? "server-calculated formula"
                      : "no usable official cost"}
                </div>
              </div>
              {selectedCatalogueItem.formulaCorrection && (
                <Alert>
                  <AlertTitle>Catalogue correction applied</AlertTitle>
                  <AlertDescription>
                    Source formula {selectedCatalogueItem.sourceFormula}; the
                    server applies {selectedCatalogueItem.effectiveFormula}.{" "}
                    {selectedCatalogueItem.formulaCorrection.reason}
                  </AlertDescription>
                </Alert>
              )}
              {formulaInvalid && (
                <Alert variant="destructive">
                  <AlertTitle>Catalogue row cannot be calculated</AlertTitle>
                  <AlertDescription>
                    The official row has no verified fixed cost or valid
                    formula.
                  </AlertDescription>
                </Alert>
              )}
              {formulaVariables.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {formulaVariables.map((variable) => (
                    <label
                      key={variable}
                      className="grid gap-1.5 text-sm"
                    >
                      <span className="font-medium">
                        {formulaInputLabel(selectedCatalogueItem, variable)}
                      </span>
                      <Input
                        id={`${fieldId}-${variable}`}
                        inputMode="decimal"
                        value={sizeInputs[variable] ?? ""}
                        onChange={(event) =>
                          setSizeInputs((current) => ({
                            ...current,
                            [variable]: event.target.value,
                          }))
                        }
                        placeholder={formulaInputUnit(
                          selectedCatalogueItem,
                          variable,
                        )}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {!classificationValid && (
            <p className="text-sm text-destructive sm:col-span-2">
              New rows must be additions from zero, deleted rows must be
              removals to zero, and modified/quantity rows require a shared
              change-group reference.
            </p>
          )}
        </div>
        <MutationError error={save.error} />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
          >
            {save.isPending && <LoaderCircle className="animate-spin" />}
            {item ? "Recalculate and save" : "Calculate and add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CatalogueResult({
  item,
  selected,
  onSelect,
}: {
  item: CatalogueItem
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        selected && "bg-primary/5",
      )}
      onClick={onSelect}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {selected && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <CatalogueProvenanceBadge
            provenance={item.provenance}
            revision={item.revision}
          />
          <span>{catalogueSourceDescription(item)}</span>
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

function formulaInputUnit(item: CatalogueItem, variable: string): string {
  const correctedUnit = item.formulaCorrection?.inputs[variable]?.unit
  if (correctedUnit) return correctedUnit
  if (variable === "size1") return item.unit ?? "Value"
  if (variable === "size2") return item.unit2 ?? "Value"
  return "Value"
}

function isPositiveDecimal(value: string): boolean {
  const number = Number(value)
  return value.trim() !== "" && Number.isFinite(number) && number > 0
}

function isNonNegativeDecimal(value: string): boolean {
  const number = Number(value)
  return value.trim() !== "" && Number.isFinite(number) && number >= 0
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
