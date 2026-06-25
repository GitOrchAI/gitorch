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

export type OnboardingStepKind =
  | 'map-code-graph'
  | 'read-docs'
  | 'prepare-docs'
  | 'ensure-project-v2'
  | 'classify-existing-issues'
  | 'inspect-open-prs'
  | 'capture-ci-state'
  | 'ask-owner-question'
  | 'persist-project-memory'
  | 'write-repository-docs'

export interface OnboardingStep {
  kind: OnboardingStepKind
  summary: string
  evidenceRefs: string[]
}

export interface OwnerQuestion {
  id: string
  question: string
  options: ['A', 'B', 'C', 'Free form']
}

export interface ProjectOnboardingPlan {
  projectId: string
  repository: string
  createsProductWork: false
  steps: OnboardingStep[]
  ownerQuestions: OwnerQuestion[]
}

export type CiConclusion = 'success' | 'failure' | 'pending' | 'missing'
export type GateCheckResult = 'passed' | 'failed' | 'not-run'
export type DeliveredScopeResult = 'complete' | 'incomplete' | 'unknown'

export type JulesPrGateDecision =
  | 'wait-for-ci'
  | 'wait-for-jules-ci-fix'
  | 'run-qa'
  | 'request-jules-adjustments'
  | 'merge-ready'
  | 'blocked'

export interface JulesPrGateResult {
  decision: JulesPrGateDecision
  mergeAllowed: boolean
  comment?: string
  requiredActions: string[]
}
