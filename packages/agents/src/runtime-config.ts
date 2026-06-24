import type { AgentRuntimeAssignments } from './types'

export const DEFAULT_AGENT_RUNTIME_ASSIGNMENTS: AgentRuntimeAssignments = {
  po: { runtime: 'codex' },
  ra: { runtime: 'claude' },
  sm: { runtime: 'antigravity' },
  qa: { runtime: 'antigravity' },
}
