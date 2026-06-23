import { expect, test } from 'vitest'
import { ExecutionLedger } from './execution-ledger'
import type { SynapseActor, SynapseScope } from '../types'

test('chooses a new action when prior scheduled run already completed the top candidate', () => {
  const ledger = new ExecutionLedger()
  const agent = { id: 'ra-main', role: 'ra' as const }
  const scope = {
    type: 'wing' as const,
    wingId: 'loureng/gitorch',
    targetId: 'loureng/gitorch',
  }

  const first = ledger.start({
    agent,
    scope,
    scheduledFor: '2026-06-21T00:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-21T00:00:05.000Z',
  })

  ledger.complete(first.id, {
    completedAt: '2026-06-21T00:10:00.000Z',
    summary: 'Benchmarked the most critical function and stored findings.',
    evidenceRefs: ['cortex:drawer:ra-benchmark-critical-function'],
    nextCandidateActions: ['benchmark:second-critical-function', 'audit:critical-callers'],
  })

  const decision = ledger.chooseNextAction(agent, scope, [
    'benchmark:critical-function',
    'benchmark:second-critical-function',
    'audit:critical-callers',
  ])

  expect(decision).toEqual({
    actionKey: 'benchmark:second-critical-function',
    reason: 'Skipped 1 previously completed action for this agent and scope.',
    repeated: false,
  })
})

test('records start and complete details without exposing mutable stored state', () => {
  const ledger = new ExecutionLedger()
  const agent: SynapseActor = { id: 'ra-main', role: 'ra' }
  const scope: SynapseScope = {
    type: 'wing',
    wingId: 'loureng/gitorch',
    targetId: 'loureng/gitorch',
  }

  const started = ledger.start({
    agent,
    scope,
    scheduledFor: '2026-06-22T00:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-22T00:00:05.000Z',
  })

  agent.id = 'mutated-agent'
  scope.targetId = 'mutated-scope'

  const completed = ledger.complete(started.id, {
    completedAt: '2026-06-22T00:10:00.000Z',
    summary: 'Stored benchmark evidence.',
    evidenceRefs: ['cortex:drawer:benchmark'],
    nextCandidateActions: ['benchmark:second-critical-function'],
  })

  completed.evidenceRefs.push('mutated-ref')
  completed.nextCandidateActions.push('mutated-action')
  completed.agent.id = 'mutated-return-agent'

  const history = ledger.historyForAgent(
    { id: 'ra-main', role: 'ra' },
    { type: 'wing', wingId: 'loureng/gitorch', targetId: 'loureng/gitorch' }
  )

  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({
    agent: { id: 'ra-main', role: 'ra' },
    scope: { targetId: 'loureng/gitorch' },
    status: 'completed',
    summary: 'Stored benchmark evidence.',
    evidenceRefs: ['cortex:drawer:benchmark'],
    nextCandidateActions: ['benchmark:second-critical-function'],
  })
})

test('filters history by exact scope and marks repeated when all candidates were completed', () => {
  const ledger = new ExecutionLedger()
  const agent: SynapseActor = { id: 'ra-main', role: 'ra' }
  const scope: SynapseScope = {
    type: 'wing',
    wingId: 'loureng/gitorch',
    targetId: 'loureng/gitorch',
  }
  const otherScope: SynapseScope = {
    type: 'wing',
    wingId: 'loureng/gitorch',
    targetId: 'loureng/other',
  }

  const first = ledger.start({
    agent,
    scope,
    scheduledFor: '2026-06-21T00:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-21T00:00:05.000Z',
  })
  ledger.complete(first.id, {
    completedAt: '2026-06-21T00:10:00.000Z',
    summary: 'Completed first action.',
    evidenceRefs: [],
    nextCandidateActions: [],
  })

  ledger.start({
    agent,
    scope: otherScope,
    scheduledFor: '2026-06-22T00:00:00.000Z',
    actionKey: 'benchmark:other-project',
    now: '2026-06-22T00:00:05.000Z',
  })

  expect(ledger.historyForAgent(agent, scope)).toHaveLength(1)
  expect(ledger.chooseNextAction(agent, scope, ['benchmark:critical-function'])).toEqual({
    actionKey: 'benchmark:critical-function',
    reason: 'All candidate actions were previously completed for this agent and scope.',
    repeated: true,
  })
})
