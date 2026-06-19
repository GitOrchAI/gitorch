import type { CortexDrawer, CortexIdentity, CortexWakeUpResult } from '../types'

export interface StoreLike {
  getIdentity(wingId: string): CortexIdentity | null
  getTopDrawers(wingId: string, limit: number): CortexDrawer[]
  getDrawersByScope(
    wingId: string,
    roomId?: string,
    hallId?: string,
    limit?: number
  ): CortexDrawer[]
}

export class LayerSelector {
  constructor(private readonly store: StoreLike) {}

  wakeUp(wingId: string): CortexWakeUpResult {
    const identity = this.store.getIdentity(wingId)
    if (!identity) {
      throw new Error(`Identity not found for wing ${wingId}`)
    }

    return {
      identity,
      drawers: this.loadL1(wingId),
      tokenBudget: 500,
    }
  }

  loadL1(wingId: string): CortexDrawer[] {
    return this.store.getTopDrawers(wingId, 15)
  }

  loadL2(wingId: string, roomId?: string, hallId?: string): CortexDrawer[] {
    return this.store.getDrawersByScope(wingId, roomId, hallId, 20)
  }

  selectLayer(intent: 'identity' | 'wake-up' | 'local' | 'semantic'): 'L0' | 'L1' | 'L2' | 'L3' {
    switch (intent) {
      case 'identity':
        return 'L0'
      case 'wake-up':
        return 'L1'
      case 'local':
        return 'L2'
      case 'semantic':
        return 'L3'
      default:
        return 'L2'
    }
  }
}
