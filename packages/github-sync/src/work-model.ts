import type { AvailabilityDecision, GitHubIssueType, GitHubWorkItem } from './types'

export class GitHubWorkModel {
  issueTypeFor(item: GitHubWorkItem): GitHubIssueType {
    return item.type
  }

  hierarchyFor(item: GitHubWorkItem): string[] {
    return [...item.subIssueNodeIds]
  }

  availabilityFor(item: GitHubWorkItem, dependencyItems: GitHubWorkItem[]): AvailabilityDecision {
    const dependencyById = new Map(
      dependencyItems.map((dependency) => [dependency.nodeId, dependency])
    )
    const openBlockers = item.blockedByNodeIds.filter((nodeId) => {
      const dependency = dependencyById.get(nodeId)
      return dependency?.state !== 'closed' && dependency?.state !== 'merged'
    })

    if (openBlockers.length > 0) {
      return {
        nodeId: item.nodeId,
        available: false,
        reason: `Blocked by ${openBlockers.length} open dependency.`,
        blockedByNodeIds: openBlockers,
      }
    }

    return {
      nodeId: item.nodeId,
      available: true,
      reason: 'No open blocking dependencies.',
      blockedByNodeIds: [],
    }
  }
}
