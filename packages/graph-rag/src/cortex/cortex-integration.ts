import type { CortexSearchResult, CortexWakeUpResult } from '@gitorch/cortex'

const DEFAULT_SEMANTIC_ANCHOR_LIMIT = 10

export interface CortexClientLike {
  wakeUp(wingId: string): CortexWakeUpResult | Promise<CortexWakeUpResult>
  recallLocal(wingId: string, roomId?: string, hallId?: string): unknown
  search(wingId: string, query: string, limit: number): Promise<CortexSearchResult[]>
}

export interface CortexPlanContext {
  wingId: string
  identity?: CortexWakeUpResult['identity']
  wakeUp?: CortexWakeUpResult
  localScope?: unknown
  semanticAnchors: CortexSearchResult[]
}

export interface CortexGraphRAGAdapterOptions {
  includeSemanticAnchors?: boolean
  semanticAnchorLimit?: number
}

export class CortexGraphRAGAdapter {
  private readonly includeSemanticAnchors: boolean
  private readonly semanticAnchorLimit: number

  constructor(
    private readonly cortex: CortexClientLike,
    options: CortexGraphRAGAdapterOptions = {}
  ) {
    this.includeSemanticAnchors = options.includeSemanticAnchors ?? true
    this.semanticAnchorLimit = options.semanticAnchorLimit ?? DEFAULT_SEMANTIC_ANCHOR_LIMIT
  }

  async wakeUp(wingId: string): Promise<CortexWakeUpResult> {
    return this.cortex.wakeUp(wingId)
  }

  async loadLocalScope(wingId: string, roomId?: string, hallId?: string): Promise<unknown> {
    return this.cortex.recallLocal(wingId, roomId, hallId)
  }

  async semanticAnchors(
    wingId: string,
    query: string,
    limit = this.semanticAnchorLimit
  ): Promise<CortexSearchResult[]> {
    return this.cortex.search(wingId, query, limit)
  }

  async buildPlanContext(
    wingId: string,
    query: string,
    roomId?: string,
    hallId?: string
  ): Promise<CortexPlanContext> {
    const [wakeUp, localScope, semanticAnchors] = await Promise.all([
      this.wakeUp(wingId),
      this.loadLocalScope(wingId, roomId, hallId),
      this.includeSemanticAnchors ? this.semanticAnchors(wingId, query) : Promise.resolve([]),
    ])

    return {
      wingId,
      identity: wakeUp.identity,
      wakeUp,
      localScope,
      semanticAnchors,
    }
  }
}
