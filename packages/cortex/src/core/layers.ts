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

export interface LayerSelectorOptions {
  l1BudgetBase?: number
  l1DrawerBudget?: number
  l1BudgetMax?: number
  l1Limit?: number
  l2Limit?: number
}

export class LayerSelector {
  private readonly l1BudgetBase: number
  private readonly l1DrawerBudget: number
  private readonly l1BudgetMax: number
  private readonly l1Limit: number
  private readonly l2Limit: number

  constructor(
    private readonly store: StoreLike,
    options: LayerSelectorOptions = {}
  ) {
    this.l1BudgetBase = options.l1BudgetBase ?? 170
    this.l1DrawerBudget = options.l1DrawerBudget ?? 20
    this.l1BudgetMax = options.l1BudgetMax ?? 500
    this.l1Limit = options.l1Limit ?? 15
    this.l2Limit = options.l2Limit ?? 20
  }

  wakeUp(wingId: string): CortexWakeUpResult {
    const identity = this.store.getIdentity(wingId)
    if (!identity) {
      throw new Error(`Identity not found for wing ${wingId}`)
    }

    const drawers = this.loadL1(wingId)

    return {
      identity,
      drawers,
      tokenBudget: this.calculateL1Budget(drawers.length),
    }
  }

  loadL1(wingId: string): CortexDrawer[] {
    return this.store.getTopDrawers(wingId, this.l1Limit)
  }

  loadL2(wingId: string, roomId?: string, hallId?: string, limit = this.l2Limit): CortexDrawer[] {
    return this.store.getDrawersByScope(wingId, roomId, hallId, limit)
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

  private calculateL1Budget(drawerCount: number): number {
    return Math.min(this.l1BudgetBase + drawerCount * this.l1DrawerBudget, this.l1BudgetMax)
  }
}
