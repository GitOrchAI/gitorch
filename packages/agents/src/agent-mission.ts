import { WorkspaceManager } from '@gitorch/workspace-engine'
import { DEFAULT_AGENT_RUNTIME_ASSIGNMENTS } from './runtime-config'
import type {
  AgentMission,
  AgentRuntimeSelection,
  F6AgentRole,
  F6AgentRuntime,
  RuntimeCredentialRef,
} from './types'
import { AGENT_SYSTEM_PROMPTS } from './prompts/index.js'
import { buildPrimingPreamble } from './prompts/priming.js'
import { orchestratorRegistry } from './orchestrator.js'
import { hydrateStateFromCheckpoint } from './workspace-priming.js'

export const workspaceManager = new WorkspaceManager()
export const missionRegistry = new Map<string, BuildAgentMissionInput>()

export interface BuildAgentMissionInput {
  id: string
  projectId: string
  repository: string
  role: F6AgentRole
  goal: string
  context: string[]
  credentialRef: RuntimeCredentialRef
  runtime?: AgentRuntimeSelection
  evidenceRefs?: string[]
  userId?: string
  /** Mata o processo do agente após N ms (guarda contra missão pendurada). */
  timeoutMs?: number
}

export function buildAgentMission(input: BuildAgentMissionInput): AgentMission {
  const runtime = input.runtime ?? DEFAULT_AGENT_RUNTIME_ASSIGNMENTS[input.role]

  if (input.credentialRef.runtime !== runtime.runtime) {
    throw new Error(
      `Credential runtime ${input.credentialRef.runtime} does not match selected runtime ${runtime.runtime}`
    )
  }

  missionRegistry.set(input.id, input)

  return {
    id: input.id,
    projectId: input.projectId,
    repository: input.repository,
    role: input.role,
    goal: input.goal,
    prompt: buildPrompt(input.role, input.repository, input.goal, input.context, runtime.runtime),
    runtime: { ...runtime },
    credentialRef: {
      ...input.credentialRef,
      providedSecrets: [...input.credentialRef.providedSecrets],
    },
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    userId: input.userId,
  }
}

export async function resumeMissionFromCheckpoint(
  missionId: string,
  options?: Partial<BuildAgentMissionInput>
) {
  let input = missionRegistry.get(missionId)

  if (!input) {
    if (
      !options ||
      !options.id ||
      !options.projectId ||
      !options.repository ||
      !options.role ||
      !options.goal ||
      !options.context ||
      !options.credentialRef
    ) {
      throw new Error(
        `Mission ${missionId} not found in registry and no sufficient fallback options provided.`
      )
    }
    input = options as BuildAgentMissionInput
  }

  let orchestrator = orchestratorRegistry.get(missionId)
  if (!orchestrator) {
    // Reconstruct the orchestrator
    const { AgentOrchestrator } = await import('./orchestrator.js')
    const { RuntimeRegistry } = await import('./runtime-adapter.js')
    const registry = new RuntimeRegistry()
    // For fallback reconstruction, we might need a default setup.
    // Usually, caller provides the full orchestrator environment in the real world.
    orchestrator = new AgentOrchestrator({ registry })
  }

  const userId = input.userId ?? 'user-default'
  const allocation = (await workspaceManager.allocateWorkspace(userId, input.projectId, {
    repository: input.repository,
  })) as { path?: string } | undefined

  if (allocation?.path) {
    const state = await hydrateStateFromCheckpoint(allocation.path)
    if (state) {
      const mission = buildAgentMission(input)
      mission.waitingStatus = 'resuming'
      try {
        return await orchestrator.runMissionCore(mission, allocation.path, input.timeoutMs)
      } finally {
        missionRegistry.delete(missionId)
      }
    }
  }

  missionRegistry.delete(missionId)
  throw new Error(`Failed to resume mission ${missionId}: No valid checkpoint found.`)
}

function buildPrompt(
  role: F6AgentRole,
  repository: string,
  goal: string,
  context: string[],
  runtime?: F6AgentRuntime
): string {
  const contextBlock = context.length > 0 ? context.map((line) => `- ${line}`).join('\n') : '- none'
  const systemPrompt = AGENT_SYSTEM_PROMPTS[role] || ''

  return [
    buildPrimingPreamble(role, runtime),
    `Role: ${role}`,
    `Repository: ${repository}`,
    `Goal: ${goal}`,
    '',
    'System Instructions:',
    systemPrompt,
    '',
    'Context:',
    contextBlock,
    '',
    'Rules:',
    '- Use GitHub as the canonical work system.',
    '- Do not create product work unless the mission explicitly asks for it.',
    '- Persist project understanding as memory-ready evidence.',
  ].join('\n')
}
