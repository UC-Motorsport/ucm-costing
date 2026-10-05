import type { CostNode } from "@/lib/api"

const controlledNumberPattern =
  /^([A-Z]\d{2})[-\u2013\u2014](\d{2})[-\u2013\u2014]([A-Z]{2,3})[-\u2013\u2014](\d{5,6})(?:[-\u2013\u2014](L|R)(?=[-\u2013\u2014]))?(?:[-\u2013\u2014]([A-Z0-9]*))?$/i

export type PartSide = "" | "L" | "R"

export function referenceSide(value: string): PartSide {
  return (value
    .trim()
    .match(/-(L|R)$/i)?.[1]
    ?.toUpperCase() ?? "") as PartSide
}

export function referenceWithSide(reference: string, side: PartSide): string {
  return [reference.replace(/-(L|R)$/i, ""), side].filter(Boolean).join("-")
}

export function nodeSide(
  node: Pick<CostNode, "full_number" | "reference_id">,
): PartSide {
  return (
    parseControlledNumber(node.full_number ?? "")?.side ??
    parseControlledNumber(node.reference_id ?? "")?.side ??
    referenceSide(node.reference_id ?? "")
  )
}

export function findNumberConflict(
  fullNumber: string,
  nodes: readonly CostNode[],
  excludeId?: string,
) {
  const key = fullNumber.trim().toUpperCase()
  return key
    ? nodes.find(
        (node) =>
          node.id !== excludeId &&
          node.full_number?.trim().toUpperCase() === key,
      )
    : undefined
}

export interface ControlledNumber {
  entryNumber: string
  year: string
  systemCode: string
  reference: string
  revision: string
  side: PartSide
}

/**
 * Break the team reference into the two-character fields used by the
 * controlled-number display. Five-digit legacy references used a one-digit
 * level, so that middle value is padded for the current 2026 convention.
 */
export function splitControlledReference(value: string) {
  const digits = value.trim().replace(/-(L|R)$/i, "")

  if (/^\d{6}$/.test(digits)) {
    return {
      assembly: digits.slice(0, 2),
      level: digits.slice(2, 4),
      part: digits.slice(4, 6),
    }
  }

  if (/^\d{5}$/.test(digits)) {
    return {
      assembly: digits.slice(0, 2),
      level: digits.slice(2, 3).padStart(2, "0"),
      part: digits.slice(3, 5),
    }
  }

  return null
}

export function parseControlledNumber(value: string): ControlledNumber | null {
  const match = value.trim().match(controlledNumberPattern)
  if (!match) return null

  const reference = splitControlledReference(match[4] ?? "")
  if (!reference) return null

  return {
    entryNumber: (match[1] ?? "").toUpperCase(),
    year: match[2] ?? "",
    systemCode: (match[3] ?? "").toUpperCase(),
    reference: joinControlledReference(reference),
    side: (match[5]?.toUpperCase() ?? "") as PartSide,
    revision: (match[6] ?? "").toUpperCase(),
  }
}

export function composeControlledNumber({
  entryNumber,
  season,
  systemCode,
  reference,
  revision,
  side = referenceSide(reference),
}: {
  entryNumber: string
  season: number
  systemCode: string | null
  reference: string
  revision: string
  side?: PartSide
}): string {
  const normalizedReference = splitControlledReference(reference)
  const normalizedEntry = entryNumber.trim().toUpperCase()
  const normalizedSystem = systemCode?.trim().toUpperCase() ?? ""
  if (!normalizedEntry || !normalizedSystem || !normalizedReference) return ""

  const prefix = [
    normalizedEntry,
    String(season % 100).padStart(2, "0"),
    normalizedSystem,
    joinControlledReference(normalizedReference),
  ].join("-")
  const normalizedRevision = revision.trim().toUpperCase()
  return side
    ? `${prefix}-${side}-${normalizedRevision}`
    : [prefix, normalizedRevision].filter(Boolean).join("-")
}

export function isControlledNumberForContext(
  value: string,
  context: {
    entryNumber: string
    season: number
    systemCode: string | null
  },
): boolean {
  const parsed = parseControlledNumber(value)
  if (!parsed) return false

  return (
    parsed.entryNumber === context.entryNumber.trim().toUpperCase() &&
    parsed.year === String(context.season % 100).padStart(2, "0") &&
    parsed.systemCode === context.systemCode?.trim().toUpperCase()
  )
}

/**
 * Suggest the next controlled six-digit reference for an unnumbered assembly,
 * subassembly, or part. Existing import references are preserved when they are
 * available. Otherwise sibling numbering and hierarchy position establish the
 * next reference appropriate to the record kind.
 */
export function suggestControlledReference(
  node: CostNode,
  nodes: readonly CostNode[],
): string | null {
  if (
    (node.kind !== "assembly" &&
      node.kind !== "subassembly" &&
      node.kind !== "part") ||
    !node.system_code
  ) {
    return null
  }

  const peers = nodes.filter(
    (candidate) =>
      candidate.id !== node.id &&
      candidate.project_id === node.project_id &&
      candidate.system_code === node.system_code,
  )
  const usedReferences = new Set(
    peers
      .filter((peer) => nodeSide(peer) === nodeSide(node))
      .flatMap((node) => {
        const reference = controlledReferenceForNode(node)
        return reference ? [reference] : []
      }),
  )

  const retainedReference = firstAvailableReference(
    [
      normalizeReference(node.reference_id),
      normalizeRawReferenceForKind(node),
      parseControlledNumber(node.full_number ?? "")?.reference ?? null,
    ],
    usedReferences,
  )
  if (retainedReference) return retainedReference

  if (node.kind === "assembly") {
    return nextAssemblyReference(node, peers, usedReferences)
  }
  if (node.kind === "subassembly") {
    return nextSubassemblyReference(node, nodes, peers, usedReferences)
  }

  const siblings = peers.filter(
    (candidate) =>
      candidate.kind === "part" && candidate.parent_id === node.parent_id,
  )
  const siblingPrefix = mostCommonPrefix(
    siblings.flatMap((node) => {
      const reference = controlledReferenceForNode(node)
      return reference ? [reference.slice(0, 4)] : []
    }),
  )
  const rawPrefix = normalizeRawPrefix(node)
  const hierarchyPrefix = hierarchyReferencePrefix(node, nodes)
  const prefix = siblingPrefix ?? rawPrefix ?? hierarchyPrefix

  if (!prefix) return null

  const usedPartSegments = peers.flatMap((node) => {
    const reference = controlledReferenceForNode(node)
    return reference?.startsWith(prefix) ? [Number(reference.slice(4, 6))] : []
  })
  const nextPartSegment = Math.max(0, ...usedPartSegments) + 1
  if (nextPartSegment > 99) return null

  const suggestion = `${prefix}${String(nextPartSegment).padStart(2, "0")}`
  return usedReferences.has(suggestion) ? null : suggestion
}

function nextAssemblyReference(
  assembly: CostNode,
  peers: readonly CostNode[],
  usedReferences: ReadonlySet<string>,
): string | null {
  const siblingPrefixes = peers.flatMap((node) => {
    if (node.kind !== "assembly" || node.parent_id !== assembly.parent_id) {
      return []
    }
    const reference = controlledReferenceForNode(node)
    return reference?.endsWith("00") ? [Number(reference.slice(0, 4))] : []
  })
  const firstPrefix =
    siblingPrefixes.length > 0
      ? Math.max(...siblingPrefixes) + 1
      : Math.max(1, assembly.sort_order + 1) * 100

  return nextAvailablePrefixReference(firstPrefix, null, usedReferences)
}

function nextSubassemblyReference(
  subassembly: CostNode,
  nodes: readonly CostNode[],
  peers: readonly CostNode[],
  usedReferences: ReadonlySet<string>,
): string | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const parent = subassembly.parent_id
    ? nodesById.get(subassembly.parent_id)
    : null
  const parentReference = parent ? controlledReferenceForNode(parent) : null
  const assemblySegment =
    parentReference?.slice(0, 2) ??
    normalizeSegment(subassembly.raw_hla) ??
    null
  if (!assemblySegment) return null

  const siblingLevels = peers.flatMap((node) => {
    if (
      node.kind !== "subassembly" ||
      node.parent_id !== subassembly.parent_id
    ) {
      return []
    }
    const reference = controlledReferenceForNode(node)
    return reference?.startsWith(assemblySegment) && reference.endsWith("00")
      ? [Number(reference.slice(2, 4))]
      : []
  })
  const parentLevel =
    parent?.kind === "subassembly" && parentReference
      ? Number(parentReference.slice(2, 4))
      : 0
  const firstLevel = Math.max(parentLevel, 0, ...siblingLevels) + 1

  return nextAvailablePrefixReference(
    Number(`${assemblySegment}${String(firstLevel).padStart(2, "0")}`),
    assemblySegment,
    usedReferences,
  )
}

function nextAvailablePrefixReference(
  firstPrefix: number,
  requiredAssemblySegment: string | null,
  usedReferences: ReadonlySet<string>,
): string | null {
  for (let prefix = firstPrefix; prefix <= 9_999; prefix += 1) {
    const paddedPrefix = String(prefix).padStart(4, "0")
    if (
      requiredAssemblySegment &&
      !paddedPrefix.startsWith(requiredAssemblySegment)
    ) {
      return null
    }
    const candidate = `${paddedPrefix}00`
    if (!usedReferences.has(candidate)) return candidate
  }
  return null
}

function controlledReferenceForNode(node: CostNode): string | null {
  return (
    parseControlledNumber(node.full_number ?? "")?.reference ??
    normalizeReference(node.reference_id) ??
    normalizeRawReferenceForKind(node)
  )
}

function normalizeReference(value: string | null): string | null {
  if (!value) return null
  const segments = splitControlledReference(value)
  return segments
    ? joinControlledReference(segments)
    : (parseControlledNumber(value)?.reference ?? null)
}

function normalizeRawReference(
  node: Pick<CostNode, "raw_hla" | "raw_subassembly" | "raw_part_number">,
): string | null {
  const prefix = normalizeRawPrefix(node)
  const part = normalizeSegment(node.raw_part_number)
  return prefix && part ? `${prefix}${part}` : null
}

function normalizeRawReferenceForKind(node: CostNode): string | null {
  if (node.kind === "part") return normalizeRawReference(node)

  const prefix = normalizeRawPrefix(node)
  if (prefix) return `${prefix}00`

  const assembly = normalizeSegment(node.raw_hla)
  return node.kind === "assembly" && assembly ? `${assembly}0000` : null
}

function normalizeRawPrefix(
  node: Pick<CostNode, "raw_hla" | "raw_subassembly">,
): string | null {
  const assembly = normalizeSegment(node.raw_hla)
  const level = normalizeSegment(node.raw_subassembly)
  return assembly && level ? `${assembly}${level}` : null
}

function normalizeSegment(value: string | null): string | null {
  const digits = value?.trim() ?? ""
  return /^\d{1,2}$/.test(digits) ? digits.padStart(2, "0") : null
}

function firstAvailableReference(
  candidates: readonly (string | null)[],
  usedReferences: ReadonlySet<string>,
): string | null {
  return (
    candidates.find(
      (candidate): candidate is string =>
        candidate !== null && !usedReferences.has(candidate),
    ) ?? null
  )
}

function mostCommonPrefix(prefixes: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const prefix of prefixes) {
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }

  return (
    [...counts.entries()].sort(
      ([leftPrefix, leftCount], [rightPrefix, rightCount]) =>
        rightCount - leftCount || leftPrefix.localeCompare(rightPrefix),
    )[0]?.[0] ?? null
  )
}

function hierarchyReferencePrefix(
  part: CostNode,
  nodes: readonly CostNode[],
): string | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const parent = part.parent_id ? nodesById.get(part.parent_id) : null
  if (!parent) return null

  const parentReference = controlledReferenceForNode(parent)
  if (parentReference) {
    if (parent.kind === "assembly") {
      return `${parentReference.slice(0, 2)}01`
    }
    return parentReference.slice(0, 4)
  }

  let ancestor: CostNode | undefined = parent
  while (ancestor && ancestor.kind !== "assembly") {
    ancestor = ancestor.parent_id
      ? nodesById.get(ancestor.parent_id)
      : undefined
  }
  if (!ancestor) return null

  const assemblySegment = normalizeSegment(
    ancestor.raw_hla ?? String(ancestor.sort_order + 1),
  )
  const levelSegment =
    parent.kind === "subassembly"
      ? normalizeSegment(
          parent.raw_subassembly ?? String(parent.sort_order + 1),
        )
      : "01"

  return assemblySegment && levelSegment
    ? `${assemblySegment}${levelSegment}`
    : null
}

function joinControlledReference(segments: {
  assembly: string
  level: string
  part: string
}): string {
  return `${segments.assembly}${segments.level}${segments.part}`
}
