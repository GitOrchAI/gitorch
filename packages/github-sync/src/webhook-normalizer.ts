import type {
  GitHubDeliveryEnvelope,
  GitHubIssueType,
  GitHubSyncEvent,
  GitHubWebhookEventName,
  GitHubWorkItem,
  GitHubWorkState,
} from './types'

const ISSUE_TYPES = new Set<GitHubIssueType>([
  'Epic',
  'Feature',
  'Task',
  'Bug',
  'Security',
  'Improvement',
])

export class GitHubWebhookNormalizer {
  normalize(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
    switch (envelope.headers.eventName) {
      case 'issues':
        return normalizeIssue(envelope)
      case 'pull_request':
        return normalizePullRequest(envelope)
      case 'sub_issues':
        return normalizeSubIssue(envelope)
      case 'issue_dependencies':
        return normalizeIssueDependency(envelope)
      case 'projects_v2_item':
        return normalizeProjectItem(envelope)
      case 'projects_v2':
      case 'projects_v2_status_update':
      case 'ping':
        return normalizeGeneric(envelope)
      default:
        return unsupportedEvent(envelope.headers.eventName)
    }
  }
}

function normalizeIssue(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)
  const repository = repositoryName(payload)
  const issue = requiredRecord(payload, 'issue')
  const workItem: GitHubWorkItem = {
    nodeId: requiredString(issue, 'node_id'),
    number: requiredNumber(issue, 'number'),
    repository,
    title: requiredString(issue, 'title'),
    type: issueType(issue),
    state: workState(issue),
    labels: namedNodeIdsOrNames(issue['labels'], 'name'),
    parentIssueNodeId: optionalNodeId(issue['parent_issue']),
    subIssueNodeIds: namedNodeIdsOrNames(issue['sub_issues'], 'node_id'),
    blockedByNodeIds: namedNodeIdsOrNames(issue['blocked_by'], 'node_id'),
    blockingNodeIds: namedNodeIdsOrNames(issue['blocking'], 'node_id'),
    projectItemIds: namedNodeIdsOrNames(issue['project_items'], 'id'),
    wishCreatedAt: optionalString(issue, 'created_at'),
  }

  return {
    id: eventId(envelope, workItem.nodeId),
    deliveryId: envelope.headers.deliveryId,
    eventName: 'issues',
    action: action(payload, envelope.headers.eventName),
    repository,
    occurredAt: envelope.receivedAt,
    workItem,
  }
}

function normalizePullRequest(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)
  const repository = repositoryName(payload)
  const pullRequest = requiredRecord(payload, 'pull_request')
  const pullRequestNodeId = requiredString(pullRequest, 'node_id')
  const mergedAt = optionalString(pullRequest, 'merged_at')

  return {
    id: eventId(envelope, pullRequestNodeId),
    deliveryId: envelope.headers.deliveryId,
    eventName: 'pull_request',
    action: action(payload, envelope.headers.eventName),
    repository,
    occurredAt: envelope.receivedAt,
    mergedAt,
    workItem: {
      nodeId: pullRequestNodeId,
      number: requiredNumber(pullRequest, 'number'),
      repository,
      title: requiredString(pullRequest, 'title'),
      type: 'Task',
      state: pullRequestState(pullRequest),
      labels: namedNodeIdsOrNames(pullRequest['labels'], 'name'),
      subIssueNodeIds: [],
      blockedByNodeIds: [],
      blockingNodeIds: [],
      projectItemIds: [],
      linkedPullRequestNodeIds: [pullRequestNodeId],
      mergedAt,
    },
  }
}

function normalizeSubIssue(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)
  const repository = repositoryName(payload)
  const parentIssue = requiredRecord(payload, 'parent_issue')
  const childIssue = optionalRecord(payload['sub_issue']) ?? requiredRecord(payload, 'issue')
  const childNodeId = requiredString(childIssue, 'node_id')

  return {
    id: eventId(envelope, childNodeId),
    deliveryId: envelope.headers.deliveryId,
    eventName: 'sub_issues',
    action: action(payload, envelope.headers.eventName),
    repository,
    occurredAt: envelope.receivedAt,
    hierarchy: {
      parentNodeId: requiredString(parentIssue, 'node_id'),
      childNodeId,
      repository,
    },
  }
}

function normalizeIssueDependency(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)
  const repository = repositoryName(payload)
  const blockedIssue = optionalRecord(payload['blocked_issue']) ?? requiredRecord(payload, 'issue')
  const blockingIssue =
    optionalRecord(payload['blocking_issue']) ?? requiredRecord(payload, 'blocking_issue')
  const blockedNodeId = requiredString(blockedIssue, 'node_id')

  return {
    id: eventId(envelope, blockedNodeId),
    deliveryId: envelope.headers.deliveryId,
    eventName: 'issue_dependencies',
    action: action(payload, envelope.headers.eventName),
    repository,
    occurredAt: envelope.receivedAt,
    dependency: {
      blockedNodeId,
      blockingNodeId: requiredString(blockingIssue, 'node_id'),
      repository,
    },
  }
}

function normalizeProjectItem(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)
  const item = requiredRecord(payload, 'projects_v2_item')
  const itemId = optionalString(item, 'node_id') ?? requiredString(item, 'id')
  const status = optionalString(item, 'status')

  return {
    id: eventId(envelope, itemId),
    deliveryId: envelope.headers.deliveryId,
    eventName: 'projects_v2_item',
    action: action(payload, envelope.headers.eventName),
    repository: optionalRepositoryName(payload),
    occurredAt: envelope.receivedAt,
    projectItem: {
      projectId: requiredString(item, 'project_node_id'),
      itemId,
      contentNodeId: optionalString(item, 'content_node_id'),
      fields: status ? { Status: status } : {},
    },
  }
}

function normalizeGeneric(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
  const payload = asRecord(envelope.payload)

  return {
    id: eventId(envelope, optionalRepositoryName(payload) ?? 'github'),
    deliveryId: envelope.headers.deliveryId,
    eventName: envelope.headers.eventName,
    action: action(payload, envelope.headers.eventName),
    repository: optionalRepositoryName(payload),
    occurredAt: envelope.receivedAt,
  }
}

function eventId(envelope: GitHubDeliveryEnvelope, targetId: string): string {
  const payload = asRecord(envelope.payload)
  return `${envelope.headers.deliveryId}:${envelope.headers.eventName}:${action(
    payload,
    envelope.headers.eventName
  )}:${targetId}`
}

function action(payload: Record<string, unknown>, fallback: string): string {
  return optionalString(payload, 'action') ?? fallback
}

function repositoryName(payload: Record<string, unknown>): string {
  const name = optionalRepositoryName(payload)

  if (!name) {
    throw new Error('GitHub webhook payload is missing repository.full_name.')
  }

  return name
}

function optionalRepositoryName(payload: Record<string, unknown>): string | undefined {
  return optionalString(optionalRecord(payload['repository']), 'full_name')
}

function issueType(issue: Record<string, unknown>): GitHubIssueType {
  const typeName = optionalString(optionalRecord(issue['type']), 'name')
  return typeName && ISSUE_TYPES.has(typeName as GitHubIssueType)
    ? (typeName as GitHubIssueType)
    : 'Task'
}

function workState(issue: Record<string, unknown>): GitHubWorkState {
  const state = optionalString(issue, 'state')
  return state === 'closed' ? 'closed' : 'open'
}

function pullRequestState(pullRequest: Record<string, unknown>): GitHubWorkState {
  if (pullRequest['merged'] === true) return 'merged'
  if (pullRequest['draft'] === true) return 'draft'
  return workState(pullRequest)
}

function namedNodeIdsOrNames(value: unknown, key: string): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => optionalString(optionalRecord(entry), key))
        .filter((entry): entry is string => entry !== undefined)
    : []
}

function optionalNodeId(value: unknown): string | undefined {
  return optionalString(optionalRecord(value), 'node_id')
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = optionalRecord(value)

  if (!record) {
    throw new Error('GitHub webhook payload must be an object.')
  }

  return record
}

function requiredRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = optionalRecord(parent[key])

  if (!value) {
    throw new Error(`GitHub webhook payload is missing object field: ${key}`)
  }

  return value
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(parent: Record<string, unknown>, key: string): string {
  const value = optionalString(parent, key)

  if (!value) {
    throw new Error(`GitHub webhook payload is missing string field: ${key}`)
  }

  return value
}

function optionalString(
  parent: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = parent?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requiredNumber(parent: Record<string, unknown>, key: string): number {
  const value = parent[key]

  if (typeof value !== 'number') {
    throw new Error(`GitHub webhook payload is missing number field: ${key}`)
  }

  return value
}

function unsupportedEvent(eventName: never): never {
  throw new Error(`Unsupported GitHub webhook event: ${eventName as GitHubWebhookEventName}`)
}
