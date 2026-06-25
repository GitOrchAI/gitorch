import { SynapseClient, type SynapseActor, type SynapseScope } from '@gitorch/synapse'
import { buildAgentMission, type BuildAgentMissionInput } from './agent-mission'
import type { RuntimeExecutionResult, RuntimeRegistry } from './runtime-adapter'

export interface AgentOrchestratorOptions {
  registry: RuntimeRegistry
  synapse?: SynapseClient
}

export class AgentOrchestrator {
  private readonly registry: RuntimeRegistry
  private readonly synapse: SynapseClient

  constructor(options: AgentOrchestratorOptions) {
    this.registry = options.registry
    this.synapse = options.synapse ?? new SynapseClient()
  }

  async runMission(input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
    const mission = buildAgentMission(input)
    const actor: SynapseActor = { id: `agent-${mission.role}`, role: mission.role }
    const scope: SynapseScope = {
      type: 'wing',
      wingId: mission.repository,
      targetId: mission.projectId,
    }
    const now = new Date().toISOString()

    const record = this.synapse.startExecution({
      agent: actor,
      scope,
      actionKey: mission.id,
      scheduledFor: now,
      now,
    })

    const adapter = this.registry.resolve(mission.runtime.runtime)
    const result = await adapter.run({
      missionId: mission.id,
      prompt: mission.prompt,
      runtime: mission.runtime,
      credentialRef: mission.credentialRef,
    })

    this.synapse.completeExecution(record.id, {
      completedAt: new Date().toISOString(),
      summary: result.output,
      evidenceRefs: mission.evidenceRefs,
      nextCandidateActions: [],
    })

    return result
  }

  events() {
    return this.synapse.events()
  }
}
