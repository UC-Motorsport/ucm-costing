import { useId, useMemo } from "react"

import { type CostNode } from "@/lib/api"

interface SystemAssemblyTreeProps {
  system: CostNode
}

interface PlacedNode {
  node: CostNode
  depth: number
  x: number
  y: number
}

interface TreeEdge {
  parentId: string
  childId: string
}

interface TreeLayout {
  edges: TreeEdge[]
  height: number
  nodes: PlacedNode[]
  width: number
}

const boxWidth = 196
const boxHeight = 58
const horizontalGap = 72
const verticalGap = 14
const padding = 24

export function SystemAssemblyTree({ system }: SystemAssemblyTreeProps) {
  const markerId = useId().replaceAll(":", "")
  const layout = useMemo(() => layoutTree(system), [system])
  const descendantCount = layout.nodes.length - 1

  if (system.children.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-4 py-10 text-center">
        <p className="text-sm font-medium">No assembly tree yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add an assembly to this system and its hierarchy will appear here
          automatically.
        </p>
      </div>
    )
  }

  return (
    <div
      className="max-h-[520px] overflow-auto rounded-lg border bg-muted/15"
      role="region"
      aria-label={`${system.name} assembly tree diagram`}
      tabIndex={0}
    >
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`${system.name} assembly tree with ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`}
        className="block max-w-none"
      >
        <defs>
          <marker
            id={markerId}
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L7,3.5 L0,7 Z" className="fill-muted-foreground" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const parent = layout.nodes.find(
            ({ node }) => node.id === edge.parentId,
          )
          const child = layout.nodes.find(
            ({ node }) => node.id === edge.childId,
          )
          if (!parent || !child) return null

          const startX = parent.x + boxWidth
          const startY = parent.y + boxHeight / 2
          const endX = child.x
          const endY = child.y + boxHeight / 2
          const middleX = startX + horizontalGap / 2

          return (
            <path
              key={`${edge.parentId}-${edge.childId}`}
              d={`M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`}
              fill="none"
              className="stroke-muted-foreground"
              strokeWidth="1.25"
              markerEnd={`url(#${markerId})`}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}

        {layout.nodes.map(({ node, x, y }) => {
          const labelLines = splitLabel(node.name)
          const identifier =
            node.kind === "system"
              ? node.system_code
              : node.full_number ?? node.reference_id
          const labelStartY = identifier
            ? y + 20
            : y + boxHeight / 2 - (labelLines.length - 1) * 7 + 4

          return (
            <g key={node.id}>
              <rect
                x={x}
                y={y}
                width={boxWidth}
                height={boxHeight}
                rx="5"
                className={
                  node.kind === "system"
                    ? "fill-red-50 stroke-primary"
                    : node.kind === "part"
                      ? "fill-background stroke-border"
                      : "fill-muted stroke-muted-foreground/60"
                }
                strokeWidth={node.kind === "system" ? "1.75" : "1.1"}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={x + boxWidth / 2}
                y={labelStartY}
                textAnchor="middle"
                className="fill-foreground text-[12px]"
                fontWeight={node.kind === "part" ? 450 : 600}
              >
                {labelLines.map((line, index) => (
                  <tspan
                    key={`${node.id}-${line}`}
                    x={x + boxWidth / 2}
                    dy={index === 0 ? 0 : 14}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
              {identifier ? (
                <text
                  x={x + boxWidth / 2}
                  y={y + boxHeight - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono text-[10px]"
                >
                  {identifier}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function layoutTree(system: CostNode): TreeLayout {
  const nodes: PlacedNode[] = []
  const edges: TreeEdge[] = []
  let nextLeafY = padding

  const place = (node: CostNode, depth: number): number => {
    const childYs = node.children.map((child) => {
      edges.push({ parentId: node.id, childId: child.id })
      return place(child, depth + 1)
    })
    const y =
      childYs.length === 0
        ? nextLeafY
        : (childYs[0]! + childYs[childYs.length - 1]!) / 2

    if (childYs.length === 0) nextLeafY += boxHeight + verticalGap

    nodes.push({
      node,
      depth,
      x: padding + depth * (boxWidth + horizontalGap),
      y,
    })
    return y
  }

  place(system, 0)

  const maxDepth = nodes.reduce(
    (maximum, node) => Math.max(maximum, node.depth),
    0,
  )

  return {
    edges,
    nodes,
    width:
      padding * 2 +
      (maxDepth + 1) * boxWidth +
      maxDepth * horizontalGap,
    height: Math.max(
      nextLeafY - verticalGap + padding,
      boxHeight + padding * 2,
    ),
  }
}

function splitLabel(value: string, maxCharacters = 25): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""

  for (const word of words) {
    if (!current) current = word
    else if (`${current} ${word}`.length <= maxCharacters) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }

  if (current) lines.push(current)
  if (lines.length <= 2) return lines.length > 0 ? lines : ["Unnamed item"]

  const secondLine = lines.slice(1).join(" ")
  return [
    lines[0]!,
    secondLine.length > maxCharacters + 4
      ? `${secondLine.slice(0, maxCharacters + 1)}…`
      : secondLine,
  ]
}
