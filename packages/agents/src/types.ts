export const F6_AGENT_ROLES = ['po', 'ra', 'sm', 'qa'] as const
export type F6AgentRole = (typeof F6_AGENT_ROLES)[number]

export const F6_AGENT_RUNTIMES = ['codex', 'claude', 'antigravity'] as const
export type F6AgentRuntime = (typeof F6_AGENT_RUNTIMES)[number]

/**
 * Os níveis de esforço que os motores aceitam, na UNIÃO das escadas reais —
 * cada motor tem a sua, e elas NÃO coincidem. Medido nesta VM em 01/09/2026:
 *
 *   claude       --effort            low, medium, high, xhigh, max
 *   codex        -c model_reasoning_effort=…   low, medium, high, xhigh
 *   antigravity  --effort existe, mas é RECUSADA junto com --model; lá o
 *                esforço vive dentro do nome (`Gemini 3.7 Flash (High)`)
 *
 * 'xhigh' e 'max' entraram aqui em 01/09: o tipo parava em 'high' e, com ele,
 * um QA configurado para julgar no esforço máximo não tinha como ser expresso.
 * Quem sabe QUAL nível vale em QUAL motor é
 * apps/control-plane/src/services/esforco-por-motor.ts — este tipo só carrega
 * o vocabulário, nunca a permissão.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  /** Dono da credencial: quem conectou o motor. Usado para materializar a
   * credencial certa (por usuário) no ambiente isolado da missão. */
  ownerUserId?: string
}

export interface AgentMission {
  waitingStatus?: string | null
  waitingReason?: string | null
  id: string
  projectId: string
  repository: string
  role: F6AgentRole
  goal: string
  prompt: string
  runtime: AgentRuntimeSelection
  credentialRef: RuntimeCredentialRef
  evidenceRefs: string[]
  userId?: string
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
