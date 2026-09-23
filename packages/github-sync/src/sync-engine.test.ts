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

  expect(engine.ingest(event)).toEqual({
    accepted: true,
    status: 200,
    reason: 'Delivery accepted.',
  })
  expect(engine.ingest(event)).toEqual({
    accepted: false,
    status: 200,
    reason: 'Delivery already processed: delivery-1',
  })
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

test('plans weight and iteration fields when present', () => {
  const engine = new GitHubSyncEngine()
  const result = engine.planOperations(
    {
      ...event,
      workItem: {
        ...workItem,
        body: '## Peso\n**5**',
        milestone: 'Sprint 2',
      },
    },
    []
  )

  expect(result.operations).toEqual([
    {
      operationKey: 'project-status:I_6:Blocked',
      kind: 'update-project-field',
      nodeId: 'I_6',
      projectItemId: 'PVTI_6',
      fieldName: 'Status',
      value: 'Blocked',
    },
    {
      operationKey: 'project-weight:I_6:5',
      kind: 'update-project-field',
      nodeId: 'I_6',
      projectItemId: 'PVTI_6',
      fieldName: 'Weight',
      value: 5,
    },
    {
      operationKey: 'project-iteration:I_6:Sprint 2',
      kind: 'update-project-field',
      nodeId: 'I_6',
      projectItemId: 'PVTI_6',
      fieldName: 'Iteration',
      value: 'Sprint 2',
    },
  ])
})

test('executes operations sequentially with logical lock per item id', async () => {
  const engine = new GitHubSyncEngine()

  const executionOrder: number[] = []

  const p1 = engine.executeWithLock('I_6', async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    executionOrder.push(1)
  })

  const p2 = engine.executeWithLock('I_6', async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
    executionOrder.push(2)
  })

  const p3 = engine.executeWithLock('I_OTHER', async () => {
    executionOrder.push(3)
  })

  await Promise.all([p1, p2, p3])

  // I_OTHER finishes first because it has a different lock and no delay.
  // I_6 operations execute sequentially: 1 finishes after 50ms, then 2 executes
  expect(executionOrder).toEqual([3, 1, 2])
})
