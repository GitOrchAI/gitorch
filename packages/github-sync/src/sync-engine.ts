import type {
  CoordinatedPrMissionResult,
  CoordinatedPrRepo,
  GitHubSyncEvent,
  GitHubSyncOperation,
  GitHubWorkItem,
} from './types'
import { GitHubWorkModel } from './work-model'
import type { ProjectV2Client } from './project-v2-client'

export class PartialSyncError extends Error {
  constructor(
    message: string,
    public readonly openedPrUrls: string[]
  ) {
    super(message)
    this.name = 'PartialSyncError'
  }
}

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

    const missionPrefix = this.workModel.missionPrefixFor(event.workItem)
    const correlatedItems = missionPrefix
      ? dependencyItems.filter((item) => this.workModel.missionPrefixFor(item) === missionPrefix)
      : []

    const allGroupItems = [event.workItem, ...correlatedItems]

    const isAllClosedOrMerged = allGroupItems.every(
      (item) => item.state === 'closed' || item.state === 'merged'
    )
    const isAnyBlocked =
      !isAllClosedOrMerged &&
      allGroupItems.some((item) => !this.workModel.availabilityFor(item, dependencyItems).available)

    let status = 'Ready'
    if (isAllClosedOrMerged) {
      status = 'Done'
    } else if (isAnyBlocked) {
      status = 'Blocked'
    }

    const operations: GitHubSyncOperation[] = []

    for (const groupItem of allGroupItems) {
      const weight = this.workModel.weightFor(groupItem)
      const iteration = this.workModel.iterationFor(groupItem)
      const assigneesToUpdate =
        groupItem.assignees && groupItem.assignees.length > 0 ? groupItem.assignees : undefined

      for (const projectItemId of groupItem.projectItemIds) {
        operations.push({
          operationKey: `project-status:${groupItem.nodeId}:${status}`,
          kind: 'update-project-field',
          nodeId: groupItem.nodeId,
          projectItemId,
          fieldName: 'Status',
          value: status,
          wishCreatedAt: groupItem.wishCreatedAt,
          mergedAt: groupItem.mergedAt,
        })

        if (assigneesToUpdate) {
          operations.push({
            operationKey: `project-assignees:${groupItem.nodeId}:${assigneesToUpdate.join(',')}`,
            kind: 'update-assignees',
            nodeId: groupItem.nodeId,
            projectItemId,
            assignees: assigneesToUpdate,
          })
        }

        if (weight !== undefined) {
          operations.push({
            operationKey: `project-weight:${groupItem.nodeId}:${weight}`,
            kind: 'update-project-field',
            nodeId: groupItem.nodeId,
            projectItemId,
            fieldName: 'Weight',
            value: weight,
          })
        }

        if (iteration !== undefined) {
          operations.push({
            operationKey: `project-iteration:${groupItem.nodeId}:${iteration}`,
            kind: 'update-project-field',
            nodeId: groupItem.nodeId,
            projectItemId,
            fieldName: 'Iteration',
            value: iteration,
          })
        }
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
          } else if (
            operation.kind === 'update-assignees' &&
            operation.assignees &&
            operation.nodeId
          ) {
            await client
              .addAssigneesToAssignable({
                assignableId: operation.nodeId,
                assigneeIds: operation.assignees,
              })
              .catch(() => {})
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

  private buildCrossLinkMessage(
    currentRepo: CoordinatedPrRepo,
    siblings: { repoName: string; number: number }[]
  ): string {
    if (siblings.length === 0) return ''

    let base = `PR de ${currentRepo.repositoryName} associado ao`
    if (siblings.length === 1 && siblings[0]) {
      base += ` PR de ${siblings[0].repoName} #${siblings[0].number}`
    } else {
      const allButLast = siblings
        .slice(0, -1)
        .map((s) => `PR de ${s.repoName} #${s.number}`)
        .join(', ')
      const lastSibling = siblings[siblings.length - 1]
      if (lastSibling) {
        const last = `PR de ${lastSibling.repoName} #${lastSibling.number}`
        base += ` ${allButLast} e ${last}`
      }
    }
    return base
  }

  async abrirPrsCoordenados(
    missionResult: CoordinatedPrMissionResult,
    client: ProjectV2Client
  ): Promise<void> {
    if (missionResult.repos.length === 0) return

    const openedPrs: { repo: CoordinatedPrRepo; id: string; number: number; url: string }[] = []

    for (const repo of missionResult.repos) {
      try {
        const pr = await client.createPullRequest({
          repositoryId: repo.repositoryId,
          baseRefName: repo.baseBranch,
          headRefName: repo.headBranch,
          title: repo.title,
          body: repo.body,
        })
        openedPrs.push({ repo, ...pr })
      } catch (err) {
        const urls = openedPrs.map((p) => p.url)
        throw new PartialSyncError(
          `Falha ao abrir PR para o repositório ${repo.repositoryName}: ${err instanceof Error ? err.message : String(err)}`,
          urls
        )
      }
    }

    // Now update PR bodies with mutual cross-links
    if (openedPrs.length > 1) {
      for (const currentPr of openedPrs) {
        const siblings = openedPrs
          .filter((p) => p.id !== currentPr.id)
          .map((p) => ({ repoName: p.repo.repositoryName, number: p.number }))

        const crossLinkMessage = this.buildCrossLinkMessage(currentPr.repo, siblings)
        const updatedBody = currentPr.repo.body
          ? `${currentPr.repo.body}\n\n${crossLinkMessage}`
          : crossLinkMessage

        try {
          await client.updatePullRequest({
            pullRequestId: currentPr.id,
            body: updatedBody,
          })
        } catch (err) {
          const urls = openedPrs.map((p) => p.url)
          throw new PartialSyncError(
            `Falha ao atualizar corpo do PR com cross-links para ${currentPr.repo.repositoryName}: ${err instanceof Error ? err.message : String(err)}`,
            urls
          )
        }
      }
    }

    // Finally, update the Project V2 item if applicable
    if (missionResult.projectId && missionResult.projectItemId) {
      try {
        const textField = await client.getTextField({
          projectId: missionResult.projectId,
          fieldName: 'Linked pull requests',
        })

        const linksText = openedPrs.map((p) => p.url).join('\n')

        await client.setTextField({
          projectId: missionResult.projectId,
          itemId: missionResult.projectItemId,
          fieldId: textField.fieldId,
          text: linksText,
        })
      } catch (err) {
        // Se não encontrou o campo de texto ou falhou ao atualizar o card,
        // lançamos como PartialSyncError também para relatar sucesso nos PRs e falha no Project
        const urls = openedPrs.map((p) => p.url)
        throw new PartialSyncError(
          `Falha ao atualizar status unificado no GitHub Projects V2: ${err instanceof Error ? err.message : String(err)}`,
          urls
        )
      }
    }
  }
}
