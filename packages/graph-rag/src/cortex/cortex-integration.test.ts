import type {
  CortexDrawer,
  CortexIdentity,
  CortexSearchResult,
  CortexWakeUpResult,
} from '@gitorch/cortex'
import { type Mock, describe, expect, test, vi } from 'vitest'
import { CortexGraphRAGAdapter, type CortexPlanContext } from './cortex-integration'
import { CortexGraphRAGAdapter as ExportedCortexGraphRAGAdapter } from '../index'

const WING_ID = 'wing-1'
const ROOM_ID = 'room-1'
const HALL_ID = 'hall-1'
const QUERY = 'semantic query for graph rag'
const DEFAULT_SEMANTIC_LIMIT = 10

type FakeCortexClient = {
  wakeUp: Mock<(wingId: string) => CortexWakeUpResult>
  recallLocal: Mock<(wingId: string, roomId?: string, hallId?: string) => CortexDrawer[]>
  search: Mock<(wingId: string, query: string, limit: number) => Promise<CortexSearchResult[]>>
}

describe('CortexGraphRAGAdapter', () => {
  test('wakeUp delegates to CortexClient and preserves identity', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)

    const result = await adapter.wakeUp(WING_ID)

    expect(fakeCortex.wakeUp).toHaveBeenCalledWith(WING_ID)
    expect(result.identity).toEqual(createIdentity())
    expect(result).toEqual(createWakeUpResult())
  })

  test('loadLocalScope passes wingId, roomId and hallId to CortexClient', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)

    const scope = await adapter.loadLocalScope(WING_ID, ROOM_ID, HALL_ID)

    expect(fakeCortex.recallLocal).toHaveBeenCalledWith(WING_ID, ROOM_ID, HALL_ID)
    expect(scope).toEqual([createDrawer('local-1')])
  })

  test('wakeUp and loadLocalScope do not require semantic search', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)
    fakeCortex.search.mockRejectedValue(new Error('semantic store unavailable'))

    await adapter.wakeUp(WING_ID)
    await adapter.loadLocalScope(WING_ID, ROOM_ID, HALL_ID)

    expect(fakeCortex.search).not.toHaveBeenCalled()
  })

  test('semanticAnchors passes query and optional limit to CortexClient', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)

    await expect(adapter.semanticAnchors(WING_ID, QUERY, 3)).resolves.toEqual([
      createSearchResult(),
    ])

    expect(fakeCortex.search).toHaveBeenCalledWith(WING_ID, QUERY, 3)
  })

  test('semanticAnchors uses the default limit when omitted', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)

    await adapter.semanticAnchors(WING_ID, QUERY)

    expect(fakeCortex.search).toHaveBeenCalledWith(WING_ID, QUERY, DEFAULT_SEMANTIC_LIMIT)
  })

  test('buildPlanContext composes wake-up, local scope and semantic anchors', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex)

    const context: CortexPlanContext = await adapter.buildPlanContext(
      WING_ID,
      QUERY,
      ROOM_ID,
      HALL_ID
    )

    expect(fakeCortex.wakeUp).toHaveBeenCalledWith(WING_ID)
    expect(fakeCortex.recallLocal).toHaveBeenCalledWith(WING_ID, ROOM_ID, HALL_ID)
    expect(fakeCortex.search).toHaveBeenCalledWith(WING_ID, QUERY, DEFAULT_SEMANTIC_LIMIT)
    expect(context).toEqual({
      wingId: WING_ID,
      identity: createIdentity(),
      wakeUp: createWakeUpResult(),
      localScope: [createDrawer('local-1')],
      semanticAnchors: [createSearchResult()],
    })
  })

  test('buildPlanContext can omit semantic anchors', async () => {
    const fakeCortex = createFakeCortexClient()
    const adapter = new CortexGraphRAGAdapter(fakeCortex, {
      includeSemanticAnchors: false,
    })

    const context = await adapter.buildPlanContext(WING_ID, QUERY)

    expect(fakeCortex.search).not.toHaveBeenCalled()
    expect(context.semanticAnchors).toEqual([])
  })

  test('exports CortexGraphRAGAdapter from src/index.ts', () => {
    expect(ExportedCortexGraphRAGAdapter).toBe(CortexGraphRAGAdapter)
  })
})

function createFakeCortexClient(): FakeCortexClient {
  return {
    wakeUp: vi.fn<(wingId: string) => CortexWakeUpResult>((_wingId: string): CortexWakeUpResult =>
      createWakeUpResult()
    ),
    recallLocal: vi.fn<(wingId: string, roomId?: string, hallId?: string) => CortexDrawer[]>(
      (_wingId: string, _roomId?: string, _hallId?: string): CortexDrawer[] => [
        createDrawer('local-1'),
      ]
    ),
    search: vi.fn<(wingId: string, query: string, limit: number) => Promise<CortexSearchResult[]>>(
      async (_wingId: string, _query: string, _limit: number): Promise<CortexSearchResult[]> => [
        createSearchResult(),
      ]
    ),
  }
}

function createIdentity(): CortexIdentity {
  return {
    wingId: WING_ID,
    persona: 'GitOrch Graph RAG Cortex',
    orchestrationGuidelines: 'Use L0-L3 memory for plan context.',
  }
}

function createDrawer(id: string): CortexDrawer {
  return {
    id,
    wingId: WING_ID,
    roomId: ROOM_ID,
    hallId: HALL_ID,
    content: `local memory ${id}`,
    importance: 0.8,
    emotionalWeight: 0.4,
    createdAt: '2026-06-19T00:00:00.000Z',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.9,
    tags: ['graph-rag'],
  }
}

function createWakeUpResult(): CortexWakeUpResult {
  return {
    identity: createIdentity(),
    drawers: [createDrawer('wake-1')],
    tokenBudget: 190,
  }
}

function createSearchResult(): CortexSearchResult {
  return {
    drawerId: 'semantic-1',
    layer: 'L3',
    score: 0.92,
    content: 'semantic anchor for Graph RAG planning',
    metadata: createDrawer('semantic-1'),
  }
}
