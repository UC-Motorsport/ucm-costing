import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  parseControlledNumber,
  composeControlledNumber,
  referenceSide,
  type PartSide,
  splitControlledReference,
} from "@/features/bom/controlled-identifier-utils"
import { cn } from "@/lib/utils"

interface ControlledIdentifierProps {
  entryNumber: string
  season: number
  systemCode: string | null
  fullNumber: string
  referenceId: string
  revision: string
  onFullNumberChange?: (value: string) => void
  onRevisionChange?: (value: string) => void
  fullNumberInvalid?: boolean
  fullNumberError?: {
    id: string
    title: string
    detail: string
  } | null
  revisionInvalid?: boolean
  revisionErrorId?: string
  suggestedReference?: string | null
  suggestionLabel?: string
  showSide?: boolean
  className?: string
}

type ReferenceSegment = "assembly" | "level" | "part"

interface IdentifierSegment {
  label: "ENTRY" | "YEAR" | "SYSTEM" | "ASSY" | "LVL" | "PART" | "SIDE" | "REV"
  value: string
  accent?: boolean
  editableReference?: ReferenceSegment
  editableRevision?: boolean
}

const referenceSegmentLabels: Record<ReferenceSegment, string> = {
  assembly: "Assembly number segment",
  level: "Level number segment",
  part: "Part number segment",
}

function InlineReferenceInput({
  segment,
  value,
  invalid,
  describedBy,
  onCommit,
}: {
  segment: ReferenceSegment
  value: string
  invalid: boolean
  describedBy?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = (nextValue: string) => {
    onCommit(nextValue.padStart(2, "0"))
  }

  return (
    <input
      aria-label={referenceSegmentLabels[segment]}
      aria-invalid={invalid}
      aria-describedby={invalid ? describedBy : undefined}
      autoComplete="off"
      className="h-6 w-9 rounded border border-transparent bg-transparent px-1 text-center font-mono text-base leading-5 font-semibold tracking-[0.03em] tabular-nums text-foreground outline-none transition-colors hover:border-input hover:bg-background focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 sm:w-10"
      inputMode="numeric"
      maxLength={2}
      placeholder="00"
      value={draft}
      onBlur={() => commit(draft)}
      onChange={(event) => {
        const nextValue = event.target.value.replace(/\D/g, "").slice(0, 2)
        setDraft(nextValue)
        if (nextValue.length === 2) commit(nextValue)
      }}
      onFocus={(event) => event.currentTarget.select()}
    />
  )
}

export function ControlledIdentifier({
  entryNumber,
  season,
  systemCode,
  fullNumber,
  referenceId,
  revision,
  onFullNumberChange,
  onRevisionChange,
  fullNumberInvalid = false,
  fullNumberError = null,
  revisionInvalid = false,
  revisionErrorId,
  suggestedReference = null,
  suggestionLabel = "Suggested number",
  showSide = false,
  className,
}: ControlledIdentifierProps) {
  const parsedFullNumber =
    parseControlledNumber(fullNumber) ?? parseControlledNumber(referenceId)
  const reference = splitControlledReference(
    parsedFullNumber?.reference ?? referenceId,
  )
  const displayedRevision = (
    revision.trim() ||
    parsedFullNumber?.revision ||
    ""
  ).toUpperCase()
  const side = parsedFullNumber?.side ?? referenceSide(referenceId)
  const segments: IdentifierSegment[] = [
    {
      label: "ENTRY",
      value: entryNumber.trim().toUpperCase() || "—",
    },
    {
      label: "YEAR",
      value: String(season % 100).padStart(2, "0"),
    },
    {
      label: "SYSTEM",
      value: systemCode?.trim().toUpperCase() || "—",
      accent: true,
    },
    {
      label: "ASSY",
      value: reference?.assembly ?? "",
      editableReference: "assembly",
    },
    {
      label: "LVL",
      value: reference?.level ?? "",
      editableReference: "level",
    },
    {
      label: "PART",
      value: reference?.part ?? "",
      editableReference: "part",
    },
    ...(showSide ? [{ label: "SIDE" as const, value: side || "None" }] : []),
    {
      label: "REV",
      value: displayedRevision,
      editableRevision: true,
    },
  ]

  const composeFullNumber = (
    nextReference: Partial<Record<ReferenceSegment, string>> = {},
    nextRevision = displayedRevision,
    nextSide: PartSide = side,
  ) => {
    const controlledReference = [
      nextReference.assembly ?? reference?.assembly ?? "00",
      nextReference.level ?? reference?.level ?? "00",
      nextReference.part ?? reference?.part ?? "00",
    ].join("")
    return composeControlledNumber({
      entryNumber,
      season,
      systemCode,
      reference: controlledReference,
      revision: nextRevision,
      side: nextSide,
    })
  }
  const suggestion = suggestedReference
    ? splitControlledReference(suggestedReference)
    : null
  const suggestedFullNumber = suggestion ? composeFullNumber(suggestion) : null

  return (
    <section
      aria-label="Controlled identifier breakdown"
      aria-invalid={fullNumberInvalid || revisionInvalid}
      className={cn("min-w-0 border-y bg-muted/40", className)}
    >
      <div className="overflow-x-auto">
        <dl className="mx-auto grid max-w-3xl grid-cols-6 sm:flex sm:min-w-[24rem]">
          {segments.map((segment, index) => (
            <div
              key={segment.label}
              aria-label={`${segment.label}: ${segment.value || "not set"}`}
              className={cn(
                "min-w-0 flex-1 px-1.5 py-1.5 text-center sm:px-2",
                segment.label === "SIDE" &&
                  "col-span-4 border-t sm:min-w-[9rem] sm:flex-[2] sm:border-t-0",
                segment.label === "REV" &&
                  (showSide
                    ? "col-span-2 border-t sm:border-t-0"
                    : "col-span-6 border-t sm:border-t-0"),
                index > 0 && "border-l",
              )}
            >
              <dt className="mb-0.5 text-[9px] font-medium tracking-[0.14em] text-muted-foreground">
                {segment.label}
              </dt>
              <dd
                className={cn(
                  "flex min-h-6 items-center justify-center whitespace-nowrap font-mono text-base leading-5 font-semibold tracking-[0.03em] tabular-nums text-foreground",
                  segment.accent && "text-primary",
                )}
              >
                {segment.label === "SIDE" ? (
                  onFullNumberChange ? (
                    <div
                      role="group"
                      aria-label="Part side"
                      className="flex rounded-md border bg-background p-0.5 font-sans text-xs tracking-normal"
                    >
                      {(
                        [
                          ["", "None"],
                          ["L", "Left"],
                          ["R", "Right"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={side === value}
                          className={cn(
                            "rounded px-2 py-1 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            side === value
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                          onClick={() =>
                            onFullNumberChange(
                              composeFullNumber(
                                {},
                                displayedRevision || "A",
                                value,
                              ),
                            )
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : side === "L" ? (
                    "Left"
                  ) : side === "R" ? (
                    "Right"
                  ) : (
                    "None"
                  )
                ) : segment.editableReference && onFullNumberChange ? (
                  <InlineReferenceInput
                    segment={segment.editableReference}
                    value={segment.value}
                    invalid={fullNumberInvalid}
                    describedBy={fullNumberError?.id}
                    onCommit={(value) =>
                      onFullNumberChange(
                        composeFullNumber({
                          [segment.editableReference!]: value,
                        }),
                      )
                    }
                  />
                ) : segment.editableRevision && onRevisionChange ? (
                  <input
                    aria-label="Revision segment"
                    aria-invalid={revisionInvalid}
                    aria-describedby={
                      revisionInvalid ? revisionErrorId : undefined
                    }
                    autoComplete="off"
                    className="h-6 w-9 rounded border border-transparent bg-transparent px-1 text-center font-mono text-base leading-5 font-semibold uppercase tracking-[0.03em] text-foreground outline-none transition-colors hover:border-input hover:bg-background focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 sm:w-10"
                    maxLength={3}
                    placeholder="—"
                    value={segment.value}
                    onChange={(event) => {
                      const nextRevision = event.target.value
                        .replace(/[^a-z0-9]/gi, "")
                        .toUpperCase()
                      onRevisionChange(nextRevision)
                      onFullNumberChange?.(composeFullNumber({}, nextRevision))
                    }}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                ) : (
                  segment.value || "—"
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {fullNumberInvalid && fullNumberError ? (
        <div
          id={fullNumberError.id}
          role="alert"
          title={fullNumberError.detail}
          className="border-t border-destructive/20 px-3 py-1.5 text-xs text-destructive"
        >
          {fullNumberError.title}
        </div>
      ) : null}
      {suggestedFullNumber && onFullNumberChange ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
          <p className="min-w-0 text-xs text-muted-foreground">
            {suggestionLabel}{" "}
            <span className="font-mono font-semibold text-foreground">
              {suggestedFullNumber}
            </span>
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onFullNumberChange(suggestedFullNumber)}
          >
            Use suggested number
          </Button>
        </div>
      ) : null}
    </section>
  )
}
