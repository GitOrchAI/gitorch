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

// Decisão do owner (2026-07-03): Antigravity é o motor de todos os agentes;
// Codex é fallback manual; Claude Code nunca atua como motor de agente.
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
