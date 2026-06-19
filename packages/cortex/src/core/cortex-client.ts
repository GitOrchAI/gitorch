import { ChromaSemanticStore, type ChromaSemanticStoreOptions } from '../db/chroma-store'
import { SqliteStore } from '../db/sqlite-store'
import type {
  CortexDrawer,
  CortexIdentity,
  CortexSearchResult,
  CortexTriple,
  CortexWakeUpResult,
} from '../types'
import { LayerSelector, type StoreLike } from './layers'

export type EmbeddingFn = (text: string) => number[] | Promise<number[]>

export interface CortexClientOptions {
  sqlitePath?: string
  sqliteStore?: SqliteStore
  chromaStore?: ChromaSemanticStore
  chromaOptions?: ChromaSemanticStoreOptions
  embeddingFn?: EmbeddingFn
  selector?: LayerSelector
}

export class CortexClient {
  private initialized = false
  private sqliteStore: SqliteStore | null = null
  private chromaStore: ChromaSemanticStore | null = null
  private readonly embeddingFn: EmbeddingFn
  private readonly selector: LayerSelector

  constructor(private readonly options: CortexClientOptions = {}) {
    this.embeddingFn = options.embeddingFn ?? ((text: string) => deterministicEmbedding(text))
    this.selector = options.selector ?? new LayerSelector(this.storeLike())
  }

  init(): void {
    this.initialized = true
  }

  writeIdentity(identity: CortexIdentity): void {
    this.ensureInitialized()
    this.getSqliteStore().upsertIdentity(identity)
  }

  async writeDrawer(drawer: CortexDrawer): Promise<void> {
    this.ensureInitialized()
    this.getSqliteStore().upsertDrawer(drawer)

    if (this.options.chromaStore) {
      await this.getChromaStore().upsertDrawer(drawer, await this.embeddingFn(drawer.content))
    }
  }

  writeTriple(triple: CortexTriple & { wingId: string }): void {
    this.ensureInitialized()
    this.getSqliteStore().insertTriple(triple)
  }

  wakeUp(wingId: string): CortexWakeUpResult {
    this.ensureInitialized()
    return this.selector.wakeUp(wingId)
  }

  recallLocal(wingId: string, roomId?: string, hallId?: string): CortexDrawer[] {
    this.ensureInitialized()
    return this.selector.loadL2(wingId, roomId, hallId)
  }

  async search(wingId: string, query: string, limit: number): Promise<CortexSearchResult[]> {
    this.ensureInitialized()
    const embedding = await this.embeddingFn(query)

    return this.getChromaStore().search(wingId, undefined, undefined, embedding, limit)
  }

  close(): void {
    this.initialized = false
    this.sqliteStore?.close()
    this.sqliteStore = null
    this.chromaStore = null
  }

  get sqlitePath(): string {
    return this.options.sqlitePath ?? '.cortex.sqlite'
  }

  private getSqliteStore(): SqliteStore {
    if (!this.sqliteStore) {
      this.sqliteStore = this.options.sqliteStore ?? new SqliteStore(this.sqlitePath)
    }

    return this.sqliteStore
  }

  private getChromaStore(): ChromaSemanticStore {
    if (!this.chromaStore) {
      this.chromaStore =
        this.options.chromaStore ??
        ChromaSemanticStore.fromOptions(this.options.chromaOptions ?? {})
    }

    return this.chromaStore
  }

  private storeLike(): StoreLike {
    return {
      getIdentity: (wingId: string) => this.getSqliteStore().getIdentity(wingId),
      getTopDrawers: (wingId: string, limit: number) =>
        this.getSqliteStore().getTopDrawers(wingId, limit),
      getDrawersByScope: (wingId: string, roomId?: string, hallId?: string, limit?: number) =>
        this.getSqliteStore().getDrawersByScope(wingId, roomId, hallId, limit),
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('CortexClient is not initialized. Call init() first.')
    }
  }
}

export function deterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(8).fill(0)

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const slot = index % vector.length
    const current = vector[slot] ?? 0
    vector[slot] = current + ((code % 17) - 8) / 8
  }

  return vector
}
