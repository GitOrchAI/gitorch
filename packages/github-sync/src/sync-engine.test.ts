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
  wishCreatedAt: '2026-06-23T11:00:00.000Z',
  mergedAt: '2026-06-23T12:00:00.000Z',
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

test('aggregates PR events from 4 simultaneous repositories based on branch prefix', () => {
  const engine = new GitHubSyncEngine()
  const frontWorkItem: GitHubWorkItem = {
    ...workItem,
    nodeId: 'PR_FRONT',
    repository: 'loureng/gitorch-front',
    branchName: 'feat/mission-123-front',
    projectItemIds: ['PVTI_F'],
  }
  const backWorkItem: GitHubWorkItem = {
    ...workItem,
    nodeId: 'PR_BACK',
    repository: 'loureng/gitorch-back',
    branchName: 'feat/mission-123-back',
    projectItemIds: ['PVTI_B'],
  }
  const dbWorkItem: GitHubWorkItem = {
    ...workItem,
    nodeId: 'PR_DB',
    repository: 'loureng/gitorch-db',
    branchName: 'feat/mission-123-db',
    projectItemIds: ['PVTI_D'],
  }
  const infraWorkItem: GitHubWorkItem = {
    ...workItem,
    nodeId: 'PR_INFRA',
    repository: 'loureng/gitorch-infra',
    branchName: 'feat/mission-123-infra',
    projectItemIds: ['PVTI_I'],
  }

  const result = engine.planOperations({ ...event, workItem: frontWorkItem }, [
    backWorkItem,
    dbWorkItem,
    infraWorkItem,
  ])

  const statusOperations = result.operations.filter((op) => op.fieldName === 'Status')
  expect(statusOperations).toHaveLength(4)
  expect(statusOperations.map((op) => op.projectItemId)).toEqual([
    'PVTI_F',
    'PVTI_B',
    'PVTI_D',
    'PVTI_I',
  ])
  expect(statusOperations.every((op) => op.value === 'Blocked')).toBe(true) // because workItem has blockedByNodeIds: ['I_3']
})

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
      wishCreatedAt: '2026-06-23T11:00:00.000Z',
      mergedAt: '2026-06-23T12:00:00.000Z',
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

test('plans Done status when item state is closed', () => {
  const engine = new GitHubSyncEngine()
  const result = engine.planOperations(
    {
      ...event,
      workItem: {
        ...workItem,
        state: 'closed',
      },
    },
    []
  )

  expect(result.operations[0]).toMatchObject({
    operationKey: 'project-status:I_6:Done',
    value: 'Done',
  })
})

test('plans update-assignees when assignees are present', () => {
  const engine = new GitHubSyncEngine()
  const result = engine.planOperations(
    {
      ...event,
      workItem: {
        ...workItem,
        assignees: ['U_1', 'U_2'],
      },
    },
    []
  )

  expect(result.operations).toContainEqual(
    expect.objectContaining({
      operationKey: 'project-assignees:I_6:U_1,U_2',
      kind: 'update-assignees',
      nodeId: 'I_6',
      projectItemId: 'PVTI_6',
      assignees: ['U_1', 'U_2'],
    })
  )
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
      wishCreatedAt: '2026-06-23T11:00:00.000Z',
      mergedAt: '2026-06-23T12:00:00.000Z',
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
    await new Promise((resolve) => setTimeout(resolve, 50))
    executionOrder.push(1)
  })

  const p2 = engine.executeWithLock('I_6', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
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

test('abrirPrsCoordenados handles multiple repos, appends cross-links, and updates Project V2', async () => {
  const engine = new GitHubSyncEngine()
  const calls: { kind: string; args: unknown }[] = []

  const client = {
    createPullRequest: async (args: {
      repositoryId: string
      baseRefName: string
      headRefName: string
      title: string
      body: string
    }) => {
      calls.push({ kind: 'createPullRequest', args })
      return {
        id: `PR_${args.repositoryId}`,
        number: 100 + calls.length,
        url: `https://github.com/pr/${args.repositoryId}`,
      }
    },
    updatePullRequest: async (args: { pullRequestId: string; body: string }) => {
      calls.push({ kind: 'updatePullRequest', args })
      return args.pullRequestId
    },
    getTextField: async (args: { projectId: string; fieldName: string }) => {
      calls.push({ kind: 'getTextField', args })
      return { fieldId: 'F_TEXT_LINK' }
    },
    setTextField: async (args: {
      projectId: string
      itemId: string
      fieldId: string
      text: string
    }) => {
      calls.push({ kind: 'setTextField', args })
      return args.itemId
    },
  } as unknown as ProjectV2Client

  const missionResult = {
    projectId: 'PROJ_1',
    projectItemId: 'ITEM_1',
    repos: [
      {
        repositoryId: 'R_1',
        repositoryName: 'Frontend',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T1',
        body: 'B1',
      },
      {
        repositoryId: 'R_2',
        repositoryName: 'Backend',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T2',
        body: 'B2',
      },
      {
        repositoryId: 'R_3',
        repositoryName: 'DB',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T3',
        body: 'B3',
      },
      {
        repositoryId: 'R_4',
        repositoryName: 'Infra',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T4',
        body: 'B4',
      },
    ],
  }

  await engine.abrirPrsCoordenados(missionResult, client)

  const creates = calls.filter((c) => c.kind === 'createPullRequest')
  expect(creates).toHaveLength(4)

  const updates = calls.filter((c) => c.kind === 'updatePullRequest')
  expect(updates).toHaveLength(4)

  // Verify cross-link formatting in body
  // R_1 (Frontend) should have PRs from Backend (R_2), DB (R_3), Infra (R_4)
  const frontUpdate = updates.find(
    (u) => (u.args as { pullRequestId: string }).pullRequestId === 'PR_R_1'
  )
  expect((frontUpdate?.args as { body: string }).body).toContain(
    'PR de Frontend associado ao PR de Backend #102, PR de DB #103 e PR de Infra #104'
  )

  const setText = calls.find((c) => c.kind === 'setTextField')
  expect((setText?.args as { text: string }).text).toBe(
    'https://github.com/pr/R_1\nhttps://github.com/pr/R_2\nhttps://github.com/pr/R_3\nhttps://github.com/pr/R_4'
  )
})

test('abrirPrsCoordenados throws PartialSyncError on partial failure', async () => {
  const engine = new GitHubSyncEngine()
  const client = {
    createPullRequest: async (args: {
      repositoryId: string
      baseRefName: string
      headRefName: string
      title: string
      body: string
    }) => {
      if (args.repositoryId === 'FAIL') throw new Error('API Rate Limit')
      return {
        id: `PR_${args.repositoryId}`,
        number: 100,
        url: `https://github.com/pr/${args.repositoryId}`,
      }
    },
  } as unknown as ProjectV2Client

  const missionResult = {
    projectId: 'PROJ_1',
    projectItemId: 'ITEM_1',
    repos: [
      {
        repositoryId: 'OK_1',
        repositoryName: 'Front',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T1',
        body: 'B1',
      },
      {
        repositoryId: 'FAIL',
        repositoryName: 'Back',
        headBranch: 'feat/1',
        baseBranch: 'main',
        title: 'T2',
        body: 'B2',
      },
    ],
  }

  try {
    await engine.abrirPrsCoordenados(missionResult, client)
    expect.fail('Should have thrown PartialSyncError')
  } catch (err) {
    const syncErr = err as PartialSyncError
    expect(syncErr.name).toBe('PartialSyncError')
    expect(syncErr.message).toContain('Falha ao abrir PR para o repositório Back')
    expect(syncErr.openedPrUrls).toEqual(['https://github.com/pr/OK_1'])
  }
})
