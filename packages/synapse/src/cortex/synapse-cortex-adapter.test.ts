import { expect, test } from 'vitest'
import type { CortexClient } from '@gitorch/cortex'

import { SynapseCortexAdapter, type CortexWriter } from './synapse-cortex-adapter'
import type { ExecutionRecord, PheromoneMark, SynapseEvent } from '../types'

test('persists pheromone as triple and drawer', async () => {
  const writes: unknown[] = []
  const writer: CortexWriter = {
    writeTriple: (triple) => writes.push(['triple', triple]),
    writeDrawer: async (drawer) => writes.push(['drawer', drawer]),
  }
  const adapter = new SynapseCortexAdapter(writer)

  const mark: PheromoneMark = {
    id: 'ph-1',
    type: 'blocked',
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    owner: { id: 'qa', role: 'qa' },
    strength: 1,
    createdAt: '2026-06-22T10:00:00.000Z',
    updatedAt: '2026-06-22T10:00:00.000Z',
    expiresAt: '2026-06-22T10:05:00.000Z',
    reason: 'Tests failed',
    metadata: {},
  }

  await adapter.persistPheromone(mark)

  expect(writes).toHaveLength(2)
  expect(writes[0]).toEqual([
    'triple',
    expect.objectContaining({
      wingId: 'loureng/gitorch',
      subject: 'synapse:issue:42',
      predicate: 'HAS_PHEROMONE',
      object: 'blocked',
    }),
  ])
  expect(writes[1]).toEqual([
    'drawer',
    expect.objectContaining({
      id: 'synapse-pheromone-ph-1',
      roomId: 'synapse',
      hallId: 'pheromones',
      validTo: '2026-06-22T10:05:00.000Z',
      tags: ['synapse', 'pheromone', 'blocked'],
    }),
  ])
})

test('persists event as triple and drawer', async () => {
  const writes: unknown[] = []
  const writer: Pick<CortexClient, 'writeTriple' | 'writeDrawer'> = {
    writeTriple: (triple) => writes.push(['triple', triple]),
    writeDrawer: async (drawer) => writes.push(['drawer', drawer]),
  }
  const adapter = new SynapseCortexAdapter(writer)

  const event: SynapseEvent = {
    id: 'event-1',
    type: 'execution.completed',
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    actor: { id: 'ra-main', role: 'ra' },
    payload: { actionKey: 'benchmark:critical-function' },
    createdAt: '2026-06-22T10:10:00.000Z',
    causationId: 'event-0',
    correlationId: 'corr-1',
  }

  await adapter.persistEvent(event)

  expect(writes).toEqual([
    [
      'triple',
      expect.objectContaining({
        wingId: 'loureng/gitorch',
        subject: 'synapse:issue:42',
        predicate: 'EMITTED_EVENT',
        object: 'execution.completed',
      }),
    ],
    [
      'drawer',
      expect.objectContaining({
        id: 'synapse-event-event-1',
        roomId: 'synapse',
        hallId: 'events',
        tags: ['synapse', 'event', 'execution.completed'],
      }),
    ],
  ])
})

test('persists execution record as triple and drawer', async () => {
  const writes: unknown[] = []
  const writer: Pick<CortexClient, 'writeTriple' | 'writeDrawer'> = {
    writeTriple: (triple) => writes.push(['triple', triple]),
    writeDrawer: async (drawer) => writes.push(['drawer', drawer]),
  }
  const adapter = new SynapseCortexAdapter(writer)

  const record: ExecutionRecord = {
    id: 'run-1',
    agent: { id: 'ra-main', role: 'ra' },
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    scheduledFor: '2026-06-22T10:00:00.000Z',
    startedAt: '2026-06-22T10:01:00.000Z',
    completedAt: '2026-06-22T10:03:00.000Z',
    status: 'completed',
    actionKey: 'benchmark:critical-function',
    summary: 'Benchmarked the critical function.',
    evidenceRefs: ['cortex:drawer:bench-1'],
    nextCandidateActions: ['benchmark:secondary-function'],
  }

  await adapter.persistExecution(record)

  expect(writes).toEqual([
    [
      'triple',
      expect.objectContaining({
        wingId: 'loureng/gitorch',
        subject: 'synapse:issue:42',
        predicate: 'RECORDED_EXECUTION',
        object: 'benchmark:critical-function',
        validFrom: '2026-06-22T10:01:00.000Z',
        validTo: '2026-06-22T10:03:00.000Z',
      }),
    ],
    [
      'drawer',
      expect.objectContaining({
        id: 'synapse-execution-run-1',
        roomId: 'synapse',
        hallId: 'executions',
        tags: ['synapse', 'execution', 'completed', 'ra'],
      }),
    ],
  ])
})
