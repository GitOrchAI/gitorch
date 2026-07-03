import { SynapseClient, type SynapseActor, type SynapseScope } from '@gitorch/synapse'
import { buildAgentMission, type BuildAgentMissionInput, workspaceManager } from './agent-mission'
import type { RuntimeExecutionResult, RuntimeRegistry } from './runtime-adapter'

export interface WorkspaceAllocation {
  path?: string
}

export interface WorkspaceProvider {
  allocateWorkspace(
    userId: string,
    projectId: string,
    options?: { repository?: string }
  ): Promise<WorkspaceAllocation | unknown>
  hibernateWorkspace(userId: string, projectId: string): Promise<unknown>
}

export interface AgentOrchestratorOptions {
  registry: RuntimeRegistry
  synapse?: SynapseClient
  workspace?: WorkspaceProvider
}

export class AgentOrchestrator {
  private readonly registry: RuntimeRegistry
  private readonly synapse: SynapseClient
  private readonly workspace: WorkspaceProvider

  constructor(options: AgentOrchestratorOptions) {
    this.registry = options.registry
    this.synapse = options.synapse ?? new SynapseClient()
    this.workspace = options.workspace ?? workspaceManager
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

    const userId = mission.userId ?? 'user-default'
    const allocation = (await this.workspace.allocateWorkspace(userId, mission.projectId, {
      repository: mission.repository,
    })) as WorkspaceAllocation | undefined

    let result: RuntimeExecutionResult
    try {
      const adapter = this.registry.resolve(mission.runtime.runtime)
      result = await adapter.run({
        missionId: mission.id,
        prompt: mission.prompt,
        runtime: mission.runtime,
        credentialRef: mission.credentialRef,
        cwd: allocation?.path,
      })
    } finally {
      await this.workspace.hibernateWorkspace(userId, mission.projectId)
    }

    this.synapse.completeExecution(record.id, {
      completedAt: new Date().toISOString(),
      summary: result.output,
      evidenceRefs: mission.evidenceRefs,
      nextCandidateActions: [],
      status: result.exitCode === 0 ? 'completed' : 'blocked',
    })

    return result
  }

  events() {
    return this.synapse.events()
  }
}
