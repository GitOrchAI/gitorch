export const F6_AGENT_ROLES = ['po', 'ra', 'sm', 'qa'] as const
export type F6AgentRole = (typeof F6_AGENT_ROLES)[number]

export const F6_AGENT_RUNTIMES = ['codex', 'claude', 'antigravity'] as const
export type F6AgentRuntime = (typeof F6_AGENT_RUNTIMES)[number]

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface AgentRuntimeSelection {
  runtime: F6AgentRuntime
  model?: string
  reasoning?: ReasoningEffort
}

export type AgentRuntimeAssignments = Record<F6AgentRole, AgentRuntimeSelection>

export interface RuntimeCredentialRef {
  connectionId: string
  ownerScope: 'user' | 'organization' | 'project'
  runtime: F6AgentRuntime
  providedSecrets: string[]
}

export interface AgentMission {
  id: string
  projectId: string
  repository: string
  role: F6AgentRole
  goal: string
  prompt: string
  runtime: AgentRuntimeSelection
  credentialRef: RuntimeCredentialRef
  evidenceRefs: string[]
}
