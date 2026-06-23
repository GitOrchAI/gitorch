import {
  ClaimManager,
  type AcquireClaimInput,
  type AcquireClaimResult,
} from './claims/claim-manager'
import {
  DecisionBriefService,
  type RequestDecisionBriefInput,
} from './decision-briefs/decision-brief'
import { SynapseEventBus } from './events/event-bus'
import {
  ExecutionLedger,
  type CompleteExecutionInput,
  type StartExecutionInput,
} from './executions/execution-ledger'
import { InMemoryPheromoneStore } from './pheromones/pheromone-store'
import type {
  DecisionBrief,
  ExecutionRecord,
  NextActionDecision,
  PheromoneMark,
  SynapseActor,
  SynapseEvent,
  SynapseScope,
} from './types'

export interface SynapseClientOptions {
  eventBus?: SynapseEventBus
  executionLedger?: ExecutionLedger
  pheromoneStore?: InMemoryPheromoneStore
  decisionBriefService?: DecisionBriefService
}

export interface ObserveIssueInput {
  scope: SynapseScope
  actor: SynapseActor
  title: string
  now: string
}

export class SynapseClient {
  private readonly eventBus: SynapseEventBus
  private readonly executionLedger: ExecutionLedger
  private readonly pheromoneStore: InMemoryPheromoneStore
  private readonly claimManager: ClaimManager
  private readonly decisionBriefService: DecisionBriefService
  private nextEventId = 1

  constructor(options: SynapseClientOptions = {}) {
    this.eventBus = options.eventBus ?? new SynapseEventBus()
    this.executionLedger = options.executionLedger ?? new ExecutionLedger()
    this.pheromoneStore = options.pheromoneStore ?? new InMemoryPheromoneStore()
    this.claimManager = new ClaimManager(this.pheromoneStore)
    this.decisionBriefService = options.decisionBriefService ?? new DecisionBriefService()
  }

  observeIssue(input: ObserveIssueInput): SynapseEvent<{ title: string }> {
    return this.publishEvent('issue.observed', input.scope, input.actor, input.now, {
      title: input.title,
    })
  }

  startExecution(input: StartExecutionInput): ExecutionRecord {
    const record = this.executionLedger.start(input)
    this.publishEvent('execution.started', input.scope, input.agent, input.now, {
      recordId: record.id,
      actionKey: record.actionKey,
      scheduledFor: record.scheduledFor,
    })
    return record
  }

  completeExecution(recordId: string, input: CompleteExecutionInput): ExecutionRecord {
    const record = this.executionLedger.complete(recordId, input)
    this.publishEvent('execution.completed', record.scope, record.agent, input.completedAt, {
      recordId: record.id,
      actionKey: record.actionKey,
      status: record.status,
      evidenceRefs: [...record.evidenceRefs],
      nextCandidateActions: [...record.nextCandidateActions],
    })
    return record
  }

  chooseNextAction(
    agent: SynapseActor,
    scope: SynapseScope,
    candidates: string[]
  ): NextActionDecision {
    return this.executionLedger.chooseNextAction(agent, scope, candidates)
  }

  acquireClaim(input: AcquireClaimInput): AcquireClaimResult {
    const result = this.claimManager.acquire(input)
    this.publishEvent(
      result.acquired ? 'claim.acquired' : 'claim.rejected',
      input.scope,
      input.owner,
      input.now,
      {
        leaseId: result.lease?.id,
        blockedByLeaseId: result.blockedBy?.id,
      }
    )
    return result
  }

  markBlocked(
    scope: SynapseScope,
    owner: SynapseActor,
    reason: string,
    now: string
  ): PheromoneMark {
    const mark = this.pheromoneStore.create({
      type: 'blocked',
      scope,
      owner,
      reason,
      metadata: {},
      now,
    })

    this.publishEvent('pheromone.created', scope, owner, now, {
      pheromoneId: mark.id,
      pheromoneType: mark.type,
      reason: mark.reason,
    })

    return mark
  }

  requestDecision(input: RequestDecisionBriefInput): DecisionBrief {
    const brief = this.decisionBriefService.request(input)
    this.publishEvent('decision.requested', input.scope, input.requestedBy, input.now, {
      briefId: brief.id,
      question: brief.question,
      optionCount: brief.options.length,
    })
    return brief
  }

  activePheromones(scope: SynapseScope, now: string): PheromoneMark[] {
    return this.pheromoneStore.activeForScope(scope, now)
  }

  events(): SynapseEvent[] {
    return this.eventBus.allEvents()
  }

  private publishEvent<TPayload extends Record<string, unknown>>(
    type: SynapseEvent<TPayload>['type'],
    scope: SynapseScope,
    actor: SynapseActor,
    createdAt: string,
    payload: TPayload
  ): SynapseEvent<TPayload> {
    const event: SynapseEvent<TPayload> = {
      id: `event-${this.nextEventId++}`,
      type,
      scope: { ...scope },
      actor: { ...actor },
      payload,
      createdAt,
    }

    this.eventBus.publish(event)
    return event
  }
}

export type { AcquireClaimInput, AcquireClaimResult, RequestDecisionBriefInput }
export type { CompleteExecutionInput, StartExecutionInput }
