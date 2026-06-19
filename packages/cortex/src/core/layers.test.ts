import { describe, expect, it, vi } from 'vitest'
import type { CortexDrawer, CortexIdentity } from '../types'
import { LayerSelector } from './layers'

function drawer(
  id: string,
  importance: number,
  emotionalWeight: number,
  roomId = 'auth',
  hallId = 'hall_facts'
): CortexDrawer {
  return {
    id,
    wingId: 'loureng/gitorch',
    roomId,
    hallId,
    content: id,
    importance,
    emotionalWeight,
    createdAt: '2026-06-19T00:00:00.000Z',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.9,
    tags: ['core'],
  }
}

describe('LayerSelector', () => {
  const identity: CortexIdentity = {
    wingId: 'loureng/gitorch',
    persona: 'GitOrch Cortex Orchestrator',
    orchestrationGuidelines: 'Use MemPalace isolation and L0-L3 retrieval.',
  }

  it('wakes up with L0 identity and top-15 L1 drawers under the token budget', () => {
    const store = {
      getIdentity: vi.fn().mockReturnValue(identity),
      getTopDrawers: vi
        .fn()
        .mockReturnValue([drawer('drawer-1', 0.9, 0.8), drawer('drawer-2', 0.7, 0.9)]),
      getDrawersByScope: vi.fn(),
    }
    const selector = new LayerSelector(store)

    expect(selector.wakeUp('loureng/gitorch')).toEqual({
      identity,
      drawers: [drawer('drawer-1', 0.9, 0.8), drawer('drawer-2', 0.7, 0.9)],
      tokenBudget: 210,
    })
    expect(store.getTopDrawers).toHaveBeenCalledWith('loureng/gitorch', 15)
  })

  it('throws when the L0 identity is missing', () => {
    const selector = new LayerSelector({
      getIdentity: vi.fn().mockReturnValue(null),
      getTopDrawers: vi.fn(),
      getDrawersByScope: vi.fn(),
    })

    expect(() => selector.wakeUp('missing')).toThrow('Identity not found for wing missing')
  })

  it('loads L2 local recall by room and hall', () => {
    const scoped = [drawer('drawer-room', 0.8, 0.5)]
    const store = {
      getIdentity: vi.fn(),
      getTopDrawers: vi.fn(),
      getDrawersByScope: vi.fn().mockReturnValue(scoped),
    }
    const selector = new LayerSelector(store)

    expect(selector.loadL2('loureng/gitorch', 'auth', 'hall_events', 5)).toEqual(scoped)
    expect(store.getDrawersByScope).toHaveBeenCalledWith(
      'loureng/gitorch',
      'auth',
      'hall_events',
      5
    )
  })

  it('maps intents to Cortex layers', () => {
    const selector = new LayerSelector({
      getIdentity: vi.fn(),
      getTopDrawers: vi.fn(),
      getDrawersByScope: vi.fn(),
    })

    expect(selector.selectLayer('identity')).toBe('L0')
    expect(selector.selectLayer('wake-up')).toBe('L1')
    expect(selector.selectLayer('local')).toBe('L2')
    expect(selector.selectLayer('semantic')).toBe('L3')
  })
})
