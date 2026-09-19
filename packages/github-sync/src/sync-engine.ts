import type { GitHubSyncEvent, GitHubSyncOperation, GitHubWorkItem } from './types'
import { GitHubWorkModel } from './work-model'

export interface IngestResult {
  accepted: boolean
  status: number
  reason: string
}

export interface OperationPlan {
  operations: GitHubSyncOperation[]
}

export class GitHubSyncEngine {
  private readonly processedDeliveryIds = new Set<string>()
  private readonly workModel = new GitHubWorkModel()

  ingest(event: GitHubSyncEvent): IngestResult {
    if (this.processedDeliveryIds.has(event.deliveryId)) {
      return {
        accepted: false,
        status: 200, // Returning 200 to acknowledge idempotency gracefully without error
        reason: `Delivery already processed: ${event.deliveryId}`,
      }
    }

    this.processedDeliveryIds.add(event.deliveryId)
    return {
      accepted: true,
      status: 200,
      reason: 'Delivery accepted.',
    }
  }

  planOperations(event: GitHubSyncEvent, dependencyItems: GitHubWorkItem[]): OperationPlan {
    if (!event.workItem || event.workItem.projectItemIds.length === 0) {
      return { operations: [] }
    }

    const availability = this.workModel.availabilityFor(event.workItem, dependencyItems)
    const status = availability.available ? 'Ready' : 'Blocked'

    return {
      operations: event.workItem.projectItemIds.map((projectItemId) => ({
        operationKey: `project-status:${event.workItem?.nodeId}:${status}`,
        kind: 'update-project-field',
        nodeId: event.workItem?.nodeId,
        projectItemId,
        fieldName: 'Status',
        value: status,
      })),
    }
  }
}
