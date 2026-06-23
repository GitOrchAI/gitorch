import { describe, expect, test } from 'vitest'
import { InMemoryPheromoneStore } from './pheromone-store'

describe('InMemoryPheromoneStore', () => {
  test('creates pheromone mark and filters active marks by scope', () => {
    const store = new InMemoryPheromoneStore()
    const mark = store.create({
      type: 'exploring',
      scope: { type: 'file', wingId: 'loureng/gitorch', targetId: 'packages/cgc/src/index.ts' },
      owner: { id: 'ra', role: 'ra' },
      reason: 'RA is inspecting file',
      metadata: {},
      now: '2026-06-22T10:00:00.000Z',
    })

    expect(mark.expiresAt).toBe('2026-06-22T10:02:00.000Z')
    expect(store.activeForScope(mark.scope, '2026-06-22T10:01:00.000Z')).toEqual([mark])
    expect(store.activeForScope(mark.scope, '2026-06-22T10:03:00.000Z')).toEqual([])
  })

  test('rejects active blocking marks from competing owners', () => {
    const store = new InMemoryPheromoneStore()
    const scope = { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' } as const

    store.create({
      type: 'claiming',
      scope,
      owner: { id: 'sm', role: 'sm' },
      reason: 'SM is assigning work',
      metadata: {},
      now: '2026-06-22T10:00:00.000Z',
    })

    expect(() =>
      store.create({
        type: 'claiming',
        scope,
        owner: { id: 'qa', role: 'qa' },
        reason: 'QA is also assigning work',
        metadata: {},
        now: '2026-06-22T10:01:00.000Z',
      })
    ).toThrow(/conflict/i)
  })

  test('allows same-owner writes and expired competing blockers', () => {
    const store = new InMemoryPheromoneStore()
    const scope = { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' } as const

    store.create({
      type: 'claiming',
      scope,
      owner: { id: 'sm', role: 'sm' },
      reason: 'SM is assigning work',
      metadata: {},
      now: '2026-06-22T10:00:00.000Z',
    })

    expect(() =>
      store.create({
        type: 'claiming',
        scope,
        owner: { id: 'sm', role: 'sm' },
        reason: 'SM refreshes claim',
        metadata: {},
        now: '2026-06-22T10:01:00.000Z',
      })
    ).not.toThrow()

    expect(() =>
      store.create({
        type: 'claiming',
        scope,
        owner: { id: 'qa', role: 'qa' },
        reason: 'QA claims after expiry',
        metadata: {},
        now: '2026-06-22T11:01:00.000Z',
      })
    ).not.toThrow()
  })

  test('filters by exact scope', () => {
    const store = new InMemoryPheromoneStore()

    store.create({
      type: 'exploring',
      scope: { type: 'file', wingId: 'loureng/gitorch', targetId: 'packages/cgc/src/index.ts' },
      owner: { id: 'ra', role: 'ra' },
      reason: 'RA is inspecting file',
      metadata: {},
      now: '2026-06-22T10:00:00.000Z',
    })

    expect(
      store.activeForScope(
        { type: 'file', wingId: 'loureng/gitorch', targetId: 'packages/cortex/src/index.ts' },
        '2026-06-22T10:01:00.000Z'
      )
    ).toEqual([])
  })

  test('does not expose mutable metadata through create or history', () => {
    const store = new InMemoryPheromoneStore()
    const metadata = { nested: { source: 'initial' } }

    const created = store.create({
      type: 'warning',
      scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
      owner: { id: 'qa', role: 'qa' },
      reason: 'QA found a critical issue',
      metadata,
      now: '2026-06-22T10:00:00.000Z',
    })

    metadata.nested.source = 'mutated-input'
    ;(created.metadata['nested'] as { source: string }).source = 'mutated-return'

    const history = store.history()
    ;(history[0]?.metadata['nested'] as { source: string }).source = 'mutated-history'

    expect(store.history()[0]?.metadata).toEqual({ nested: { source: 'initial' } })
  })

  test('decays expired marks and keeps them in history', () => {
    const store = new InMemoryPheromoneStore()
    const scope = { type: 'file', wingId: 'loureng/gitorch', targetId: 'packages/cgc/src/index.ts' }

    const mark = store.create({
      type: 'exploring',
      scope,
      owner: { id: 'ra', role: 'ra' },
      reason: 'RA is inspecting file',
      metadata: {},
      now: '2026-06-22T10:00:00.000Z',
    })

    expect(store.decayAll('2026-06-22T10:03:00.000Z')).toEqual([])
    expect(store.history()).toEqual([mark])
  })
})
