import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexDrawer } from '../types'
import { ChromaSemanticStore } from './chroma-store'

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

describe('ChromaSemanticStore', () => {
  let collection: {
    upsert: ReturnType<typeof vi.fn>
    query: ReturnType<typeof vi.fn>
  }
  let client: {
    getOrCreateCollection: ReturnType<typeof vi.fn>
  }
  let store: ChromaSemanticStore

  beforeEach(() => {
    collection = {
      upsert: vi.fn(),
      query: vi.fn(),
    }
    client = {
      getOrCreateCollection: vi.fn().mockResolvedValue(collection),
    }
    store = new ChromaSemanticStore(client)
  })

  it('creates or opens a scoped collection and upserts embeddings', async () => {
    await store.upsertDrawer(drawer('drawer-1'), [0.1, 0.2, 0.3])

    expect(client.getOrCreateCollection).toHaveBeenCalledWith('cortex-loureng-gitorch', {
      metadata: {
        wingId: 'loureng/gitorch',
        layer: 'L3',
      },
    })
    expect(collection.upsert).toHaveBeenCalledWith({
      ids: ['drawer-1'],
      embeddings: [[0.1, 0.2, 0.3]],
      documents: ['content drawer-1'],
      metadatas: [
        expect.objectContaining({
          id: 'drawer-1',
          wingId: 'loureng/gitorch',
          roomId: 'auth',
          hallId: 'hall_facts',
        }),
      ],
    })
  })

  it('queries semantic drawers with scope filters', async () => {
    collection.query.mockResolvedValue({
      ids: [['drawer-2']],
      documents: [['content drawer-2']],
      distances: [[0.1]],
      metadatas: [[drawer('drawer-2')]],
    })

    const results = await store.search('loureng/gitorch', 'auth', 'hall_facts', [0.4, 0.5], 2)

    expect(collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.4, 0.5]],
      nResults: 2,
      where: {
        $and: [
          { wingId: { $eq: 'loureng/gitorch' } },
          { roomId: { $eq: 'auth' } },
          { hallId: { $eq: 'hall_facts' } },
        ],
      },
      include: ['documents', 'metadatas', 'distances'],
    })
    expect(results).toEqual([
      {
        drawerId: 'drawer-2',
        layer: 'L3',
        score: 0.9,
        content: 'content drawer-2',
        metadata: drawer('drawer-2'),
      },
    ])
  })

  it('builds where filters without optional room and hall', async () => {
    collection.query.mockResolvedValue({
      ids: [[]],
      documents: [[]],
      distances: [[]],
      metadatas: [[]],
    })

    await store.search('loureng/gitorch', undefined, undefined, [0.1], 5)

    expect(collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.1]],
      nResults: 5,
      where: { wingId: { $eq: 'loureng/gitorch' } },
      include: ['documents', 'metadatas', 'distances'],
    })
  })
})
