import { describe, expect, it } from 'vitest'
import {
  ClaimManager,
  DecisionBriefService,
  ExecutionLedger,
  InMemoryPheromoneStore,
  PheromonePolicy,
  SynapseClient,
  SynapseEventBus,
} from './index'
import type {
  AgentRole,
  ClaimLease,
  DecisionBrief,
  DecisionOption,
  ExecutionRecord,
  NextActionDecision,
  PheromoneMark,
  PheromoneType,
  SynapseActor,
  SynapseEvent,
  SynapseEventType,
  SynapseScope,
  SynapseScopeType,
} from './index'

describe('@gitorch/synapse package exports', () => {
  it('exposes the public package surface', () => {
    expect(SynapseEventBus).toBeDefined()
    expect(ExecutionLedger).toBeDefined()
    expect(PheromonePolicy).toBeDefined()
    expect(InMemoryPheromoneStore).toBeDefined()
    expect(ClaimManager).toBeDefined()
    expect(DecisionBriefService).toBeDefined()
    expect(SynapseClient).toBeDefined()
  })

  it('exposes typed public contracts', () => {
    const role: AgentRole = 'ra'
    const pheromoneType: PheromoneType = 'claiming'
    const scopeType: SynapseScopeType = 'wing'
    const eventType: SynapseEventType = 'execution.completed'
    const scope: SynapseScope = {
      type: scopeType,
      wingId: 'loureng/gitorch',
      targetId: 'loureng/gitorch',
    }
    const actor: SynapseActor = { id: 'ra-main', role }
    const event: SynapseEvent = {
      id: 'evt-1',
      type: eventType,
      scope,
      actor,
      payload: { actionKey: 'benchmark:critical-function' },
      createdAt: '2026-06-22T00:10:00.000Z',
    }
    const pheromone: PheromoneMark = {
      id: 'ph-1',
      type: pheromoneType,
      scope,
      owner: actor,
      strength: 1,
      createdAt: '2026-06-22T00:00:05.000Z',
      updatedAt: '2026-06-22T00:00:05.000Z',
      reason: 'RA claimed daily benchmark work.',
      metadata: { schedule: 'daily' },
    }
    const claim: ClaimLease = {
      id: 'claim-1',
      scope,
      owner: actor,
      acquiredAt: '2026-06-22T00:00:05.000Z',
      expiresAt: '2026-06-22T01:00:05.000Z',
      reason: 'RA is executing the selected daily improvement.',
    }
    const option: DecisionOption = {
      id: 'hold',
      label: 'Hold for owner review',
      tradeoff: 'Slower progress with lower risk.',
      recommended: true,
    }
    const brief: DecisionBrief = {
      id: 'decision-1',
      scope,
      requestedBy: actor,
      status: 'open',
      question: 'Should RA repeat a previously completed benchmark?',
      options: [option],
      createdAt: '2026-06-22T00:00:05.000Z',
    }
    const execution: ExecutionRecord = {
      id: 'run-1',
      agent: actor,
      scope,
      scheduledFor: '2026-06-22T00:00:00.000Z',
      startedAt: '2026-06-22T00:00:05.000Z',
      status: 'completed',
      actionKey: 'benchmark:critical-function',
      summary: 'Benchmarked the most critical function.',
      evidenceRefs: ['cortex:drawer:ra-benchmark-critical-function'],
      nextCandidateActions: ['benchmark:second-critical-function'],
    }
    const nextAction: NextActionDecision = {
      actionKey: 'benchmark:second-critical-function',
      reason: 'Skipped previous completed action.',
      repeated: false,
    }

    expect(pheromoneType).toBe('claiming')
    expect(eventType).toBe('execution.completed')
    expect(event.actor).toBe(actor)
    expect(pheromone.owner).toBe(actor)
    expect(claim.owner).toBe(actor)
    expect(brief.options).toEqual([option])
    expect(execution.actionKey).toBe('benchmark:critical-function')
    expect(nextAction.repeated).toBe(false)
  })
})
