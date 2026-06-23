import { SynapseClient } from '@gitorch/synapse'
import { expect, test } from 'vitest'

import type { GitHubSyncEvent } from '../types'
import { GitHubSynapseAdapter } from './github-synapse-adapter'

test('publishes normalized GitHub sync events into Synapse', () => {
  const synapse = new SynapseClient()
  const adapter = new GitHubSynapseAdapter(synapse)
  const event: GitHubSyncEvent = {
    id: 'delivery-1:projects_v2_item:edited:PVTI_1',
    deliveryId: 'delivery-1',
    eventName: 'projects_v2_item',
    action: 'edited',
    occurredAt: '2026-06-23T12:00:00.000Z',
    projectItem: {
      projectId: 'PVT_1',
      itemId: 'PVTI_1',
      contentNodeId: 'I_1',
      fields: { Status: 'Blocked' },
    },
  }

  adapter.publish(event)

  expect(synapse.events()[0]).toMatchObject({
    type: 'github.project_item.synced',
    scope: { type: 'github-project-item', wingId: 'github', targetId: 'PVTI_1' },
    correlationId: 'delivery-1',
  })
})

test('publishes dependency changes into issue scope', () => {
  const synapse = new SynapseClient()
  const adapter = new GitHubSynapseAdapter(synapse)

  adapter.publish({
    id: 'delivery-2:issue_dependencies:blocked_by_added:I_6',
    deliveryId: 'delivery-2',
    eventName: 'issue_dependencies',
    action: 'blocked_by_added',
    repository: 'loureng/gitorch',
    occurredAt: '2026-06-23T12:00:00.000Z',
    dependency: {
      blockedNodeId: 'I_6',
      blockingNodeId: 'I_3',
      repository: 'loureng/gitorch',
    },
  })

  expect(synapse.events()[0]).toMatchObject({
    type: 'github.dependency.changed',
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: 'I_6' },
  })
})
