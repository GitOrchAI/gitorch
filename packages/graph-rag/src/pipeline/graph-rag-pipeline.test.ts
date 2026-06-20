import type {
  CortexDrawer,
  CortexIdentity,
  CortexSearchResult,
  CortexWakeUpResult,
} from '@gitorch/cortex'
import { type Mock, describe, expect, test, vi } from 'vitest'
import { CortexGraphRAGAdapter } from '../cortex/cortex-integration'
import { DynamicBudgetReranker } from '../reranker/reranker'
import { GraphRAGPipeline } from '../index'
import type { GraphEdge, GraphNode } from '../types'
import { InMemoryGraphRepository } from '../retriever/kuzu-graph-repository'

const RAW_ISSUE = 'Fix CompoundModels nested separability_matrix in src/modeling/separable.py'
const WING_ID = 'wing-graph-rag'
const ROOM_ID = 'room-planning'
const HALL_ID = 'hall-context'

type FakeCortexClient = {
  wakeUp: Mock<(wingId: string) => CortexWakeUpResult>
  recallLocal: Mock<(wingId: string, roomId?: string, hallId?: string) => CortexDrawer[]>
  search: Mock<(wingId: string, query: string, limit: number) => Promise<CortexSearchResult[]>>
}

describe('GraphRAGPipeline', () => {
  test('processes raw issue into a reader payload with ranked files', async () => {
    const pipeline = new GraphRAGPipeline({
      repository: new InMemoryGraphRepository({
        nodes: createFixtureNodes(),
        edges: createFixtureEdges(),
      }),
      reranker: new DynamicBudgetReranker({ totalWindowTokens: 2000 }),
    })

    const result = await pipeline.run(RAW_ISSUE)

    expect(result.plan.rawIssue).toBe(RAW_ISSUE)
    expect(result.plan.extractor.entities).toEqual(
      expect.arrayContaining(['CompoundModels', 'src/modeling/separable.py'])
    )
    expect(result.payload.graphSummary).toContain('- nodes:')
    expect(result.payload.patchFormatInstructions).toContain(
      'Generate a Git-compatible diff/patch.'
    )
    expect(result.payload.rankedFiles.length).toBeGreaterThan(0)
  })

  test('returns plan, payload, and optional Cortex context when wingId and adapter are provided', async () => {
    const fakeCortex = createFakeCortexClient()
    const pipeline = new GraphRAGPipeline({
      repository: new InMemoryGraphRepository({
        nodes: createFixtureNodes(),
        edges: createFixtureEdges(),
      }),
      reranker: new DynamicBudgetReranker({ totalWindowTokens: 2000 }),
      cortex: new CortexGraphRAGAdapter(fakeCortex),
    })

    const result = await pipeline.run(RAW_ISSUE, {
      wingId: WING_ID,
      roomId: ROOM_ID,
      hallId: HALL_ID,
    })

    expect(result.plan.wingId).toBe(WING_ID)
    expect(result.plan.roomId).toBe(ROOM_ID)
    expect(result.plan.hallId).toBe(HALL_ID)
    expect(result.context).toEqual({
      wingId: WING_ID,
      identity: createIdentity(),
      wakeUp: createWakeUpResult(),
      localScope: [createDrawer('local-1')],
      semanticAnchors: [createSearchResult()],
    })
    expect(fakeCortex.wakeUp).toHaveBeenCalledWith(WING_ID)
    expect(fakeCortex.recallLocal).toHaveBeenCalledWith(WING_ID, ROOM_ID, HALL_ID)
    expect(fakeCortex.search).toHaveBeenCalledWith(WING_ID, RAW_ISSUE, 10)
  })

  test('exports GraphRAGPipeline from src/index.ts', () => {
    expect(GraphRAGPipeline).toBeDefined()
  })
})

function createFixtureNodes(): GraphNode[] {
  return [
    graphNode('repo', 'REPO', 'repo'),
    graphNode('src-dir', 'Directory', 'directory', 'src', 'src'),
    graphNode('modeling-dir', 'Directory', 'directory', 'src/modeling', 'modeling'),
    graphNode('separable-file', 'File', 'file', 'src/modeling/separable.py', 'separable.py'),
    graphNode(
      'compound-class',
      'Symbol',
      'class',
      'src/modeling/separable.py',
      'CompoundModels',
      'class CompoundModels',
      'Nested compound model container'
    ),
    graphNode(
      'separability-function',
      'Symbol',
      'function',
      'src/modeling/separable.py',
      'separability_matrix',
      'separability_matrix(model)',
      'Compute separability for nested models'
    ),
    graphNode(
      'recursive-traversal',
      'Symbol',
      'function',
      'src/modeling/separable.py',
      'recursiveTraversal',
      'recursiveTraversal(node)',
      'Preserve recursive traversal integrity.'
    ),
    graphNode(
      'leaf-atomic',
      'Symbol',
      'function',
      'src/modeling/separable.py',
      'leafAtomic',
      'leafAtomic(node)',
      'Leaf nodes must be atomic.'
    ),
  ]
}

function createFixtureEdges(): GraphEdge[] {
  return [
    { source: 'repo', target: 'src-dir', type: 'CONTAINS' },
    { source: 'src-dir', target: 'modeling-dir', type: 'CONTAINS' },
    { source: 'modeling-dir', target: 'separable-file', type: 'CONTAINS' },
    { source: 'separable-file', target: 'compound-class', type: 'CONTAINS' },
    { source: 'separable-file', target: 'separability-function', type: 'CONTAINS' },
    { source: 'separable-file', target: 'recursive-traversal', type: 'CONTAINS' },
    { source: 'separable-file', target: 'leaf-atomic', type: 'CONTAINS' },
    { source: 'compound-class', target: 'separability-function', type: 'CALLS' },
    { source: 'separability-function', target: 'recursive-traversal', type: 'CALLS' },
  ]
}

function graphNode(
  id: string,
  label: string,
  type: string,
  filePath?: string,
  name?: string,
  signature?: string,
  docComment?: string
): GraphNode {
  return { id, label, type, filePath, name, signature, docComment }
}

function createFakeCortexClient(): FakeCortexClient {
  return {
    wakeUp: vi.fn<(wingId: string) => CortexWakeUpResult>(
      (_wingId: string): CortexWakeUpResult => createWakeUpResult()
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
    persona: 'GitOrch Graph RAG Pipeline Test',
    orchestrationGuidelines: 'Build plan context for the end-to-end pipeline.',
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
