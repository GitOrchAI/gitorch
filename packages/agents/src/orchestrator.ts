import { SynapseClient, type SynapseActor, type SynapseScope } from '@gitorch/synapse'
import { setTimeout } from 'node:timers/promises'
import {
  buildAgentMission,
  missionStateReducer,
  type BuildAgentMissionInput,
  workspaceManager,
} from './agent-mission'
import type { RuntimeExecutionResult, RuntimeRegistry } from './runtime-adapter'
import {
  QUOTA_BACKOFF_FACTOR,
  QUOTA_BACKOFF_INITIAL_MS,
  QUOTA_BACKOFF_MAX_MS,
} from './runtime-config'
import type { F6AgentRole, MissionState, NodeTransition, StateNode } from './types'
import { primeWorkspace } from './workspace-priming'

/**
 * Enriquece o CONTEXTO da missão com CONHECIMENTO do projeto, depois que o
 * workspace já está clonado/primado: resumo de codegraph (o que o código É de
 * verdade) e memórias do projeto (o que já se aprendeu). Fica como hook para o
 * pacote @gitorch/agents não depender de @gitorch/cgc/cortex — o control plane
 * injeta a implementação. Cada linha retornada vira um item de contexto.
 */
export type MissionContextEnricher = (args: {
  workspacePath?: string
  projectId: string
  role: F6AgentRole
}) => Promise<string[]>

export interface WorkspaceAllocation {
  path?: string
}

export interface WorkspaceProvider {
  allocateWorkspace(
    userId: string,
    projectId: string,
    // token: credencial do DONO do projeto para clonar repositório privado
    // (o próprio cliente, nunca uma credencial do host — spec setup-wizard-
    // redesign §17.3). Opcional: repositório público não precisa.
    options?: { repository?: string; token?: string }
  ): Promise<WorkspaceAllocation | unknown>
  hibernateWorkspace(userId: string, projectId: string): Promise<unknown>
  handleRuntimeFailure?(errorDetails: string, stepName: string, rollback: boolean): void
}

export interface AgentOrchestratorOptions {
  registry: RuntimeRegistry
  synapse?: SynapseClient
  workspace?: WorkspaceProvider
  enrichContext?: MissionContextEnricher
}

export abstract class BaseAgentNode implements StateNode {
  abstract role: F6AgentRole | 'dev'
  constructor(protected orchestrator: AgentOrchestrator) {}

  async execute(state: MissionState): Promise<NodeTransition> {
    const result = await this.orchestrator.runMissionCore(
      state.mission,
      state.workspacePath,
      state.timeoutMs
    )
    return {
      nextRole: result.exitCode === 0 ? 'done' : 'failed',
      state: { ...state, result },
    }
  }
}

export class ProductOwnerNode extends BaseAgentNode {
  role = 'po' as const
}

export class ScrumMasterNode extends BaseAgentNode {
  role = 'sm' as const
}

export class RequirementsAnalystNode extends BaseAgentNode {
  role = 'ra' as const
}

export class QualityAnalystNode extends BaseAgentNode {
  role = 'qa' as const
}

export class DeveloperNode extends BaseAgentNode {
  role = 'dev' as const
}

export class AgentOrchestrator {
  private readonly registry: RuntimeRegistry
  private readonly synapse: SynapseClient
  private readonly workspace: WorkspaceProvider
  private readonly enrichContext?: MissionContextEnricher
  private readonly nodeRegistry: Map<string, StateNode>

  constructor(options: AgentOrchestratorOptions) {
    this.registry = options.registry
    this.synapse = options.synapse ?? new SynapseClient()
    this.workspace = options.workspace ?? workspaceManager
    this.enrichContext = options.enrichContext

    this.nodeRegistry = new Map<string, StateNode>([
      ['po', new ProductOwnerNode(this)],
      ['sm', new ScrumMasterNode(this)],
      ['ra', new RequirementsAnalystNode(this)],
      ['qa', new QualityAnalystNode(this)],
      ['dev', new DeveloperNode(this)],
    ])
  }

  async runMissionCore(
    mission: ReturnType<typeof buildAgentMission>,
    workspacePath?: string,
    timeoutMs?: number
  ): Promise<RuntimeExecutionResult> {
    let result: RuntimeExecutionResult | undefined
    let backoffMs = QUOTA_BACKOFF_INITIAL_MS

    try {
      const adapter = this.registry.resolve(mission.runtime.runtime)

      while (true) {
        result = await adapter.run({
          missionId: mission.id,
          prompt: mission.prompt,
          runtime: mission.runtime,
          credentialRef: mission.credentialRef,
          role: mission.role,
          cwd: workspacePath,
          timeoutMs,
        })

        if (result.waitingStatus) {
          mission.waitingStatus = result.waitingStatus
          mission.waitingReason = result.waitingReason
        } else {
          mission.waitingStatus = null
          mission.waitingReason = null
        }

        if (result.waitingStatus === 'waiting_quota') {
          await setTimeout(backoffMs)
          backoffMs = Math.min(backoffMs * QUOTA_BACKOFF_FACTOR, QUOTA_BACKOFF_MAX_MS)
          continue
        }

        break
      }

      if (result.exitCode !== 0 || result.failedStep) {
        if (this.workspace.handleRuntimeFailure) {
          this.workspace.handleRuntimeFailure(
            result.errorDetails || result.stderr || 'Unknown runtime error',
            result.failedStep || 'run-mission',
            false
          )
        }
      }
    } catch (err: unknown) {
      if (this.workspace.handleRuntimeFailure) {
        this.workspace.handleRuntimeFailure(String(err), 'run-mission', false)
      }
      throw err
    }
    return result!
  }

  async runMission(input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
    let mission = buildAgentMission(input)
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

    // Faz o motor agir como agente GitOrch (não seguir o processo do repo).
    if (allocation?.path) {
      await primeWorkspace(allocation.path)
    }

    // Injeta CONHECIMENTO (codegraph + memórias) no contexto e RECONSTRÓI o
    // prompt — só depois do workspace existir. O id da missão é determinístico
    // (input.id), então reconstruir não muda a identidade nem o registro Synapse.
    if (this.enrichContext) {
      try {
        const extra = await this.enrichContext({
          workspacePath: allocation?.path,
          projectId: mission.projectId,
          role: mission.role,
        })
        if (extra.length > 0) {
          mission = buildAgentMission({ ...input, context: [...input.context, ...extra] })
        }
      } catch {
        // Enriquecimento é best-effort: se falhar, a missão segue com o contexto base.
      }
    }

    let result: RuntimeExecutionResult | undefined
    let currentState: MissionState = {
      mission,
      workspacePath: allocation?.path,
      timeoutMs: input.timeoutMs,
    }
    let currentRole: string | 'done' | 'failed' = mission.role

    try {
      while (currentRole !== 'done' && currentRole !== 'failed') {
        const node = this.nodeRegistry.get(currentRole)
        if (!node) {
          throw new Error(`No state node registered for role: ${currentRole}`)
        }

        const transition = await node.execute(currentState)
        currentState = missionStateReducer(currentState, transition.state)
        currentRole = transition.nextRole ?? 'done'
      }
      result = currentState.result as RuntimeExecutionResult
    } catch (err: unknown) {
      if (this.workspace.handleRuntimeFailure) {
        this.workspace.handleRuntimeFailure(String(err), 'run-mission', false)
      }
      throw err
    } finally {
      await this.workspace.hibernateWorkspace(userId, mission.projectId)
    }

    // fallback in case loop throws or somehow bypasses setting result
    if (!result) {
      result = {
        exitCode: 1,
        output: '',
        stderr: 'Execution loop failed to yield a result',
        durationMs: 0,
        missionId: mission.id,
        runtime: mission.runtime.runtime,
      }
    }

    this.synapse.completeExecution(record.id, {
      completedAt: new Date().toISOString(),
      summary: result.output,
      evidenceRefs: mission.evidenceRefs,
      nextCandidateActions: [],
      status: result.exitCode === 0 ? 'completed' : 'blocked',
    })

    return result as RuntimeExecutionResult
  }

  events() {
    return this.synapse.events()
  }
}
