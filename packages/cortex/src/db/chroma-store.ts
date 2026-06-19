import type { CortexDrawer } from '../types'

export interface ChromaCollectionLike {
  upsert(record: Record<string, unknown>): Promise<void>
  query(query: Record<string, unknown>): Promise<ChromaQueryResponse>
}

export interface ChromaClientLike {
  getOrCreateCollection(
    name: string,
    options?: Record<string, unknown>
  ): Promise<ChromaCollectionLike>
}

export interface ChromaSemanticStoreOptions {
  path?: string
  client?: ChromaClientLike
}

export interface ChromaQueryResponse {
  ids: string[][]
  documents?: string[][]
  distances?: number[][]
  metadatas?: Array<Array<Record<string, unknown>>>
}

type ChromaClientConstructor = new (options: { path: string }) => ChromaClientLike
type ChromaModule = { ChromaClient: ChromaClientConstructor }

export class ChromaSemanticStore {
  private readonly collections = new Map<string, ChromaCollectionLike>()

  constructor(private readonly client: ChromaClientLike) {}

  static fromOptions(options: ChromaSemanticStoreOptions = {}): ChromaSemanticStore {
    if (options.client) {
      return new ChromaSemanticStore(options.client)
    }

    // chromadb v3.4.3 does not ship stable TypeScript declarations in this
    // workspace, so dynamic CommonJS loading keeps the package optional at
    // compile time while preserving runtime ChromaClient creation.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chromadb = require('chromadb') as ChromaModule
    const client = new chromadb.ChromaClient({
      path: options.path ?? 'http://localhost:8000',
    })

    return new ChromaSemanticStore(client)
  }

  async upsertDrawer(drawer: CortexDrawer, embeddings: number[]): Promise<void> {
    const collection = await this.getCollection(drawer.wingId)

    await collection.upsert({
      ids: [drawer.id],
      embeddings: [embeddings],
      documents: [drawer.content],
      metadatas: [this.toMetadata(drawer)],
    })
  }

  async search(
    wingId: string,
    roomId: string | undefined,
    hallId: string | undefined,
    queryEmbedding: number[],
    limit: number
  ): Promise<
    Array<{
      drawerId: string
      layer: 'L3'
      score: number
      content: string
      metadata: CortexDrawer
    }>
  > {
    const collection = await this.getCollection(wingId)
    const response = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: this.buildWhere(wingId, roomId, hallId),
      include: ['documents', 'metadatas', 'distances'],
    })

    return (
      response.ids[0]?.map((id, index) => {
        const metadata = response.metadatas?.[0]?.[index] ?? {}
        const distance = response.distances?.[0]?.[index]

        return {
          drawerId: id,
          layer: 'L3' as const,
          score: typeof distance === 'number' ? Math.max(0, 1 - distance) : 1,
          content: response.documents?.[0]?.[index] ?? String(metadata['content'] ?? ''),
          metadata: this.fromMetadata(metadata, id),
        }
      }) ?? []
    )
  }

  private async getCollection(wingId: string): Promise<ChromaCollectionLike> {
    const collectionName = `cortex-${this.collectionKey(wingId)}`
    const existing = this.collections.get(collectionName)

    if (existing) {
      return existing
    }

    const collection = await this.client.getOrCreateCollection(collectionName, {
      metadata: {
        wingId,
        layer: 'L3',
      },
    })

    this.collections.set(collectionName, collection)
    return collection
  }

  private collectionKey(wingId: string): string {
    return wingId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  private buildWhere(
    wingId: string,
    roomId: string | undefined,
    hallId: string | undefined
  ): Record<string, unknown> {
    const filters: Record<string, unknown>[] = [{ wingId: { $eq: wingId } }]

    if (roomId) {
      filters.push({ roomId: { $eq: roomId } })
    }

    if (hallId) {
      filters.push({ hallId: { $eq: hallId } })
    }

    return filters.length === 1 ? (filters[0] as Record<string, unknown>) : { $and: filters }
  }

  private toMetadata(drawer: CortexDrawer): Record<string, unknown> {
    return {
      id: drawer.id,
      wingId: drawer.wingId,
      roomId: drawer.roomId,
      hallId: drawer.hallId,
      content: drawer.content,
      importance: drawer.importance,
      emotionalWeight: drawer.emotionalWeight,
      createdAt: drawer.createdAt,
      validFrom: drawer.validFrom,
      validTo: drawer.validTo ?? null,
      confidence: drawer.confidence,
      tags: JSON.stringify(drawer.tags),
    }
  }

  private fromMetadata(metadata: Record<string, unknown>, fallbackId: string): CortexDrawer {
    return {
      id: String(metadata['id'] ?? fallbackId),
      wingId: String(metadata['wingId'] ?? ''),
      roomId: String(metadata['roomId'] ?? ''),
      hallId: String(metadata['hallId'] ?? ''),
      content: String(metadata['content'] ?? ''),
      importance: Number(metadata['importance'] ?? 0),
      emotionalWeight: Number(metadata['emotionalWeight'] ?? 0),
      createdAt: String(metadata['createdAt'] ?? ''),
      validFrom: String(metadata['validFrom'] ?? ''),
      validTo: metadata['validTo'] ? String(metadata['validTo']) : undefined,
      confidence: Number(metadata['confidence'] ?? 0),
      tags: this.parseTags(metadata['tags']),
    }
  }

  private parseTags(tags: unknown): string[] {
    if (Array.isArray(tags)) {
      return tags.map((tag) => String(tag))
    }

    if (typeof tags === 'string') {
      try {
        const parsed = JSON.parse(tags)
        return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : []
      } catch {
        return []
      }
    }

    return []
  }
}
