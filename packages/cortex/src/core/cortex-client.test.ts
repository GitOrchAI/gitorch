import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexDrawer, CortexIdentity, CortexTriple } from '../types'
import { CortexClient } from './cortex-client'

function drawer(id: string, roomId = 'auth', hallId = 'hall_facts'): CortexDrawer {
  return {
    id,
    wingId: 'loureng/gitorch',
    roomId,
    hallId,
    content: `content ${id}`,
    importance: 0.8,
    emotionalWeight: 0.5,
    createdAt: '2026-06-19T00:00:00.000Z',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.9,
    tags: ['auth'],
  }
}

describe('CortexClient', () => {
  const identity: CortexIdentity = {
    wingId: 'loureng/gitorch',
    persona: 'GitOrch Cortex Orchestrator',
    orchestrationGuidelines: 'Use MemPalace isolation and L0-L3 retrieval.',
  }
  const triple: CortexTriple & { wingId: string } = {
    wingId: 'loureng/gitorch',
    subject: 'Cortex',
    predicate: 'uses',
    object: 'SQLite+ChromaDB',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.95,
  }

  let sqliteStore: {
    upsertIdentity: ReturnType<typeof vi.fn>
    upsertDrawer: ReturnType<typeof vi.fn>
    insertTriple: ReturnType<typeof vi.fn>
    getIdentity: ReturnType<typeof vi.fn>
    getTopDrawers: ReturnType<typeof vi.fn>
    getDrawersByScope: ReturnType<typeof vi.fn>
  }
  let chromaStore: {
    upsertDrawer: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    sqliteStore = {
      upsertIdentity: vi.fn(),
      upsertDrawer: vi.fn(),
      insertTriple: vi.fn(),
      getIdentity: vi.fn().mockReturnValue(identity),
      getTopDrawers: vi.fn().mockReturnValue([drawer('drawer-1')]),
      getDrawersByScope: vi.fn().mockReturnValue([drawer('drawer-1')]),
    }
    chromaStore = {
      upsertDrawer: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          drawerId: 'drawer-1',
          layer: 'L3',
          score: 0.9,
          content: 'content drawer-1',
          metadata: drawer('drawer-1'),
        },
      ]),
    }
  })

  it('writes identity, drawer and triple through the SQLite store', () => {
    const client = new CortexClient({ sqliteStore })

    client.init()
    client.writeIdentity(identity)
    client.writeDrawer(drawer('drawer-1'))
    client.writeTriple(triple)

    expect(sqliteStore.upsertIdentity).toHaveBeenCalledWith(identity)
    expect(sqliteStore.upsertDrawer).toHaveBeenCalledWith(drawer('drawer-1'))
    expect(sqliteStore.insertTriple).toHaveBeenCalledWith(triple)
  })

  it('wakes up through the layer selector', () => {
    const client = new CortexClient({ sqliteStore })

    client.init()

    expect(client.wakeUp('loureng/gitorch')).toEqual({
      identity,
      drawers: [drawer('drawer-1')],
      tokenBudget: 190,
    })
    expect(sqliteStore.getTopDrawers).toHaveBeenCalledWith('loureng/gitorch', 15)
  })

  it('recalls local scoped drawers', () => {
    const client = new CortexClient({ sqliteStore })

    client.init()

    expect(client.recallLocal('loureng/gitorch', 'auth', 'hall_facts')).toEqual([
      drawer('drawer-1'),
    ])
    expect(sqliteStore.getDrawersByScope).toHaveBeenCalledWith(
      'loureng/gitorch',
      'auth',
      'hall_facts',
      20
    )
  })

  it('searches semantic drawers through Chroma and deterministic embeddings', async () => {
    const client = new CortexClient({
      chromaStore,
      embeddingFn: async () => [0.1, 0.2, 0.3],
    })

    client.init()

    await expect(client.search('loureng/gitorch', 'auth stripe', 3)).resolves.toEqual([
      {
        drawerId: 'drawer-1',
        layer: 'L3',
        score: 0.9,
        content: 'content drawer-1',
        metadata: drawer('drawer-1'),
      },
    ])
    expect(chromaStore.search).toHaveBeenCalledWith(
      'loureng/gitorch',
      undefined,
      undefined,
      [0.1, 0.2, 0.3],
      3
    )
  })

  it('throws when methods are used before init', () => {
    const client = new CortexClient({ sqliteStore })

    expect(() => client.writeIdentity(identity)).toThrow(
      'CortexClient is not initialized. Call init() first.'
    )
  })
})
