import { describe, expect, test } from 'vitest'
import type { ExpandedSubgraph, GraphNode, GraphRAGPlan } from '../types'
import { DynamicBudgetReranker, FileNameRanker, SkeletonRanker } from './reranker'

type RankedFileWithScores = ReturnType<DynamicBudgetReranker['rerank']>[number] & {
  fileNameScore: number
  skeletonScore: number
}

const rerankerPlan: GraphRAGPlan = {
  rawIssue: 'Implement DynamicBudgetReranker with file-name and skeleton relevance.',
  extractor: {
    entities: ['src/reranker/reranker.ts', 'DynamicBudgetReranker'],
    keywords: ['budget', 'context'],
  },
  inferer: {
    functionalReq: 'Rank relevant files within a dynamic context budget.',
    behavioralExpectation: 'Keep high-signal files before lower-signal files.',
  },
}

describe('FileNameRanker', () => {
  test('scores exact file paths and keyword path segments', () => {
    const ranker = new FileNameRanker()

    expect(
      ranker.scoreWithReasons(graphNode('reranker-file', 'src/reranker/reranker.ts'), rerankerPlan)
        .score
    ).toBe(1)
    expect(
      ranker.scoreWithReasons(graphNode('budget-file', 'src/reranker/budget.ts'), rerankerPlan)
        .score
    ).toBeGreaterThan(0.75)
    expect(
      ranker.scoreWithReasons(graphNode('legacy-file', 'src/utils/legacy.ts'), rerankerPlan).score
    ).toBe(0)
  })
})

describe('SkeletonRanker', () => {
  test('scores signatures, names, and doc comments against plan terms', () => {
    const ranker = new SkeletonRanker()

    expect(
      ranker.scoreWithReasons(
        graphNode(
          'dynamic-budget-reranker',
          'src/reranker/reranker.ts',
          'DynamicBudgetReranker',
          'class DynamicBudgetReranker',
          'Dynamic context budget reranker'
        ),
        rerankerPlan
      ).score
    ).toBeGreaterThan(0.75)
    expect(
      ranker.scoreWithReasons(
        graphNode(
          'apply-budget',
          'src/reranker/budget.ts',
          'applyBudget',
          'applyBudget(files, contextBudgetTokens)',
          'Apply dynamic budget cutoff'
        ),
        rerankerPlan
      ).score
    ).toBeGreaterThan(0.75)
    expect(
      ranker.scoreWithReasons(
        graphNode(
          'legacy',
          'src/utils/legacy.ts',
          'legacy',
          'function legacy()',
          'Unrelated legacy helper'
        ),
        rerankerPlan
      ).score
    ).toBe(0)
  })
})

describe('DynamicBudgetReranker', () => {
  test('ranks file nodes, applies threshold and dynamic context budget, and collapses duplicate paths', () => {
    const reranker = new DynamicBudgetReranker({ totalWindowTokens: 2500 })
    const ranked = reranker.rerank(createFixtureSubgraph(), rerankerPlan) as RankedFileWithScores[]

    expect(ranked.map((file) => file.filePath)).toEqual([
      'src/reranker/reranker.ts',
      'src/reranker/budget.ts',
    ])
    expect(ranked.filter((file) => file.filePath === 'src/reranker/reranker.ts')).toHaveLength(1)
    expect(ranked.every((file) => file.score > 0.75)).toBe(true)
    expect(ranked.reduce((total, file) => total + file.tokenCount, 0)).toBeLessThanOrEqual(1750)
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0)

    const first = ranked[0]
    expect(first).toEqual(
      expect.objectContaining({
        filePath: 'src/reranker/reranker.ts',
        score: 1,
        fileNameScore: 1,
        skeletonScore: expect.any(Number),
        tokenCount: 1200,
        reasons: expect.arrayContaining(['fileName exact path matches "src/reranker/reranker.ts"']),
      })
    )
  })

  test('uses a 70 percent default context budget from 128000 tokens', () => {
    const reranker = new DynamicBudgetReranker()
    const ranked = reranker.rerank(createFixtureSubgraph(), rerankerPlan) as RankedFileWithScores[]

    expect(reranker.contextBudgetTokens).toBe(89600)
    expect(ranked.reduce((total, file) => total + file.tokenCount, 0)).toBeLessThanOrEqual(89600)
  })

  test('ignores non-file nodes that have file paths', () => {
    const reranker = new DynamicBudgetReranker({ totalWindowTokens: 1000 })
    const ranked = reranker.rerank(
      {
        anchors: [],
        nodes: [
          {
            id: 'directory',
            label: 'Directory',
            type: 'directory',
            filePath: 'src/reranker',
            name: 'reranker',
            properties: {
              tokenCount: 500,
            },
          },
          graphNode(
            'function',
            'src/reranker/reranker.ts',
            'DynamicBudgetReranker',
            undefined,
            undefined,
            100
          ),
        ],
        edges: [],
        isolatedNodes: [],
      },
      rerankerPlan
    )

    const rankedFiles = ranked as RankedFileWithScores[]

    expect(rankedFiles.map((file) => file.filePath)).toEqual(['src/reranker/reranker.ts'])
  })

  test('removes exact threshold boundary and orders ties by path', () => {
    const reranker = new DynamicBudgetReranker({ totalWindowTokens: 1000 })
    const ranked = reranker.rerank(
      {
        anchors: [],
        nodes: [
          graphNode(
            'exact-threshold',
            'src/exact.ts',
            'Exact',
            'exact()',
            'Exact boundary match',
            100
          ),
          graphNode('tie-b', 'src/b.ts', 'Tie', 'tie()', 'Tie boundary match', 100),
          graphNode('tie-a', 'src/a.ts', 'Tie', 'tie()', 'Tie boundary match', 100),
        ],
        edges: [],
        isolatedNodes: [],
      },
      {
        rawIssue: 'Boundary and tie ordering',
        extractor: {
          entities: ['src/a.ts', 'src/b.ts'],
          keywords: [],
        },
        inferer: {
          functionalReq: 'Tie boundary match',
          behavioralExpectation: '',
        },
      }
    )

    const rankedFiles = ranked as RankedFileWithScores[]

    expect(rankedFiles.map((file) => file.filePath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(rankedFiles.every((file) => file.score > 0.75)).toBe(true)
  })

  test('skips a high-score file that cannot fit remaining budget', () => {
    const reranker = new DynamicBudgetReranker({ totalWindowTokens: 1000 })
    const ranked = reranker.rerank(
      {
        anchors: [],
        nodes: [
          graphNode('large', 'src/large.ts', 'Large', 'large()', 'Large relevant file', 900),
          graphNode('small', 'src/small.ts', 'Small', 'small()', 'Small relevant file', 100),
        ],
        edges: [],
        isolatedNodes: [],
      },
      {
        rawIssue: 'Budget skip',
        extractor: {
          entities: ['src/large.ts', 'src/small.ts'],
          keywords: [],
        },
        inferer: {
          functionalReq: 'Relevant file',
          behavioralExpectation: '',
        },
      }
    )

    const rankedFiles = ranked as RankedFileWithScores[]

    expect(rankedFiles.map((file) => file.filePath)).toEqual(['src/small.ts'])
  })
})

function createFixtureSubgraph(): ExpandedSubgraph {
  return {
    anchors: [],
    nodes: [
      graphNode(
        'reranker-file',
        'src/reranker/reranker.ts',
        'DynamicBudgetReranker',
        'class DynamicBudgetReranker',
        'Dynamic context budget reranker',
        1200
      ),
      graphNode(
        'budget-file',
        'src/reranker/budget.ts',
        'applyBudget',
        'applyBudget(files, contextBudgetTokens)',
        'Apply dynamic budget cutoff',
        500
      ),
      graphNode(
        'separable-file',
        'src/modeling/separable.py',
        'separabilityMatrix',
        'separability_matrix(model)',
        'Compute separability for nested models',
        1000
      ),
      graphNode(
        'retriever-file',
        'src/retriever/retriever.ts',
        'GraphRetriever',
        'class GraphRetriever',
        'Retrieve graph nodes',
        100
      ),
      graphNode(
        'legacy-file',
        'src/utils/legacy.ts',
        'legacy',
        'function legacy()',
        'Unrelated legacy helper',
        100
      ),
      graphNode(
        'duplicate-reranker-file',
        'src/reranker/reranker.ts',
        'FileNameRanker',
        'class FileNameRanker',
        'Score file names',
        900
      ),
    ],
    edges: [],
    isolatedNodes: [],
  }
}

function graphNode(
  id: string,
  filePath: string,
  name?: string,
  signature?: string,
  docComment?: string,
  tokenCount?: number
): GraphNode {
  return {
    id,
    label: 'File',
    type: 'file',
    filePath,
    name,
    signature,
    docComment,
    properties:
      typeof tokenCount === 'number'
        ? {
            tokenCount,
          }
        : undefined,
  }
}
