import type { CostNode, ValidationIssue } from "@/lib/api"

export function buildPropagatedIssueIndex(
  nodes: CostNode[],
  issues: ValidationIssue[],
  severity?: ValidationIssue["severity"],
): Map<string, ValidationIssue[]> {
  const issuesByNode = new Map<string, ValidationIssue[]>()
  const nodesById = new Map(nodes.map((node) => [node.id, node]))

  for (const issue of issues) {
    if (!issue.nodeId || (severity && issue.severity !== severity)) continue

    let currentId: string | null = issue.nodeId
    const visitedNodeIds = new Set<string>()

    while (currentId && !visitedNodeIds.has(currentId)) {
      visitedNodeIds.add(currentId)
      const node = nodesById.get(currentId)
      if (!node) break

      const existing = issuesByNode.get(currentId)
      if (existing) existing.push(issue)
      else issuesByNode.set(currentId, [issue])

      currentId = node.parent_id
    }
  }

  return issuesByNode
}
