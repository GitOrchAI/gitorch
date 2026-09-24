import type { GitHubSyncEvent, GitHubSyncOperation, GitHubWorkItem } from './types'
import { GitHubWorkModel } from './work-model'
import type { ProjectV2Client } from './project-v2-client'

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
  private readonly itemLocks = new Map<string, Promise<void>>()

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
    const weight = this.workModel.weightFor(event.workItem)
    const iteration = this.workModel.iterationFor(event.workItem)

    const operations: GitHubSyncOperation[] = []

    for (const projectItemId of event.workItem.projectItemIds) {
      operations.push({
        operationKey: `project-status:${event.workItem.nodeId}:${status}`,
        kind: 'update-project-field',
        nodeId: event.workItem.nodeId,
        projectItemId,
        fieldName: 'Status',
        value: status,
        wishCreatedAt: event.workItem.wishCreatedAt,
        mergedAt: event.workItem.mergedAt,
      })

      if (weight !== undefined) {
        operations.push({
          operationKey: `project-weight:${event.workItem.nodeId}:${weight}`,
          kind: 'update-project-field',
          nodeId: event.workItem.nodeId,
          projectItemId,
          fieldName: 'Weight',
          value: weight,
        })
      }

      if (iteration !== undefined) {
        operations.push({
          operationKey: `project-iteration:${event.workItem.nodeId}:${iteration}`,
          kind: 'update-project-field',
          nodeId: event.workItem.nodeId,
          projectItemId,
          fieldName: 'Iteration',
          value: iteration,
        })
      }
    }

    return { operations }
  }

  async executeOperations(plan: OperationPlan, client: ProjectV2Client): Promise<void> {
    for (const operation of plan.operations) {
      if (operation.nodeId) {
        await this.executeWithLock(operation.nodeId, async () => {
          if (
            operation.kind === 'update-project-field' &&
            operation.projectId &&
            operation.projectItemId &&
            operation.fieldName
          ) {
            const field = operation.fieldName
            const val = operation.value

            if (field === 'Status' && typeof val === 'string') {
              await client
                .updateSingleSelectField({
                  projectId: operation.projectId,
                  itemId: operation.projectItemId,
                  fieldId: 'Status',
                  optionId: val,
                })
                .catch(() => {})
            } else if (field === 'Weight' && typeof val === 'number') {
              await client
                .setNumberField({
                  projectId: operation.projectId,
                  itemId: operation.projectItemId,
                  fieldId: 'Weight',
                  number: val,
                })
                .catch(() => {})
            } else if (field === 'Iteration' && typeof val === 'string') {
              await client
                .setIterationField({
                  projectId: operation.projectId,
                  itemId: operation.projectItemId,
                  fieldId: 'Iteration',
                  iterationId: val,
                })
                .catch(() => {})
            }
          }
        })
      }
    }
  }

  async executeWithLock(nodeId: string, execute: () => Promise<void>): Promise<void> {
    const previousLock = this.itemLocks.get(nodeId) ?? Promise.resolve()
    const nextLock = previousLock.catch(() => {}).then(execute)

    this.itemLocks.set(nodeId, nextLock)

    // Clean up the lock when the operation is completely done
    nextLock.finally(() => {
      if (this.itemLocks.get(nodeId) === nextLock) {
        this.itemLocks.delete(nodeId)
      }
    })

    return nextLock
  }
}
