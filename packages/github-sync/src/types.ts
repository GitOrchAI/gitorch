export type GitHubWebhookEventName =
  | 'ping'
  | 'issues'
  | 'pull_request'
  | 'sub_issues'
  | 'issue_dependencies'
  | 'projects_v2'
  | 'projects_v2_item'
  | 'projects_v2_status_update'

export type GitHubIssueType = 'Epic' | 'Feature' | 'Task' | 'Bug' | 'Security' | 'Improvement'

export type GitHubWorkState = 'open' | 'closed' | 'merged' | 'draft'

export type ProjectV2FieldName =
  | 'Status'
  | 'Priority'
  | 'Owner Agent'
  | 'Risk'
  | 'Phase'
  | 'Iteration'
  | 'Severity'
  | 'Effort'
  | 'Type'
  | 'Parent issue'
  | 'Sub-issue progress'
  | 'Linked pull requests'
  | 'Reviewers'

export type ProjectV2Status =
  'Inbox' | 'Ready' | 'Blocked' | 'In Progress' | 'In Review' | 'Done' | 'Archived'

export interface GitHubDeliveryHeaders {
  deliveryId: string
  eventName: GitHubWebhookEventName
  signature256: string
  hookId?: string
  userAgent?: string
  installationTargetType?: string
  installationTargetId?: string
}

export interface GitHubDeliveryEnvelope<TPayload = unknown> {
  headers: GitHubDeliveryHeaders
  payload: TPayload
  receivedAt: string
  body: string
  mergedAt?: string
  leadTime?: number
}

export interface GitHubWorkItem {
  nodeId: string
  number: number
  repository: string
  title: string
  type: GitHubIssueType
  state: GitHubWorkState
  labels: string[]
  parentIssueNodeId?: string
  subIssueNodeIds: string[]
  blockedByNodeIds: string[]
  blockingNodeIds: string[]
  projectItemIds: string[]
  linkedPullRequestNodeIds?: string[]
  wishCreatedAt?: string
  mergedAt?: string
  leadTime?: number
}

export interface GitHubDependencyEdge {
  blockedNodeId: string
  blockingNodeId: string
  repository: string
}

export interface GitHubHierarchyEdge {
  parentNodeId: string
  childNodeId: string
  repository: string
}

export interface ProjectV2ItemSnapshot {
  projectId: string
  itemId: string
  contentNodeId?: string
  repository?: string
  fields: Partial<Record<ProjectV2FieldName, string | number>>
}

export interface GitHubSyncEvent {
  id: string
  deliveryId: string
  eventName: GitHubWebhookEventName
  action: string
  repository?: string
  occurredAt: string
  workItem?: GitHubWorkItem
  dependency?: GitHubDependencyEdge
  hierarchy?: GitHubHierarchyEdge
  projectItem?: ProjectV2ItemSnapshot
  mergedAt?: string
  leadTime?: number
}

export interface AvailabilityDecision {
  nodeId: string
  available: boolean
  reason: string
  blockedByNodeIds: string[]
}

export interface GitHubSyncOperation {
  operationKey: string
  kind:
    | 'add-project-item'
    | 'update-project-field'
    | 'archive-project-item'
    | 'create-status-update'
    | 'create-issue'
    | 'link-sub-issue'
    | 'link-dependency'
  nodeId?: string
  projectId?: string
  projectItemId?: string
  fieldName?: ProjectV2FieldName
  value?: string | number
}
