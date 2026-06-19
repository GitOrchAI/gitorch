import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteStore } from './sqlite-store'

describe('SqliteStore', () => {
  let store: SqliteStore

  beforeEach(() => {
    store = new SqliteStore(':memory:')
    store.init()
  })

  it('stores and reads identity', () => {
    const identity = {
      wingId: 'loureng/gitorch',
      persona: 'GitOrch orchestrator',
      orchestrationGuidelines: 'Use official docs only',
    }

    store.upsertIdentity(identity)

    expect(store.getIdentity('loureng/gitorch')).toEqual(identity)
    expect(store.getIdentity('missing/wing')).toBeNull()
  })

  it('stores and retrieves temporal triples', () => {
    const triple = {
      wingId: 'loureng/gitorch',
      subject: 'F2',
      predicate: 'USES',
      object: 'SQLite',
      validFrom: '2026-06-19T00:00:00.000Z',
      validTo: '2026-12-31T23:59:59.999Z',
      confidence: 0.98,
    }

    store.insertTriple(triple)

    expect(
      store.queryTriples({
        wingId: 'loureng/gitorch',
        at: '2026-07-01T00:00:00.000Z',
      })
    ).toContainEqual(triple)

    expect(
      store.queryTriples({
        wingId: 'loureng/gitorch',
        at: '2027-01-01T00:00:00.000Z',
      })
    ).not.toContain(triple)
  })

  it('stores drawers and returns top priority drawers', () => {
    const low = {
      id: 'low',
      wingId: 'loureng/gitorch',
      roomId: 'auth',
      hallId: 'hall_facts',
      content: 'low priority',
      importance: 0.1,
      emotionalWeight: 0.1,
      createdAt: '2026-06-19T00:00:00.000Z',
      validFrom: '2026-06-19T00:00:00.000Z',
      confidence: 0.9,
      tags: ['low'],
    }
    const high = {
      ...low,
      id: 'high',
      content: 'high priority',
      importance: 0.9,
      emotionalWeight: 0.8,
      tags: ['high'],
    }

    store.upsertDrawer(low)
    store.upsertDrawer(high)

    expect(store.getTopDrawers('loureng/gitorch', 1).map((drawer) => drawer.id)).toEqual(['high'])
  })

  it('filters drawers by room and hall', () => {
    const drawer = {
      id: 'drawer-1',
      wingId: 'loureng/gitorch',
      roomId: 'auth',
      hallId: 'hall_facts',
      content: 'Auth facts',
      importance: 0.8,
      emotionalWeight: 0.5,
      createdAt: '2026-06-19T00:00:00.000Z',
      validFrom: '2026-06-19T00:00:00.000Z',
      confidence: 0.95,
      tags: ['auth'],
    }

    store.upsertDrawer(drawer)

    expect(store.getDrawersByScope('loureng/gitorch', 'auth', 'hall_facts')).toEqual([drawer])
    expect(store.getDrawersByScope('loureng/gitorch', 'billing', 'hall_facts')).toEqual([])
  })
})
