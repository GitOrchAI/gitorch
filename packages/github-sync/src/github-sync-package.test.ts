import { expect, test } from 'vitest'

import type { GitHubIssueType, GitHubSyncEvent, ProjectV2FieldName } from './types'

test('exports F5 GitHub-native public contracts', () => {
  const issueType: GitHubIssueType = 'Feature'
  const field: ProjectV2FieldName = 'Status'
  const event: GitHubSyncEvent = {
    id: 'delivery-1:issues:opened:42',
    deliveryId: 'delivery-1',
    eventName: 'issues',
    action: 'opened',
    repository: 'loureng/gitorch',
    occurredAt: '2026-06-23T12:00:00.000Z',
    workItem: {
      nodeId: 'I_123',
      number: 42,
      repository: 'loureng/gitorch',
      title: 'Implement Projects V2 sync',
      type: issueType,
      state: 'open',
      labels: ['feature'],
      parentIssueNodeId: 'I_EPIC',
      subIssueNodeIds: [],
      blockedByNodeIds: [],
      blockingNodeIds: [],
      projectItemIds: ['PVTI_123'],
    },
  }

  expect(event.workItem?.type).toBe('Feature')
  expect(field).toBe('Status')
})
