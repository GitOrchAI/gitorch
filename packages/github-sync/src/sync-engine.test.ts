import { expect, test } from 'vitest'

import { GitHubSyncEngine } from './sync-engine'
import type { GitHubSyncEvent, GitHubWorkItem } from './types'

const workItem: GitHubWorkItem = {
  nodeId: 'I_6',
  number: 6,
  repository: 'loureng/gitorch',
  title: 'Task 6',
  type: 'Task',
  state: 'open',
  labels: [],
  subIssueNodeIds: [],
  blockedByNodeIds: ['I_3'],
  blockingNodeIds: [],
  projectItemIds: ['PVTI_6'],
}

const event: GitHubSyncEvent = {
  id: 'delivery-1:issues:opened:I_6',
  deliveryId: 'delivery-1',
  eventName: 'issues',
  action: 'opened',
  repository: 'loureng/gitorch',
  occurredAt: '2026-06-23T12:00:00.000Z',
  workItem,
}

test('processes each GitHub delivery once', () => {
  const engine = new GitHubSyncEngine()

  expect(engine.ingest(event).accepted).toBe(true)
  expect(engine.ingest(event).accepted).toBe(false)
})

test('plans blocked project status when dependencies are open', () => {
  const engine = new GitHubSyncEngine()
  const result = engine.planOperations(event, [
    {
      ...workItem,
      nodeId: 'I_3',
      number: 3,
      title: 'Task 3',
      blockedByNodeIds: [],
      projectItemIds: ['PVTI_3'],
      state: 'open',
    },
  ])

  expect(result.operations).toEqual([
    {
      operationKey: 'project-status:I_6:Blocked',
      kind: 'update-project-field',
      nodeId: 'I_6',
      projectItemId: 'PVTI_6',
      fieldName: 'Status',
      value: 'Blocked',
    },
  ])
})

test('plans ready project status when dependencies are closed', () => {
  const engine = new GitHubSyncEngine()
  const result = engine.planOperations(event, [
    {
      ...workItem,
      nodeId: 'I_3',
      number: 3,
      title: 'Task 3',
      blockedByNodeIds: [],
      projectItemIds: ['PVTI_3'],
      state: 'closed',
    },
  ])

  expect(result.operations[0]).toMatchObject({
    operationKey: 'project-status:I_6:Ready',
    value: 'Ready',
  })
})
