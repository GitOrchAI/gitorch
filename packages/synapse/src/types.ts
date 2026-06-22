export type AgentRole = 'owner' | 'ra' | 'po' | 'sm' | 'qa' | 'system'

export type PheromoneType =
  | 'exploring'
  | 'claiming'
  | 'modifying'
  | 'completed'
  | 'warning'
  | 'blocked'

export type SynapseScopeType = 'wing' | 'issue' | 'pull-request' | 'file' | 'graph-node'

export type SynapseEventType =
  | 'issue.observed'
  | 'graph-rag.ready'
  | 'execution.started'
  | 'execution.completed'
  | 'execution.skipped'
  | 'pheromone.created'
  | 'pheromone.decayed'
  | 'claim.acquired'
  | 'claim.rejected'
  | 'claim.released'
  | 'decision.requested'
  | 'decision.answered'

export interface SynapseScope {
  type: SynapseScopeType
  wingId: string
  targetId: string
}

export interface SynapseActor {
  id: string
  role: AgentRole
}

export interface SynapseEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  type: SynapseEventType
  scope: SynapseScope
  actor: SynapseActor
  payload: TPayload
  createdAt: string
  causationId?: string
  correlationId?: string
}

export interface PheromoneMark {
  id: string
  type: PheromoneType
  scope: SynapseScope
  owner: SynapseActor
  strength: number
  createdAt: string
  updatedAt: string
  expiresAt?: string
  sourceEventId?: string
  reason: string
  metadata: Record<string, unknown>
}

export interface ClaimLease {
  id: string
  scope: SynapseScope
  owner: SynapseActor
  acquiredAt: string
  expiresAt: string
  reason: string
}

export interface DecisionBrief {
  id: string
  scope: SynapseScope
  requestedBy: SynapseActor
  status: 'open' | 'answered' | 'cancelled'
  question: string
  options: DecisionOption[]
  createdAt: string
  answeredAt?: string
  answerId?: string
}

export interface DecisionOption {
  id: string
  label: string
  tradeoff: string
  recommended: boolean
}

export interface ExecutionRecord {
  id: string
  agent: SynapseActor
  scope: SynapseScope
  scheduledFor: string
  startedAt: string
  completedAt?: string
  status: 'started' | 'completed' | 'skipped' | 'blocked'
  actionKey: string
  summary: string
  evidenceRefs: string[]
  nextCandidateActions: string[]
}

export interface NextActionDecision {
  actionKey: string
  reason: string
  repeated: boolean
}
