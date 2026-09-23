import { z } from 'zod'
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

export const CANONICAL_RUNTIME_CHAIN: readonly F6AgentRuntime[] = Object.freeze([
  'codex',
  'antigravity',
  'claude',
] as const)

// Runtime padrão de cada agente quando o projeto não define o seu (decisão canônica: codex > antigravity > claude).
// Sobrescrevível por projeto via runtime-config (PATCH /api/projects/:id/runtime-config).
export const DEFAULT_AGENT_RUNTIME_ASSIGNMENTS: DefaultAgentRuntimeAssignments = Object.freeze({
  po: Object.freeze({ runtime: 'codex' }),
  ra: Object.freeze({ runtime: 'codex' }),
  sm: Object.freeze({ runtime: 'codex' }),
  qa: Object.freeze({ runtime: 'codex' }),
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

export interface TracingEnvironment {
  LANGFUSE_PUBLIC_KEY?: string
  LANGFUSE_SECRET_KEY?: string
  LANGFUSE_HOST?: string
  TELEMETRY_ENABLED?: string
}

export const BACKOFF_CONFIG = {
  baseDelay: 5000,
  maxDelay: 60000,
  factor: 2,
  maxRetries: 5,
}

export const guestAgentEngineMappingSchema = z.object({
  po: z.enum(F6_AGENT_RUNTIMES).optional(),
  ra: z.enum(F6_AGENT_RUNTIMES).optional(),
  sm: z.enum(F6_AGENT_RUNTIMES).optional(),
  qa: z.enum(F6_AGENT_RUNTIMES).optional(),
  dev: z.enum(F6_AGENT_RUNTIMES).optional(),
})

export type GuestAgentEngineMapping = z.infer<typeof guestAgentEngineMappingSchema>

export function getTracingEnvironment(): TracingEnvironment {
  return {
    ...(process.env['LANGFUSE_PUBLIC_KEY']
      ? { LANGFUSE_PUBLIC_KEY: process.env['LANGFUSE_PUBLIC_KEY'] }
      : {}),
    ...(process.env['LANGFUSE_SECRET_KEY']
      ? { LANGFUSE_SECRET_KEY: process.env['LANGFUSE_SECRET_KEY'] }
      : {}),
    ...(process.env['LANGFUSE_HOST'] ? { LANGFUSE_HOST: process.env['LANGFUSE_HOST'] } : {}),
    ...(process.env['TELEMETRY_ENABLED'] === '1' ? { TELEMETRY_ENABLED: '1' } : {}),
  }
}
