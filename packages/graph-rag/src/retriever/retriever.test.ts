import { describe, expect, test } from 'vitest'
import type { GraphEdge, GraphNode, GraphRAGPlan } from '../types'
import { InMemoryGraphRepository } from './kuzu-graph-repository'
import { GraphRetriever } from './retriever'

const retrieverPlan: GraphRAGPlan = {
  rawIssue: 'CompoundModels nested separability_matrix fails',
  extractor: {
    entities: ['CompoundModels', 'separable.py'],
    keywords: ['separability_matrix', 'nested'],
  },
  inferer: {
    functionalReq: 'Preserve recursive traversal integrity.',
    behavioralExpectation: 'Leaf nodes must be atomic.',
  },
}

describe('GraphRetriever', () => {
  test('resolves blue and red anchors then expands a rooted subgraph', async () => {
    const repository = new InMemoryGraphRepository({
      nodes: createFixtureNodes(),
      edges: createFixtureEdges(),
    })
    const retriever = new GraphRetriever(repository)

    const subgraph = await retriever.retrieve(retrieverPlan)
    const anchorIds = new Set(subgraph.anchors.map((anchor) => anchor.id))
    const nodeIds = new Set(subgraph.nodes.map((node) => node.id))

    expect(anchorIds).toContain('compound-class')
    expect(anchorIds).toContain('separable-file')
    expect(subgraph.anchors.some((anchor) => anchor.kind === 'red')).toBe(true)
    expect(
      subgraph.anchors.some(
        (anchor) => anchor.kind === 'red' && /recursive|leaf|atomic/.test(anchor.reason)
      )
    ).toBe(true)
    expect(subgraph.edges.some((edge) => edge.type === 'CALLS')).toBe(true)
    expect(nodeIds).toContain('repo')
  })

  test('isolates horizontal neighbors that cannot reach REPO', async () => {
    const repository = new InMemoryGraphRepository({
      nodes: [
        graphNode('repo', 'REPO', 'repo'),
        graphNode('src-dir', 'Directory', 'directory', 'src', 'src'),
        graphNode('reachable-file', 'File', 'file', 'src/reachable.ts', 'reachable.ts'),
        graphNode(
          'reachable-function',
          'Symbol',
          'function',
          'src/reachable.ts',
          'reachableFunction'
        ),
        graphNode('orphan-function', 'Symbol', 'function', 'orphan.ts', 'orphanFunction'),
      ],
      edges: [
        { source: 'repo', target: 'src-dir', type: 'CONTAINS' },
        { source: 'src-dir', target: 'reachable-file', type: 'CONTAINS' },
        { source: 'reachable-file', target: 'reachable-function', type: 'CONTAINS' },
        { source: 'reachable-function', target: 'orphan-function', type: 'CALLS' },
      ],
    })
    const retriever = new GraphRetriever(repository)

    const subgraph = await retriever.retrieve({
      rawIssue: 'Reachable function calls orphan',
      extractor: {
        entities: ['reachableFunction'],
        keywords: [],
      },
      inferer: {
        functionalReq: 'Keep reachable functions rooted.',
        behavioralExpectation: 'Do not include orphan nodes.',
      },
    })

    expect(subgraph.isolatedNodes.map((node) => node.id)).toContain('orphan-function')
    expect(subgraph.nodes.map((node) => node.id)).not.toContain('orphan-function')
    expect(subgraph.edges.some((edge) => edge.target === 'orphan-function')).toBe(false)
  })

  test('deduplicates anchors, nodes, and edges', async () => {
    const repository = new InMemoryGraphRepository({
      nodes: [
        graphNode('repo', 'REPO', 'repo'),
        graphNode('file-dir', 'Directory', 'directory', 'src', 'src'),
        graphNode('node-file', 'File', 'file', 'src/node.ts', 'node.ts'),
        graphNode('target-file', 'File', 'file', 'src/node.ts', 'target.ts'),
        graphNode('duplicate-node', 'Symbol', 'function', 'src/node.ts', 'Node'),
        graphNode('duplicate-child', 'Symbol', 'function', 'src/node.ts', 'Child'),
      ],
      edges: [
        { source: 'repo', target: 'file-dir', type: 'CONTAINS' },
        { source: 'file-dir', target: 'node-file', type: 'CONTAINS' },
        { source: 'node-file', target: 'duplicate-node', type: 'CONTAINS' },
        { source: 'node-file', target: 'duplicate-child', type: 'CONTAINS' },
        { source: 'duplicate-node', target: 'duplicate-child', type: 'CALLS' },
        { source: 'duplicate-node', target: 'duplicate-child', type: 'CALLS' },
      ],
    })
    const retriever = new GraphRetriever(repository)

    const subgraph = await retriever.retrieve({
      rawIssue: 'Duplicate Node anchors and duplicate edges',
      extractor: {
        entities: ['Node', 'Node'],
        keywords: ['node'],
      },
      inferer: {
        functionalReq: 'Return deterministic unique anchors.',
        behavioralExpectation: 'Deduplicate repeated graph edges.',
      },
    })

    expect(subgraph.anchors.filter((anchor) => anchor.id === 'duplicate-node')).toHaveLength(1)
    expect(new Set(subgraph.nodes.map((node) => node.id)).size).toBe(subgraph.nodes.length)
    expect(new Set(subgraph.edges.map(edgeKey)).size).toBe(subgraph.edges.length)
    expect(subgraph.edges.filter((edge) => edge.type === 'CALLS')).toHaveLength(1)
  })
})

function createFixtureNodes(): GraphNode[] {
  return [
    graphNode('repo', 'REPO', 'repo'),
    graphNode('src-dir', 'Directory', 'directory', 'src', 'src'),
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
    graphNode(
      'called-function',
      'Symbol',
      'function',
      'src/modeling/separable.py',
      'calledFunction',
      'calledFunction(node)'
    ),
    graphNode(
      'imported-function',
      'Symbol',
      'function',
      'src/modeling/separable.py',
      'importedFunction',
      'importedFunction(node)'
    ),
    graphNode(
      'extended-class',
      'Symbol',
      'class',
      'src/modeling/separable.py',
      'extendedClass',
      'class extendedClass'
    ),
  ]
}

function createFixtureEdges(): GraphEdge[] {
  return [
    { source: 'repo', target: 'src-dir', type: 'CONTAINS' },
    { source: 'src-dir', target: 'separable-file', type: 'CONTAINS' },
    { source: 'separable-file', target: 'compound-class', type: 'CONTAINS' },
    { source: 'separable-file', target: 'separability-function', type: 'CONTAINS' },
    { source: 'separable-file', target: 'recursive-traversal', type: 'CONTAINS' },
    { source: 'separable-file', target: 'leaf-atomic', type: 'CONTAINS' },
    { source: 'separable-file', target: 'called-function', type: 'CONTAINS' },
    { source: 'separable-file', target: 'imported-function', type: 'CONTAINS' },
    { source: 'separable-file', target: 'extended-class', type: 'CONTAINS' },
    { source: 'compound-class', target: 'separability-function', type: 'CALLS' },
    { source: 'separability-function', target: 'called-function', type: 'CALLS' },
    { source: 'separability-function', target: 'imported-function', type: 'IMPORTS' },
    { source: 'compound-class', target: 'extended-class', type: 'EXTENDS' },
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

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}->${edge.target}:${edge.type}`
}
