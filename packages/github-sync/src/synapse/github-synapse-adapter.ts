import type { SynapseClient, SynapseEventType, SynapseScopeType } from '@gitorch/synapse'

import type { GitHubSyncEvent } from '../types'

export class GitHubSynapseAdapter {
  constructor(private readonly synapse: SynapseClient) {}

  publish(event: GitHubSyncEvent): void {
    this.synapse.recordExternalEvent({
      type: eventTypeFor(event),
      scope: {
        type: scopeTypeFor(event),
        wingId: event.repository ?? 'github',
        targetId: targetIdFor(event),
      },
      actor: { id: 'github-app', role: 'system' },
      payload: {
        deliveryId: event.deliveryId,
        eventName: event.eventName,
        action: event.action,
        workItem: event.workItem,
        dependency: event.dependency,
        hierarchy: event.hierarchy,
        projectItem: event.projectItem,
      },
      now: event.occurredAt,
      correlationId: event.deliveryId,
    })
  }
}

function eventTypeFor(event: GitHubSyncEvent): SynapseEventType {
  if (event.projectItem) return 'github.project_item.synced'
  if (event.dependency) return 'github.dependency.changed'
  if (event.hierarchy) return 'github.sub_issue.changed'
  if (event.eventName === 'pull_request') return 'github.pull_request.synced'
  if (event.eventName === 'issues') return 'github.issue.synced'
  return 'github.webhook.received'
}

function scopeTypeFor(event: GitHubSyncEvent): SynapseScopeType {
  if (event.projectItem) return 'github-project-item'
  if (event.eventName === 'pull_request') return 'pull-request'
  if (event.eventName === 'issues' || event.dependency || event.hierarchy) return 'issue'
  return 'github-delivery'
}

function targetIdFor(event: GitHubSyncEvent): string {
  return (
    event.projectItem?.itemId ??
    event.workItem?.nodeId ??
    event.dependency?.blockedNodeId ??
    event.hierarchy?.childNodeId ??
    event.deliveryId
  )
}
