import { loadPlaybook, type CadenceRole } from '@gitorch/cadence'
import type { F6AgentRole } from '../types'

// System prompts por papel: gerados do Cadence (fonte única do método).
// O playbook diz O QUE o papel faz e COMO; o preamble (priming.ts) cuida de
// identidade, guardrails e convergência. Editar processo = editar o playbook
// em packages/cadence/playbooks, nunca aqui.

function buildSystemPrompt(role: CadenceRole): string {
  return loadPlaybook(role)
}

export const AGENT_SYSTEM_PROMPTS: Record<F6AgentRole, string> = {
  ra: buildSystemPrompt('ra'),
  po: buildSystemPrompt('po'),
  sm: buildSystemPrompt('sm'),
  qa: buildSystemPrompt('qa'),
}
