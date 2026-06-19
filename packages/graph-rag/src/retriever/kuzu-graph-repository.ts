import type { KuzuClient } from '@gitorch/cgc'
import type { GraphEdge, GraphNode } from '../types'

export interface GraphRepository {
  findNodeById(id: string): Promise<GraphNode>
  findNodesByNames(names: string[]): Promise<GraphNode[]>
  findFilesByPath(pathFragments: string[]): Promise<GraphNode[]>
  findCallNeighbors(nodeId: string): Promise<GraphNode[]>
  findImportNeighbors(nodeId: string): Promise<GraphNode[]>
  findExtendNeighbors(nodeId: string): Promise<GraphNode[]>
  findAncestorsToRoot(nodeId: string): Promise<GraphNode[]>
}

export interface GraphRepositoryInput {
  nodes: GraphNode[]
  edges?: GraphEdge[]
}

type KuzuQueryRow = Record<string, unknown>

type KuzuQueryOptions = {
  parameters?: Record<string, unknown>
}

type KuzuGraphClient = {
  query(query: string, options?: KuzuQueryOptions): Promise<KuzuQueryRow[]>
}

const MAX_ANCESTOR_DEPTH = 100

export class InMemoryGraphRepository implements GraphRepository {
  private readonly nodesById = new Map<string, GraphNode>()
  private readonly nodesByName = new Map<string, GraphNode[]>()
  private readonly edgesBySource = new Map<string, GraphEdge[]>()
  private readonly edgesByTarget = new Map<string, GraphEdge[]>()

  constructor(input: GraphRepositoryInput)
  constructor(nodes: GraphNode[], edges?: GraphEdge[])
  constructor(nodesOrInput: GraphNode[] | GraphRepositoryInput, edges: GraphEdge[] = []) {
    const nodes = Array.isArray(nodesOrInput) ? nodesOrInput : nodesOrInput.nodes
    const graphEdges = Array.isArray(nodesOrInput) ? edges : (nodesOrInput.edges ?? [])

    for (const node of nodes) {
      this.nodesById.set(node.id, node)

      if (node.name) {
        const nodesWithSameName = this.nodesByName.get(node.name) ?? []
        nodesWithSameName.push(node)
        this.nodesByName.set(node.name, nodesWithSameName)
      }
    }

    for (const edge of graphEdges) {
      const sourceEdges = this.edgesBySource.get(edge.source) ?? []
      sourceEdges.push(edge)
      this.edgesBySource.set(edge.source, sourceEdges)

      const targetEdges = this.edgesByTarget.get(edge.target) ?? []
      targetEdges.push(edge)
      this.edgesByTarget.set(edge.target, targetEdges)
    }
  }

  async findNodeById(id: string): Promise<GraphNode> {
    const node = this.nodesById.get(id)
    if (!node) throw new Error(`Unknown graph node: ${id}`)
    return node
  }

  async findNodesByNames(names: string[]): Promise<GraphNode[]> {
    const matches: GraphNode[] = []
    const seen = new Set<string>()

    for (const name of names) {
      for (const node of this.nodesByName.get(name) ?? []) {
        if (!seen.has(node.id)) {
          seen.add(node.id)
          matches.push(node)
        }
      }
    }

    return matches
  }

  async findFilesByPath(pathFragments: string[]): Promise<GraphNode[]> {
    if (pathFragments.length === 0) return []

    return [...this.nodesById.values()].filter((node) =>
      node.filePath ? pathFragments.every((fragment) => node.filePath?.includes(fragment)) : false
    )
  }

  async findCallNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'CALLS')
  }

  async findImportNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'IMPORTS')
  }

  async findExtendNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'EXTENDS')
  }

  async findAncestorsToRoot(nodeId: string): Promise<GraphNode[]> {
    await this.findNodeById(nodeId)

    const ancestors: GraphNode[] = []
    const visited = new Set<string>([nodeId])
    let currentId = nodeId

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      const containsEdges = (this.edgesByTarget.get(currentId) ?? []).filter(
        (edge) => edge.type === 'CONTAINS'
      )
      if (containsEdges.length === 0) return ancestors

      const parent = this.nodesById.get(containsEdges[0]!.source)
      if (!parent) throw new Error(`Unknown graph node: ${containsEdges[0]!.source}`)
      if (visited.has(parent.id)) return ancestors

      ancestors.push(parent)
      visited.add(parent.id)

      if (parent.label === 'REPO') return ancestors
      currentId = parent.id
    }

    return ancestors
  }

  private findOutgoingNeighbors(nodeId: string, edgeType: string): GraphNode[] {
    this.getNodeOrThrow(nodeId)

    return (this.edgesBySource.get(nodeId) ?? [])
      .filter((edge) => edge.type === edgeType)
      .map((edge) => this.getNodeOrThrow(edge.target))
  }

  private getNodeOrThrow(id: string): GraphNode {
    const node = this.nodesById.get(id)
    if (!node) throw new Error(`Unknown graph node: ${id}`)
    return node
  }
}

export class KuzuGraphRepository implements GraphRepository {
  constructor(client: KuzuClient)
  constructor(private readonly client: KuzuGraphClient) {}

  async findNodeById(id: string): Promise<GraphNode> {
    const rows = await this.client.query(
      `MATCH (n) WHERE n.id = $id
RETURN ${this.nodeSelect('n')}`,
      { parameters: { id } }
    )

    if (rows.length === 0) throw new Error(`Unknown graph node: ${id}`)
    return rowToGraphNode(rows[0]!)
  }

  async findNodesByNames(names: string[]): Promise<GraphNode[]> {
    if (names.length === 0) return []

    const rows = await this.client.query(
      `MATCH (n) WHERE n.name IN $names
RETURN ${this.nodeSelect('n')}`,
      { parameters: { names } }
    )

    return rows.map((row) => rowToGraphNode(row))
  }

  async findFilesByPath(pathFragments: string[]): Promise<GraphNode[]> {
    if (pathFragments.length === 0) return []

    const rows = await this.client.query(
      `MATCH (n) WHERE n.filePath IS NOT NULL
RETURN ${this.nodeSelect('n')}`
    )
    const nodes = rows.map((row) => rowToGraphNode(row))

    return nodes.filter((node) =>
      node.filePath ? pathFragments.every((fragment) => node.filePath?.includes(fragment)) : false
    )
  }

  async findCallNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'CALLS')
  }

  async findImportNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'IMPORTS')
  }

  async findExtendNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.findOutgoingNeighbors(nodeId, 'EXTENDS')
  }

  async findAncestorsToRoot(nodeId: string): Promise<GraphNode[]> {
    await this.findNodeById(nodeId)

    const ancestors: GraphNode[] = []
    const visited = new Set<string>([nodeId])
    let currentId = nodeId

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      const rows = await this.client.query(
        `MATCH (parent)-[:CONTAINS]->(child {id: $id})
RETURN ${this.nodeSelect('parent')}`,
        { parameters: { id: currentId } }
      )
      if (rows.length === 0) return ancestors

      const parent = rowToGraphNode(rows[0]!)
      if (visited.has(parent.id)) return ancestors

      ancestors.push(parent)
      visited.add(parent.id)

      if (parent.label === 'REPO') return ancestors
      currentId = parent.id
    }

    return ancestors
  }

  private async findOutgoingNeighbors(nodeId: string, edgeType: string): Promise<GraphNode[]> {
    await this.findNodeById(nodeId)

    const safeEdgeType = sanitizeRelationshipType(edgeType)
    const rows = await this.client.query(
      `MATCH (source {id: $id})-[r:${safeEdgeType}]->(target)
RETURN source.id AS sourceId,
       target.id AS targetId,
       '${safeEdgeType}' AS edgeType,
       ${this.nodeSelect('target')}
ORDER BY target.id ASC`,
      { parameters: { id: nodeId } }
    )

    return rows
      .map((row) => {
        const edge = rowToGraphEdge(row)
        if (
          edge.source !== nodeId ||
          edge.target !== rowToGraphNode(row).id ||
          edge.type !== edgeType
        ) {
          return undefined
        }
        return rowToGraphNode(row)
      })
      .filter((node): node is GraphNode => node !== undefined)
  }

  private nodeSelect(alias: string): string {
    return `${alias}.id AS id,
       labels(${alias}) AS labelList,
       ${alias}.label AS label,
       ${alias}.type AS type,
       ${alias}.filePath AS filePath,
       ${alias}.name AS name,
       ${alias}.signature AS signature,
       ${alias}.docComment AS docComment`
  }
}

function sanitizeRelationshipType(edgeType: string): string {
  if (!/^[A-Z_]+$/.test(edgeType)) {
    throw new Error(`Unsupported graph relationship type: ${edgeType}`)
  }
  return edgeType
}

function rowToGraphNode(row: KuzuQueryRow, prefix = ''): GraphNode {
  const id = asString(read(row, `${prefix}id`) ?? read(row, 'id'))
  if (!id) throw new Error('Cannot map graph node without id')

  const labelList = asStringArray(read(row, `${prefix}labelList`) ?? read(row, 'labelList'))
  const label =
    asString(read(row, `${prefix}label`) ?? read(row, 'label')) ?? labelList[0] ?? 'Unknown'

  return {
    id,
    label,
    type: asString(read(row, `${prefix}type`) ?? read(row, 'type')) ?? '',
    filePath: asString(read(row, `${prefix}filePath`) ?? read(row, 'filePath')),
    name: asString(read(row, `${prefix}name`) ?? read(row, 'name')),
    signature: asString(read(row, `${prefix}signature`) ?? read(row, 'signature')),
    docComment: asString(read(row, `${prefix}docComment`) ?? read(row, 'docComment')),
    properties: asRecord(read(row, `${prefix}properties`) ?? read(row, 'properties')),
  }
}

function rowToGraphEdge(row: KuzuQueryRow, prefix = ''): GraphEdge {
  const source = asString(
    read(row, `${prefix}source`) ?? read(row, 'sourceId') ?? read(row, 'source')
  )
  const target = asString(
    read(row, `${prefix}target`) ?? read(row, 'targetId') ?? read(row, 'target')
  )
  const type = asString(read(row, `${prefix}edgeType`) ?? read(row, 'type'))

  if (!source || !target || !type) {
    throw new Error('Cannot map graph edge without source, target, and type')
  }

  return {
    source,
    target,
    type,
    properties: asRecord(read(row, `${prefix}properties`) ?? read(row, 'properties')),
  }
}

function read(row: KuzuQueryRow, field: string): unknown {
  return row[field]
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  return String(value)
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(asString).filter((item): item is string => item !== undefined)
  const stringValue = asString(value)
  return stringValue ? [stringValue] : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
