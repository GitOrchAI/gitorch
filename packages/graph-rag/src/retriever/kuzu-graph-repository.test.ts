import type { KuzuClient } from '@gitorch/cgc'
import { describe, expect, test } from 'vitest'
import type { GraphEdge, GraphNode } from '../types'
import { InMemoryGraphRepository, KuzuGraphRepository } from './kuzu-graph-repository'

const repoNode: GraphNode = {
  id: 'repo',
  label: 'REPO',
  type: 'repo',
  name: 'repo',
}

const srcDirNode: GraphNode = {
  id: 'src-dir',
  label: 'Directory',
  type: 'directory',
  name: 'src',
  filePath: 'src',
}

const utilsFileNode: GraphNode = {
  id: 'utils-file',
  label: 'File',
  type: 'file',
  name: 'index.ts',
  filePath: 'src/utils/index.ts',
}

const mainFileNode: GraphNode = {
  id: 'main-file',
  label: 'File',
  type: 'file',
  name: 'main.ts',
  filePath: 'src/main.ts',
}

const alphaNode: GraphNode = {
  id: 'alpha',
  label: 'Symbol',
  type: 'function',
  name: 'alpha',
}

const betaNode: GraphNode = {
  id: 'beta',
  label: 'Symbol',
  type: 'function',
  name: 'beta',
}

const gammaNode: GraphNode = {
  id: 'gamma',
  label: 'Symbol',
  type: 'function',
  name: 'gamma',
}

const importedNode: GraphNode = {
  id: 'imported',
  label: 'Symbol',
  type: 'function',
  name: 'imported',
}

const extendedNode: GraphNode = {
  id: 'extended',
  label: 'Symbol',
  type: 'class',
  name: 'Extended',
}

const graphEdges: GraphEdge[] = [
  { source: 'repo', target: 'src-dir', type: 'CONTAINS' },
  { source: 'src-dir', target: 'utils-file', type: 'CONTAINS' },
  { source: 'src-dir', target: 'main-file', type: 'CONTAINS' },
  { source: 'utils-file', target: 'alpha', type: 'CONTAINS' },
  { source: 'utils-file', target: 'gamma', type: 'CONTAINS' },
  { source: 'alpha', target: 'beta', type: 'CALLS' },
  { source: 'alpha', target: 'imported', type: 'IMPORTS' },
  { source: 'alpha', target: 'extended', type: 'EXTENDS' },
]

const graphNodes = [
  repoNode,
  srcDirNode,
  utilsFileNode,
  mainFileNode,
  alphaNode,
  betaNode,
  gammaNode,
  importedNode,
  extendedNode,
]

function createMemoryRepository(): InMemoryGraphRepository {
  return new InMemoryGraphRepository({ nodes: graphNodes, edges: graphEdges })
}

describe('InMemoryGraphRepository', () => {
  test('supports empty repository construction for runtime smoke tests', async () => {
    const repository = new InMemoryGraphRepository()

    await expect(repository.findNodesByNames(['alpha'])).resolves.toEqual([])
  })

  test('supports array constructor overload', async () => {
    const repository = new InMemoryGraphRepository(
      [repoNode, srcDirNode],
      [{ source: 'repo', target: 'src-dir', type: 'CONTAINS' }]
    )

    await expect(repository.findAncestorsToRoot('src-dir')).resolves.toEqual([repoNode])
  })

  test('finds 1-hop CALLS neighbors', async () => {
    const repository = createMemoryRepository()

    await expect(repository.findCallNeighbors('alpha')).resolves.toEqual([betaNode])
  })

  test('finds CONTAINS ancestors to root', async () => {
    const repository = createMemoryRepository()

    await expect(repository.findAncestorsToRoot('alpha')).resolves.toEqual([
      utilsFileNode,
      srcDirNode,
      repoNode,
    ])
  })

  test('finds files by path fragments', async () => {
    const repository = createMemoryRepository()

    await expect(repository.findFilesByPath(['src', 'utils'])).resolves.toEqual([utilsFileNode])
  })

  test('throws for unknown node IDs', async () => {
    const repository = createMemoryRepository()

    await expect(repository.findNodeById('missing')).rejects.toThrow('Unknown graph node: missing')
    await expect(repository.findCallNeighbors('missing')).rejects.toThrow(
      'Unknown graph node: missing'
    )
  })

  test('finds import and extend neighbors by exact outgoing edge type', async () => {
    const repository = createMemoryRepository()

    await expect(repository.findImportNeighbors('alpha')).resolves.toEqual([importedNode])
    await expect(repository.findExtendNeighbors('alpha')).resolves.toEqual([extendedNode])
  })
})

describe('KuzuGraphRepository', () => {
  test('maps fake Kuzu CALLS rows to graph nodes', async () => {
    const fakeClient = new FakeKuzuClient()
    const repository = new KuzuGraphRepository(fakeClient as unknown as KuzuClient)

    await expect(repository.findCallNeighbors('alpha')).resolves.toEqual([betaNode])

    expect(fakeClient.queries).toEqual([
      expect.stringContaining('MATCH (n) WHERE n.id = $id'),
      expect.stringContaining('-[r:CALLS]->(target)'),
    ])
    expect(fakeClient.queries[1]).toContain('ORDER BY target.id ASC')
  })

  test('maps fake Kuzu import and extend neighbors', async () => {
    const fakeClient = new FakeKuzuClient()
    const repository = new KuzuGraphRepository(fakeClient as unknown as KuzuClient)

    await expect(repository.findImportNeighbors('alpha')).resolves.toEqual([importedNode])
    await expect(repository.findExtendNeighbors('alpha')).resolves.toEqual([extendedNode])

    expect(fakeClient.queries).toEqual([
      expect.stringContaining('MATCH (n) WHERE n.id = $id'),
      expect.stringContaining('-[r:IMPORTS]->(target)'),
      expect.stringContaining('MATCH (n) WHERE n.id = $id'),
      expect.stringContaining('-[r:EXTENDS]->(target)'),
    ])
    expect(fakeClient.queries[1]).toContain('ORDER BY target.id ASC')
    expect(fakeClient.queries[3]).toContain('ORDER BY target.id ASC')
  })

  test('maps fake Kuzu ancestor rows to graph nodes', async () => {
    const fakeClient = new FakeKuzuClient()
    const repository = new KuzuGraphRepository(fakeClient as unknown as KuzuClient)

    await expect(repository.findAncestorsToRoot('alpha')).resolves.toEqual([
      utilsFileNode,
      srcDirNode,
      repoNode,
    ])
  })

  test('maps fake Kuzu name and file path searches', async () => {
    const fakeClient = new FakeKuzuClient()
    const repository = new KuzuGraphRepository(fakeClient as unknown as KuzuClient)

    await expect(repository.findNodesByNames(['beta'])).resolves.toEqual([betaNode])
    await expect(repository.findFilesByPath(['src', 'utils'])).resolves.toEqual([utilsFileNode])
  })

  test('throws for unknown Kuzu node IDs', async () => {
    const fakeClient = new FakeKuzuClient()
    const repository = new KuzuGraphRepository(fakeClient as unknown as KuzuClient)

    await expect(repository.findNodeById('missing')).rejects.toThrow('Unknown graph node: missing')
  })
})

class FakeKuzuClient {
  readonly queries: string[] = []
  private requestedId: string | undefined

  async query(
    query: string,
    options?: { parameters?: Record<string, unknown> }
  ): Promise<Record<string, unknown>[]> {
    this.queries.push(query)
    this.requestedId = options?.parameters?.id as string | undefined

    if (query.includes('MATCH (n) WHERE n.id = $id') && query.includes('RETURN n.id AS id')) {
      if (this.requestedId === 'missing') return []
      return [nodeRow(alphaNode)]
    }

    if (query.includes('-[r:CALLS]->(target)')) {
      return [edgeRow('alpha', 'beta', 'CALLS', betaNode)]
    }

    if (query.includes('-[r:IMPORTS]->(target)')) {
      return [edgeRow('alpha', 'imported', 'IMPORTS', importedNode)]
    }

    if (query.includes('-[r:EXTENDS]->(target)')) {
      return [edgeRow('alpha', 'extended', 'EXTENDS', extendedNode)]
    }

    if (query.includes('MATCH (n) WHERE n.name IN $names')) {
      return [nodeRow(betaNode)]
    }

    if (query.includes('MATCH (n) WHERE n.filePath IS NOT NULL')) {
      return [nodeRow(utilsFileNode), nodeRow(mainFileNode)]
    }

    if (query.includes('MATCH (parent)-[:CONTAINS]->(child {id: $id})')) {
      if (this.queries.length === 2) return [nodeRow(utilsFileNode)]
      if (this.queries.length === 3) return [nodeRow(srcDirNode)]
      if (this.queries.length === 4) return [nodeRow(repoNode)]
    }

    return []
  }
}

function nodeRow(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    labelList: [node.label],
    label: node.label,
    type: node.type,
    filePath: node.filePath,
    name: node.name,
    signature: node.signature,
    docComment: node.docComment,
    properties: node.properties,
  }
}

function edgeRow(
  source: string,
  target: string,
  type: string,
  targetNode: GraphNode
): Record<string, unknown> {
  return {
    ...nodeRow(targetNode),
    sourceId: source,
    targetId: target,
    edgeType: type,
  }
}
