import type {
  CortexDrawer,
  CortexIdentity,
  CortexSearchResult,
  CortexTriple,
  CortexWakeUpResult,
} from '../types'

export interface CortexClientOptions {
  sqlitePath?: string
}

export class CortexClient {
  private initialized = false

  constructor(private readonly options: CortexClientOptions = {}) {}

  init(): void {
    this.initialized = true
  }

  writeIdentity(_identity: CortexIdentity): void {
    this.ensureInitialized()
  }

  async writeDrawer(_drawer: CortexDrawer): Promise<void> {
    this.ensureInitialized()
  }

  async writeTriple(_triple: CortexTriple & { wingId: string }): Promise<void> {
    this.ensureInitialized()
  }

  wakeUp(_wingId: string): CortexWakeUpResult {
    this.ensureInitialized()
    return {
      identity: {
        wingId: '',
        persona: '',
        orchestrationGuidelines: '',
      },
      drawers: [],
      tokenBudget: 0,
    }
  }

  recallLocal(_wingId: string, _roomId?: string, _hallId?: string): CortexDrawer[] {
    this.ensureInitialized()
    return []
  }

  async search(_wingId: string, _query: string, _limit: number): Promise<CortexSearchResult[]> {
    this.ensureInitialized()
    return []
  }

  close(): void {
    this.initialized = false
  }

  get sqlitePath(): string {
    return this.options.sqlitePath ?? '.cortex.sqlite'
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('CortexClient is not initialized. Call init() first.')
    }
  }
}
