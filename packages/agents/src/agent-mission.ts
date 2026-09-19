import { WorkspaceManager } from '@gitorch/workspace-engine'
import { DEFAULT_AGENT_RUNTIME_ASSIGNMENTS } from './runtime-config'
import type { ExecutionLimits } from './execution-limits'
import type {
  AgentMission,
  AgentRuntimeSelection,
  F6AgentRole,
  F6AgentRuntime,
  RuntimeCredentialRef,
  MissionState,
} from './types'
import { AGENT_SYSTEM_PROMPTS } from './prompts/index.js'
import { buildPrimingPreamble } from './prompts/priming.js'

export const workspaceManager = new WorkspaceManager()

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
  executionLimits?: ExecutionLimits
}

export function buildAgentMission(input: BuildAgentMissionInput): AgentMission {
  const runtime = input.runtime ?? DEFAULT_AGENT_RUNTIME_ASSIGNMENTS[input.role]

  if (input.credentialRef.runtime !== runtime.runtime) {
    throw new Error(
      `Credential runtime ${input.credentialRef.runtime} does not match selected runtime ${runtime.runtime}`
    )
  }

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

export function missionStateReducer(
  state: MissionState,
  update: Partial<MissionState>
): MissionState {
  const missionUpdate = update.mission
  let nextMission = state.mission

  if (missionUpdate) {
    nextMission = {
      ...state.mission,
      ...missionUpdate,
      // Restore core integrity fields if missing or falsy in the update
      id: missionUpdate.id || state.mission.id,
      projectId: missionUpdate.projectId || state.mission.projectId,
      repository: missionUpdate.repository || state.mission.repository,
      role: missionUpdate.role || state.mission.role,
      goal: missionUpdate.goal || state.mission.goal,
      prompt: missionUpdate.prompt || state.mission.prompt,
      runtime: missionUpdate.runtime || state.mission.runtime,
      credentialRef: missionUpdate.credentialRef || state.mission.credentialRef,
      evidenceRefs: missionUpdate.evidenceRefs || state.mission.evidenceRefs,
    }
  }

  return {
    ...state,
    ...update,
    mission: nextMission,
  }
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
