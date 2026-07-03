import {
  F6_AGENT_ROLES,
  F6_AGENT_RUNTIMES,
  type AgentRuntimeAssignments,
  type AgentRuntimeSelection,
  type F6AgentRole,
  type F6AgentRuntime,
} from './types'

type DefaultAgentRuntimeAssignments = Readonly<{
  [Role in F6AgentRole]: Readonly<AgentRuntimeSelection>
}>

// Runtime padrão de cada agente quando o projeto não define o seu.
// Sobrescrevível por projeto via runtime-config (PATCH /api/projects/:id/runtime-config).
export const DEFAULT_AGENT_RUNTIME_ASSIGNMENTS: DefaultAgentRuntimeAssignments = Object.freeze({
  po: Object.freeze({ runtime: 'antigravity' }),
  ra: Object.freeze({ runtime: 'antigravity' }),
  sm: Object.freeze({ runtime: 'antigravity' }),
  qa: Object.freeze({ runtime: 'antigravity' }),
} satisfies AgentRuntimeAssignments)

function cloneSelection(selection: Readonly<AgentRuntimeSelection>): AgentRuntimeSelection {
  return { ...selection }
}

export function isF6AgentRole(value: string): value is F6AgentRole {
  return (F6_AGENT_ROLES as readonly string[]).includes(value)
}

export function isF6AgentRuntime(value: string): value is F6AgentRuntime {
  return (F6_AGENT_RUNTIMES as readonly string[]).includes(value)
}

export function buildRuntimeChain(
  primary: AgentRuntimeSelection,
  fallbacks: AgentRuntimeSelection[] = []
): AgentRuntimeSelection[] {
  return [cloneSelection(primary), ...fallbacks.map(cloneSelection)]
}

export function normalizeRuntimeAssignments(
  overrides: Partial<AgentRuntimeAssignments> = {}
): AgentRuntimeAssignments {
  return F6_AGENT_ROLES.reduce((assignments, role) => {
    assignments[role] = cloneSelection(overrides[role] ?? DEFAULT_AGENT_RUNTIME_ASSIGNMENTS[role])
    return assignments
  }, {} as AgentRuntimeAssignments)
}
