import type { Anchor, ExpandedSubgraph, GraphEdge, GraphNode, GraphRAGPlan } from '../types'
import type { GraphRepository } from './kuzu-graph-repository'

const HORIZONTAL_EDGE_TYPES = ['CALLS', 'IMPORTS', 'EXTENDS'] as const
const FILE_PATH_WILDCARD_FRAGMENT = ''
const MAX_RED_ANCHORS = 8

const CAMEL_CASE_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g
const WORD_REGEX = /[A-Za-z0-9_]+/g

const RED_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'must',
  'node',
  'nodes',
  'of',
  'on',
  'or',
  'preserve',
  'should',
  'that',
  'the',
  'this',
  'to',
  'with',
  'would',
])

type HorizontalEdgeType = (typeof HORIZONTAL_EDGE_TYPES)[number]

type OptionalNodeDiscoveryRepository = GraphRepository & {
  findAllNodes?: () => Promise<GraphNode[]> | GraphNode[]
}

type RedMatch = {
  score: number
  reason: string
}

export class GraphRetriever {
  private readonly resolver: AnchorResolver
  private readonly expander: SubgraphExpander

  constructor(repository: GraphRepository)
  constructor(resolver: AnchorResolver, expander: SubgraphExpander)
  constructor(repositoryOrResolver: GraphRepository | AnchorResolver, expander?: SubgraphExpander) {
    if (repositoryOrResolver instanceof AnchorResolver) {
      if (!expander) {
        throw new Error('GraphRetriever requires an expander when using a resolver')
      }
      this.resolver = repositoryOrResolver
      this.expander = expander
      return
    }

    this.resolver = new AnchorResolver(repositoryOrResolver)
    this.expander = new SubgraphExpander(repositoryOrResolver)
  }

  async retrieve(plan: GraphRAGPlan): Promise<ExpandedSubgraph> {
    const anchors = await this.resolver.resolve(plan)
    return this.expander.expand(plan, anchors)
  }
}

export class AnchorResolver {
  constructor(private readonly repository: GraphRepository) {}

  async resolve(plan: GraphRAGPlan): Promise<Anchor[]> {
    const blueAnchors = await this.resolveBlueAnchors(plan)
    const redAnchors = await this.resolveRedAnchors(plan)

    return sortAnchors(deduplicateAnchors([...blueAnchors, ...redAnchors]))
  }

  async resolveBlueAnchors(plan: GraphRAGPlan): Promise<Anchor[]> {
    const anchors = new Map<string, Anchor>()
    const entities = uniqueStrings(plan.extractor.entities)
    const keywords = uniqueStrings(plan.extractor.keywords)

    for (const entity of entities) {
      const nodes = await this.repository.findNodesByNames([entity])
      for (const node of sortNodes(nodes)) {
        addAnchor(anchors, {
          id: node.id,
          kind: 'blue',
          score: 1,
          reason: `blue entity name matches "${entity}"`,
        })
      }
    }

    if (entities.length > 0) {
      const filePathNodes = await this.repository.findFilesByPath(entities)
      for (const node of sortNodes(filePathNodes)) {
        addAnchor(anchors, {
          id: node.id,
          kind: 'blue',
          score: 0.95,
          reason: `blue entity path matches "${entities.join('/')}"`,
        })
      }
    }

    if (keywords.length > 0) {
      const keywordPathNodes = await this.repository.findFilesByPath(keywords)
      for (const node of sortNodes(keywordPathNodes)) {
        addAnchor(anchors, {
          id: node.id,
          kind: 'blue',
          score: 0.85,
          reason: `blue keyword path matches "${keywords.join('/')}"`,
        })
      }
    }

    return sortAnchors(Array.from(anchors.values()))
  }

  async resolveRedAnchors(plan: GraphRAGPlan): Promise<Anchor[]> {
    const terms = uniqueStrings([
      ...tokenize(plan.inferer.functionalReq),
      ...tokenize(plan.inferer.behavioralExpectation),
    ])

    if (terms.length === 0) {
      return []
    }

    const candidateNodes = await this.discoverCandidateNodes(terms)
    const anchors = new Map<string, Anchor>()

    for (const node of candidateNodes) {
      const match = scoreRedNode(node, terms)
      if (!match) {
        continue
      }

      addAnchor(anchors, {
        id: node.id,
        kind: 'red',
        score: match.score,
        reason: match.reason,
      })
    }

    return sortAnchors(Array.from(anchors.values())).slice(0, MAX_RED_ANCHORS)
  }

  private async discoverCandidateNodes(terms: string[]): Promise<GraphNode[]> {
    const candidates = new Map<string, GraphNode>()
    const addCandidates = (nodes: GraphNode[]): void => {
      for (const node of nodes) {
        candidates.set(node.id, node)
      }
    }

    addCandidates(await this.repository.findNodesByNames(terms))
    addCandidates(await this.findFilePathNodes())
    addCandidates(await this.findOptionalAllNodes())

    return sortNodes(Array.from(candidates.values()))
  }

  private async findFilePathNodes(): Promise<GraphNode[]> {
    try {
      return await this.repository.findFilesByPath([FILE_PATH_WILDCARD_FRAGMENT])
    } catch {
      return []
    }
  }

  private async findOptionalAllNodes(): Promise<GraphNode[]> {
    const repository = this.repository as OptionalNodeDiscoveryRepository
    if (typeof repository.findAllNodes !== 'function') {
      return []
    }

    try {
      const nodes = await repository.findAllNodes()
      return sortNodes(nodes)
    } catch {
      return []
    }
  }
}

export class SubgraphExpander {
  constructor(private readonly repository: GraphRepository) {}

  async expand(_plan: GraphRAGPlan, anchors: Anchor[]): Promise<ExpandedSubgraph> {
    const nodes = new Map<string, GraphNode>()
    const edges = new Map<string, GraphEdge>()
    const isolatedNodes = new Map<string, GraphNode>()

    for (const anchor of sortAnchors(deduplicateAnchors(anchors))) {
      const anchorNode = await this.getNodeOrNull(anchor.id)
      if (!anchorNode) {
        continue
      }

      const ancestorNodes = await this.getAncestorsOrNull(anchorNode.id)
      const anchorHasRootPath = hasRootPath(anchorNode, ancestorNodes)
      if (!anchorHasRootPath) {
        isolatedNodes.set(anchorNode.id, anchorNode)
        continue
      }

      nodes.set(anchorNode.id, anchorNode)
      this.addVerticalPath(nodes, edges, anchorNode.id, ancestorNodes)

      for (const edgeType of HORIZONTAL_EDGE_TYPES) {
        const neighbors = await this.findHorizontalNeighbors(anchorNode.id, edgeType)
        for (const neighbor of sortNodes(neighbors)) {
          const neighborAncestors = await this.getAncestorsOrNull(neighbor.id)
          const neighborHasRootPath = hasRootPath(neighbor, neighborAncestors)
          if (!neighborHasRootPath) {
            isolatedNodes.set(neighbor.id, neighbor)
            continue
          }

          nodes.set(neighbor.id, neighbor)
          this.addVerticalPath(nodes, edges, neighbor.id, neighborAncestors)
          addEdge(edges, {
            source: anchorNode.id,
            target: neighbor.id,
            type: edgeType,
          })
        }
      }
    }

    return {
      anchors: sortAnchors(deduplicateAnchors(anchors)),
      nodes: sortNodes(Array.from(nodes.values())),
      edges: sortEdges(Array.from(edges.values())),
      isolatedNodes: sortNodes(Array.from(isolatedNodes.values())),
    }
  }

  private async findHorizontalNeighbors(
    nodeId: string,
    edgeType: HorizontalEdgeType
  ): Promise<GraphNode[]> {
    switch (edgeType) {
      case 'CALLS':
        return this.repository.findCallNeighbors(nodeId)
      case 'IMPORTS':
        return this.repository.findImportNeighbors(nodeId)
      case 'EXTENDS':
        return this.repository.findExtendNeighbors(nodeId)
    }
  }

  private async getNodeOrNull(nodeId: string): Promise<GraphNode | undefined> {
    try {
      return await this.repository.findNodeById(nodeId)
    } catch {
      return undefined
    }
  }

  private async getAncestorsOrNull(nodeId: string): Promise<GraphNode[]> {
    try {
      return await this.repository.findAncestorsToRoot(nodeId)
    } catch {
      return []
    }
  }

  private addVerticalPath(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    childId: string,
    ancestors: GraphNode[]
  ): void {
    let currentChildId = childId

    for (const parent of ancestors) {
      nodes.set(parent.id, parent)
      addEdge(edges, {
        source: parent.id,
        target: currentChildId,
        type: 'CONTAINS',
      })
      currentChildId = parent.id
    }
  }
}

function addAnchor(anchors: Map<string, Anchor>, candidate: Anchor): void {
  const existing = anchors.get(candidate.id)
  if (!existing || isStrongerAnchor(candidate, existing)) {
    anchors.set(candidate.id, candidate)
  }
}

function isStrongerAnchor(candidate: Anchor, existing: Anchor): boolean {
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score
  }

  if (candidate.kind !== existing.kind) {
    return candidate.kind === 'blue'
  }

  return candidate.reason < existing.reason
}

function deduplicateAnchors(anchors: Anchor[]): Anchor[] {
  const deduplicated = new Map<string, Anchor>()
  for (const anchor of anchors) {
    addAnchor(deduplicated, anchor)
  }
  return Array.from(deduplicated.values())
}

function sortAnchors(anchors: Anchor[]): Anchor[] {
  return [...anchors].sort((left, right) => {
    const kindOrder = anchorKindOrder(left) - anchorKindOrder(right)
    if (kindOrder !== 0) {
      return kindOrder
    }

    const scoreOrder = right.score - left.score
    if (scoreOrder !== 0) {
      return scoreOrder
    }

    const idOrder = left.id.localeCompare(right.id)
    if (idOrder !== 0) {
      return idOrder
    }

    return left.reason.localeCompare(right.reason)
  })
}

function anchorKindOrder(anchor: Anchor): number {
  return anchor.kind === 'blue' ? 0 : 1
}

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id))
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...edges].sort((left, right) => {
    const sourceOrder = left.source.localeCompare(right.source)
    if (sourceOrder !== 0) {
      return sourceOrder
    }

    const targetOrder = left.target.localeCompare(right.target)
    if (targetOrder !== 0) {
      return targetOrder
    }

    return left.type.localeCompare(right.type)
  })
}

function addEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  edges.set(edgeKey(edge), edge)
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}->${edge.target}:${edge.type}`
}

function scoreRedNode(node: GraphNode, terms: string[]): RedMatch | undefined {
  const fields: Array<{ name: string; value: string | undefined; weight: number }> = [
    { name: 'name', value: node.name, weight: 1 },
    { name: 'signature', value: node.signature, weight: 0.9 },
    { name: 'docComment', value: node.docComment, weight: 0.7 },
  ]

  let bestMatch: RedMatch | undefined

  for (const field of fields) {
    if (!field.value) {
      continue
    }

    const lowerValue = field.value.toLowerCase()
    for (const term of terms) {
      const occurrences = countOccurrences(lowerValue, term)
      if (occurrences === 0) {
        continue
      }

      const score = Math.min(1, field.weight + (occurrences - 1) * 0.05)
      const reason = `red ${field.name} matches "${term}" ${occurrences} time${occurrences === 1 ? '' : 's'}`
      const candidate: RedMatch = { score, reason }

      if (!bestMatch || isStrongerRedMatch(candidate, bestMatch)) {
        bestMatch = candidate
      }
    }
  }

  return bestMatch
}

function isStrongerRedMatch(candidate: RedMatch, existing: RedMatch): boolean {
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score
  }

  return candidate.reason < existing.reason
}

function countOccurrences(value: string, term: string): number {
  if (term.length === 0) {
    return 0
  }

  let count = 0
  let index = value.indexOf(term)
  while (index >= 0) {
    count += 1
    index = value.indexOf(term, index + term.length)
  }
  return count
}

function tokenize(value: string): string[] {
  const spacedValue = value
    .replace(CAMEL_CASE_BOUNDARY_REGEX, '$1 $2')
    .replace(/[^A-Za-z0-9_]+/g, ' ')

  return uniqueStrings(
    Array.from(spacedValue.matchAll(WORD_REGEX))
      .map((match) => match[0].toLowerCase())
      .filter((term) => term.length > 1 && !RED_STOP_WORDS.has(term))
  )
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  )
}

function hasRootPath(node: GraphNode, ancestors: GraphNode[] | undefined): boolean {
  return node.label === 'REPO' || (ancestors ?? []).some((ancestor) => ancestor.label === 'REPO')
}
