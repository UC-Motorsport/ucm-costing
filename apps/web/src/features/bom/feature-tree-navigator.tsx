import { useEffect, useId, useMemo, useState } from "react"
import {
  Box,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Search,
} from "lucide-react"

import { Input } from "@/components/ui/input"
import { type CostNode } from "@/lib/api"
import { cn } from "@/lib/utils"

interface FeatureTreeNavigatorProps {
  tree: CostNode
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  className?: string
}

export function FeatureTreeNavigator({
  tree,
  selectedNodeId,
  onSelectNode,
  className,
}: FeatureTreeNavigatorProps) {
  const headingId = useId()
  const defaultExpansionKey = tree.children.map((node) => node.id).join(",")
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.children.map((node) => node.id)),
  )

  useEffect(() => {
    setExpanded(new Set(defaultExpansionKey.split(",").filter(Boolean)))
  }, [defaultExpansionKey, tree.id])

  useEffect(() => {
    if (!selectedNodeId) return
    const path = findNodePath(tree, selectedNodeId)
    if (!path) return

    setExpanded((current) => {
      const next = new Set(current)
      for (const node of path) next.add(node.id)
      return next
    })
  }, [selectedNodeId, tree])

  const query = search.trim().toLocaleLowerCase()
  const visibleNodes = useMemo(
    () =>
      query
        ? tree.children
            .map((node) => filterTreeByName(node, query))
            .filter((node): node is CostNode => node !== null)
        : tree.children,
    [query, tree.children],
  )

  const toggleExpanded = (nodeId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  return (
    <section
      className={cn("flex min-h-0 flex-col", className)}
      aria-labelledby={headingId}
    >
      <div className="px-3 pb-2">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <h2
            id={headingId}
            className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
          >
            Car structure
          </h2>
          {selectedNodeId ? (
            <span className="text-[10px] font-medium text-primary">
              Current item
            </span>
          ) : null}
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find by name"
            aria-label="Search car structure by name"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {visibleNodes.length > 0 ? (
          <div
            role="tree"
            aria-label="Bill of materials feature tree"
            className="space-y-0.5"
          >
            {visibleNodes.map((node) => (
              <FeatureTreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedNodeId={selectedNodeId}
                expanded={expanded}
                searchActive={Boolean(query)}
                onToggleExpanded={toggleExpanded}
                onSelectNode={onSelectNode}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            No names match “{search.trim()}”.
          </div>
        )}
      </div>
    </section>
  )
}

function FeatureTreeNode({
  node,
  depth,
  selectedNodeId,
  expanded,
  searchActive,
  onToggleExpanded,
  onSelectNode,
}: {
  node: CostNode
  depth: number
  selectedNodeId: string | null
  expanded: Set<string>
  searchActive: boolean
  onToggleExpanded: (nodeId: string) => void
  onSelectNode: (nodeId: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = searchActive || expanded.has(node.id)
  const selected = node.id === selectedNodeId
  const Icon =
    node.kind === "system"
      ? Folder
      : node.kind === "part"
        ? FileText
        : Box

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isExpanded : undefined}
      className="min-w-0"
    >
      <div
        className="flex min-w-0 items-center"
        style={{ paddingLeft: `${depth * 11}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
            tabIndex={searchActive ? -1 : 0}
            onClick={() => onToggleExpanded(node.id)}
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-7 shrink-0" />
        )}
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          aria-label={`Open ${node.kind} ${node.name}`}
          title={node.name}
          className={cn(
            "relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            selected
              ? "bg-primary/8 font-semibold text-primary before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
              : "text-sidebar-foreground/85 hover:bg-muted hover:text-sidebar-foreground",
          )}
          onClick={() => onSelectNode(node.id)}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              node.kind === "part" && !selected && "text-muted-foreground",
            )}
          />
          <span className="truncate">{node.name}</span>
        </button>
      </div>

      {hasChildren && isExpanded ? (
        <div role="group">
          {node.children.map((child) => (
            <FeatureTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              expanded={expanded}
              searchActive={searchActive}
              onToggleExpanded={onToggleExpanded}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function findNodePath(
  node: CostNode,
  targetId: string,
): CostNode[] | null {
  if (node.id === targetId) return [node]

  for (const child of node.children) {
    const childPath = findNodePath(child, targetId)
    if (childPath) return [node, ...childPath]
  }

  return null
}

function filterTreeByName(node: CostNode, query: string): CostNode | null {
  const children = node.children
    .map((child) => filterTreeByName(child, query))
    .filter((child): child is CostNode => child !== null)

  if (!node.name.toLocaleLowerCase().includes(query) && children.length === 0) {
    return null
  }

  return { ...node, children }
}
