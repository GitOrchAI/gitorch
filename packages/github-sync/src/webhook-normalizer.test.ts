import { expect, test } from 'vitest'

import type { GitHubDeliveryEnvelope } from './types'
import { GitHubWebhookNormalizer } from './webhook-normalizer'

test('normalizes issue dependency events as blocking gates', () => {
  const normalizer = new GitHubWebhookNormalizer()
  const event = normalizer.normalize({
    receivedAt: '2026-06-23T12:00:00.000Z',
    body: '{}',
    headers: {
      deliveryId: 'delivery-1',
      eventName: 'issue_dependencies',
      signature256: 'sha256=abc',
    },
    payload: {
      action: 'blocked_by_added',
      repository: { full_name: 'loureng/gitorch' },
      blocked_issue: { node_id: 'I_6', number: 6, title: 'Task 6' },
      blocking_issue: { node_id: 'I_3', number: 3, title: 'Task 3' },
    },
  } satisfies GitHubDeliveryEnvelope)

  expect(event).toEqual({
    id: 'delivery-1:issue_dependencies:blocked_by_added:I_6',
    deliveryId: 'delivery-1',
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
})

test('normalizes pull request with merged_at timestamp', () => {
  const normalizer = new GitHubWebhookNormalizer()
  const event = normalizer.normalize({
    receivedAt: '2026-06-23T12:05:00.000Z',
    body: '{}',
    headers: {
      deliveryId: 'delivery-4',
      eventName: 'pull_request',
      signature256: 'sha256=abc',
    },
    payload: {
      action: 'closed',
      repository: { full_name: 'loureng/gitorch' },
      pull_request: {
        node_id: 'PR_1',
        number: 1,
        title: 'Test PR',
        state: 'closed',
        merged: true,
        merged_at: '2026-06-23T12:00:00.000Z',
        labels: [],
      },
    },
  } satisfies GitHubDeliveryEnvelope)

  expect(event.mergedAt).toEqual('2026-06-23T12:00:00.000Z')
  expect(event.workItem?.mergedAt).toEqual('2026-06-23T12:00:00.000Z')
  expect(event.workItem?.state).toEqual('merged')
})

test('normalizes sub-issue events as hierarchy edges', () => {
  const normalizer = new GitHubWebhookNormalizer()
  const event = normalizer.normalize({
    receivedAt: '2026-06-23T12:00:00.000Z',
    body: '{}',
    headers: {
      deliveryId: 'delivery-sub',
      eventName: 'sub_issues',
      signature256: 'sha256=abc',
    },
    payload: {
      action: 'sub_issue_added',
      repository: { full_name: 'loureng/gitorch' },
      parent_issue: { node_id: 'I_FEATURE', number: 10, title: 'Feature Y' },
      sub_issue: { node_id: 'I_3', number: 3, title: 'Task 3' },
    },
  } satisfies GitHubDeliveryEnvelope)

  expect(event.hierarchy).toEqual({
    parentNodeId: 'I_FEATURE',
    childNodeId: 'I_3',
    repository: 'loureng/gitorch',
  })
})

test('normalizes projects v2 item events as project item snapshots', () => {
  const normalizer = new GitHubWebhookNormalizer()
  const event = normalizer.normalize({
    receivedAt: '2026-06-23T12:01:00.000Z',
    body: '{}',
    headers: {
      deliveryId: 'delivery-2',
      eventName: 'projects_v2_item',
      signature256: 'sha256=abc',
    },
    payload: {
      action: 'edited',
      projects_v2_item: {
        id: 'PVTI_123',
        node_id: 'PVTI_123',
        project_node_id: 'PVT_1',
        content_node_id: 'I_6',
        status: 'Blocked',
      },
      organization: { login: 'loureng' },
    },
  } satisfies GitHubDeliveryEnvelope)

  expect(event.projectItem).toEqual({
    projectId: 'PVT_1',
    itemId: 'PVTI_123',
    contentNodeId: 'I_6',
    fields: { Status: 'Blocked' },
  })
})

test('normalizes issues with issue type and project item ids', () => {
  const normalizer = new GitHubWebhookNormalizer()
  const event = normalizer.normalize({
    receivedAt: '2026-06-23T12:02:00.000Z',
    body: '{}',
    headers: {
      deliveryId: 'delivery-3',
      eventName: 'issues',
      signature256: 'sha256=abc',
    },
    payload: {
      action: 'opened',
      repository: { full_name: 'loureng/gitorch' },
      issue: {
        node_id: 'I_42',
        number: 42,
        title: 'Feature X',
        state: 'open',
        type: { name: 'Feature' },
        labels: [{ name: 'feature' }],
        sub_issues: [{ node_id: 'I_43' }],
        blocked_by: [{ node_id: 'I_41' }],
        blocking: [],
        project_items: [{ id: 'PVTI_42' }],
      },
    },
  } satisfies GitHubDeliveryEnvelope)

  expect(event.workItem).toMatchObject({
    nodeId: 'I_42',
    type: 'Feature',
    labels: ['feature'],
    subIssueNodeIds: ['I_43'],
    blockedByNodeIds: ['I_41'],
    projectItemIds: ['PVTI_42'],
  })
})
