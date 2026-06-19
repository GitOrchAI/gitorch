import { describe, expect, test } from 'vitest'
import { DeterministicNodeTokenAdapter, GraphReader, PatchPromptBuilder } from '../index'
import type { Anchor, ExpandedSubgraph, GraphEdge, GraphNode, RankedFile } from '../types'
import { GraphReader as LocalGraphReader } from './reader'

describe('DeterministicNodeTokenAdapter', () => {
  test('compresses the same chunk to the same node token', () => {
    const adapter = new DeterministicNodeTokenAdapter()

    expect(adapter.compressChunkToNodeToken('class Reader {}')).toBe(
      adapter.compressChunkToNodeToken('class Reader {}')
    )
  })

  test('uses different deterministic tokens for different chunks', () => {
    const adapter = new DeterministicNodeTokenAdapter()

    expect(adapter.compressChunkToNodeToken('skeleton-a')).not.toBe(
      adapter.compressChunkToNodeToken('skeleton-b')
    )
  })
})

describe('PatchPromptBuilder', () => {
  test('builds patch instructions with ranked file path and score', () => {
    const builder = new PatchPromptBuilder()
    const subgraph = createSubgraph({ nodeCount: 1, edgeCount: 1, anchorCount: 1 })
    const rankedFiles = createRankedFiles()

    const instructions = builder.build(subgraph, rankedFiles)

    expect(instructions).toContain('Generate a Git-compatible diff/patch.')
    expect(instructions).toContain('Keep changes scoped to ranked files.')
    expect(instructions).toContain(
      'Add or update regression tests when the issue implies behavior.'
    )
    expect(instructions).toContain(
      'Do not include explanatory prose outside the patch unless requested.'
    )
    expect(instructions).toContain('src/reader/reader.ts')
    expect(instructions).toContain('score: 0.95')
    expect(instructions).toContain('- nodes: 1')
    expect(instructions).toContain('- edges: 1')
    expect(instructions).toContain('- anchors: 1')
  })
})

describe('GraphReader', () => {
  test('rejects an isolated-only subgraph', () => {
    const reader = new GraphReader()
    const subgraph: ExpandedSubgraph = {
      anchors: [],
      nodes: [],
      edges: [],
      isolatedNodes: [graphNode('orphan', 'src/orphan.ts')],
    }

    expect(() => reader.read(subgraph, [])).toThrow(
      'Cannot read isolated subgraph with no connected nodes.'
    )
  })

  test('returns a payload for a connected empty subgraph', () => {
    const reader = new GraphReader()
    const subgraph = createSubgraph()
    const rankedFiles: RankedFile[] = []

    const payload = reader.read(subgraph, rankedFiles)

    expect(payload).toEqual({
      graphSummary: expect.stringContaining('- nodes: 0'),
      rankedFiles: [],
      nodeTokens: [],
      patchFormatInstructions: expect.stringContaining('Generate a Git-compatible diff/patch.'),
    })
    expect(payload.graphSummary).toContain('- edges: 0')
    expect(payload.graphSummary).toContain('- anchors: 0')
  })

  test('compresses ranked file skeletons into deterministic node tokens', () => {
    const adapter = new DeterministicNodeTokenAdapter()
    const reader = new GraphReader(adapter)
    const rankedFiles = createRankedFiles()
    const subgraph = createSubgraph()

    const payload = reader.read(subgraph, rankedFiles)
    const repeatedPayload = reader.read(subgraph, rankedFiles)

    expect(payload.nodeTokens).toEqual(repeatedPayload.nodeTokens)
    expect(payload.nodeTokens).toEqual([
      adapter.compressChunkToNodeToken('export function reader() {}'),
      adapter.compressChunkToNodeToken('src/patch-builder.ts'),
    ])
    expect(payload.nodeTokens[0]).not.toBe(payload.nodeTokens[1])
  })

  test('falls back to file path when skeleton is unavailable', () => {
    const adapter = new DeterministicNodeTokenAdapter()
    const reader = new GraphReader(adapter)
    const rankedFiles: RankedFile[] = [
      {
        filePath: 'src/no-skeleton.ts',
        score: 0.8,
        fileNameScore: 0.8,
        skeletonScore: 0.7,
        reasons: ['path fallback'],
        tokenCount: 1,
      },
    ]

    const payload = reader.read(createSubgraph(), rankedFiles)

    expect(payload.nodeTokens).toEqual([adapter.compressChunkToNodeToken('src/no-skeleton.ts')])
  })

  test('returns ranked files unchanged', () => {
    const reader = new LocalGraphReader()
    const rankedFiles = createRankedFiles()

    const payload = reader.read(createSubgraph(), rankedFiles)

    expect(payload.rankedFiles).toBe(rankedFiles)
    expect(payload.rankedFiles[0]).toBe(rankedFiles[0])
  })
})

test('exports reader payload builder classes from src/index.ts', () => {
  expect(new DeterministicNodeTokenAdapter()).toBeInstanceOf(DeterministicNodeTokenAdapter)
  expect(new PatchPromptBuilder()).toBeInstanceOf(PatchPromptBuilder)
  expect(new GraphReader()).toBeInstanceOf(GraphReader)
})

function createSubgraph(
  options: { nodeCount?: number; edgeCount?: number; anchorCount?: number } = {}
): ExpandedSubgraph {
  const nodeCount = options.nodeCount ?? 0
  const edgeCount = options.edgeCount ?? 0
  const anchorCount = options.anchorCount ?? 0

  return {
    anchors: Array.from(
      { length: anchorCount },
      (_value, index): Anchor => ({
        id: `anchor-${index}`,
        kind: 'blue',
        score: 1,
        reason: 'test anchor',
      })
    ),
    nodes: Array.from(
      { length: nodeCount },
      (_value, index): GraphNode => graphNode(`node-${index}`)
    ),
    edges: Array.from(
      { length: edgeCount },
      (_value, index): GraphEdge => ({
        source: `node-${index}`,
        target: `node-${index + 1}`,
        type: 'CALLS',
      })
    ),
    isolatedNodes: [],
  }
}

function createRankedFiles(): RankedFile[] {
  return [
    {
      filePath: 'src/reader/reader.ts',
      score: 0.95,
      fileNameScore: 0.9,
      skeletonScore: 0.95,
      reasons: ['reader payload builder'],
      tokenCount: 42,
      skeleton: 'export function reader() {}',
    },
    {
      filePath: 'src/patch-builder.ts',
      score: 0.8,
      fileNameScore: 0.7,
      skeletonScore: 0.8,
      reasons: ['patch prompt builder'],
      tokenCount: 20,
    },
  ]
}

function graphNode(id: string, filePath = 'src/reader/reader.ts'): GraphNode {
  return {
    id,
    label: 'File',
    type: 'file',
    filePath,
    name: id,
  }
}
