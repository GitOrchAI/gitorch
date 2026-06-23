import { test, expect } from 'vitest'

import { SynapseClient } from './synapse-client'
import type { SynapseEventType, SynapseScopeType } from './types'

test('observes issue, chooses next execution action, and acquires claim', () => {
  const synapse = new SynapseClient()
  const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '42' }

  synapse.observeIssue({
    scope,
    actor: { id: 'system', role: 'system' },
    title: 'Coordinate F4',
    now: '2026-06-22T10:00:00.000Z',
  })

  const run = synapse.startExecution({
    agent: { id: 'ra-main', role: 'ra' },
    scope,
    scheduledFor: '2026-06-22T10:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-22T10:00:05.000Z',
  })

  synapse.completeExecution(run.id, {
    completedAt: '2026-06-22T10:10:00.000Z',
    summary: 'Benchmarked critical function.',
    evidenceRefs: ['cortex:drawer:benchmark'],
    nextCandidateActions: ['benchmark:second-critical-function'],
  })

  const decision = synapse.chooseNextAction({ id: 'ra-main', role: 'ra' }, scope, [
    'benchmark:critical-function',
    'benchmark:second-critical-function',
  ])

  const claim = synapse.acquireClaim({
    scope,
    owner: { id: 'sm', role: 'sm' },
    reason: 'SM is coordinating',
    now: '2026-06-22T10:11:00.000Z',
  })

  expect(decision.actionKey).toBe('benchmark:second-critical-function')
  expect(decision.repeated).toBe(false)
  expect(claim.acquired).toBe(true)
  expect(synapse.events().map((event) => event.type)).toEqual([
    'issue.observed',
    'execution.started',
    'execution.completed',
    'claim.acquired',
  ])
  expect(synapse.activePheromones(scope, '2026-06-22T10:12:00.000Z')).toHaveLength(1)
})

test('requests decisions and marks blocked work through the facade', () => {
  const synapse = new SynapseClient()
  const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '77' }
  const owner = { id: 'sm', role: 'sm' as const }

  const brief = synapse.requestDecision({
    scope,
    requestedBy: owner,
    question: 'Which benchmark should run next?',
    options: [
      {
        id: 'option-a',
        label: 'critical-function',
        tradeoff: 'Fastest to validate',
        recommended: true,
      },
      {
        id: 'option-b',
        label: 'second-critical-function',
        tradeoff: 'Broader coverage',
        recommended: false,
      },
    ],
    now: '2026-06-22T11:00:00.000Z',
  })

  const blocked = synapse.markBlocked(
    scope,
    owner,
    'Waiting on benchmark environment confirmation',
    '2026-06-22T11:05:00.000Z'
  )

  expect(brief.status).toBe('open')
  expect(blocked.type).toBe('blocked')
  expect(synapse.activePheromones(scope, '2026-06-22T11:06:00.000Z')).toEqual([blocked])
  expect(synapse.events().map((event) => event.type)).toEqual([
    'decision.requested',
    'pheromone.created',
  ])
})

test('records GitHub sync events through the public facade', () => {
  const scopeType: SynapseScopeType = 'github-project-item'
  const eventType: SynapseEventType = 'github.project_item.synced'
  const synapse = new SynapseClient()

  const event = synapse.recordExternalEvent({
    type: eventType,
    scope: { type: scopeType, wingId: 'loureng/gitorch', targetId: 'PVTI_123' },
    actor: { id: 'github-app', role: 'system' },
    payload: {
      deliveryId: 'delivery-1',
      projectItemId: 'PVTI_123',
      status: 'Ready',
    },
    now: '2026-06-23T12:00:00.000Z',
    correlationId: 'delivery-1',
  })

  expect(event.type).toBe('github.project_item.synced')
  expect(event.scope.type).toBe('github-project-item')
  expect(event.correlationId).toBe('delivery-1')
  expect(synapse.events()).toEqual([event])
})
