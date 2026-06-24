import { expect, test } from 'vitest'

import type { GitHubWorkItem } from './types'
import { GitHubWorkModel } from './work-model'

function item(
  input: Partial<GitHubWorkItem> & Pick<GitHubWorkItem, 'nodeId' | 'number' | 'title'>
): GitHubWorkItem {
  return {
    repository: 'loureng/gitorch',
    type: 'Task',
    state: 'open',
    labels: [],
    subIssueNodeIds: [],
    blockedByNodeIds: [],
    blockingNodeIds: [],
    projectItemIds: [],
    ...input,
  }
}

test('uses issue types as the canonical work classification', () => {
  const model = new GitHubWorkModel()

  expect(
    model.issueTypeFor(item({ nodeId: 'I_1', number: 1, title: 'F5 sync', type: 'Epic' }))
  ).toBe('Epic')
})

test('keeps sub-issues as hierarchy and dependencies as execution gates', () => {
  const model = new GitHubWorkModel()
  const task3 = item({ nodeId: 'I_3', number: 3, title: 'Build dependency parser', state: 'open' })
  const task6 = item({
    nodeId: 'I_6',
    number: 6,
    title: 'Run blocked follow-up',
    blockedByNodeIds: ['I_3'],
  })
  const task7 = item({
    nodeId: 'I_7',
    number: 7,
    title: 'Run second blocked follow-up',
    blockedByNodeIds: ['I_3'],
  })
  const feature = item({
    nodeId: 'I_FEATURE',
    number: 10,
    title: 'Feature Y',
    type: 'Feature',
    subIssueNodeIds: ['I_3', 'I_6', 'I_7'],
  })

  expect(model.hierarchyFor(feature)).toEqual(['I_3', 'I_6', 'I_7'])
  expect(model.availabilityFor(task6, [task3])).toEqual({
    nodeId: 'I_6',
    available: false,
    reason: 'Blocked by 1 open dependency.',
    blockedByNodeIds: ['I_3'],
  })
  expect(model.availabilityFor(task7, [{ ...task3, state: 'closed' }]).available).toBe(true)
})

test('treats missing dependency snapshots as open blockers', () => {
  const model = new GitHubWorkModel()
  const blocked = item({
    nodeId: 'I_8',
    number: 8,
    title: 'Blocked on unknown task',
    blockedByNodeIds: ['I_UNKNOWN'],
  })

  expect(model.availabilityFor(blocked, [])).toEqual({
    nodeId: 'I_8',
    available: false,
    reason: 'Blocked by 1 open dependency.',
    blockedByNodeIds: ['I_UNKNOWN'],
  })
})
