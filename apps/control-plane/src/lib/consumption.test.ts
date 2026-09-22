import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../plugins/redis.js', () => {
  const mockGet = vi.fn()
  const mockIncrbyfloat = vi.fn()
  const mockIncrby = vi.fn()
  return {
    createRedisClient: vi.fn().mockImplementation(() => ({
      get: mockGet,
      incrbyfloat: mockIncrbyfloat,
      incrby: mockIncrby,
    })),
    __mockGet: mockGet,
    __mockIncrbyfloat: mockIncrbyfloat,
    __mockIncrby: mockIncrby,
  }
})

import * as redisModule from '../plugins/redis.js'
import { Mock } from 'vitest'
const mockGet = (redisModule as unknown as { __mockGet: Mock }).__mockGet
const mockIncrbyfloat = (redisModule as unknown as { __mockIncrbyfloat: Mock }).__mockIncrbyfloat
const mockIncrby = (redisModule as unknown as { __mockIncrby: Mock }).__mockIncrby

import { computeConsumption, fetchGuestConsumption, recordGuestConsumption } from './consumption.js'
import { MetricasDeExecucaoCI } from '@gitorch/cadence'

describe('computeConsumption', () => {
  it('antes − depois quando ambos conhecidos', () => {
    const r = computeConsumption(100, 80)
    expect(r.tokensUsed).toBe(20)
  })

  it('consumo zero é válido', () => {
    const r = computeConsumption(100, 100)
    expect(r.tokensUsed).toBe(0)
  })

  it('quota que subiu (reset diário) → tokensUsed null (não inventa)', () => {
    const r = computeConsumption(50, 100)
    expect(r.tokensUsed).toBeNull()
  })

  it('dado ausente → tokensUsed null, preserva o que tem', () => {
    const r = computeConsumption(null, 80)
    expect(r.tokensUsed).toBeNull()
    expect(r.quotaAfter).toBe(80)
    expect(r.quotaBefore).toBeNull()
  })
})

describe('recordGuestConsumption', () => {
  beforeEach(() => {
    mockIncrbyfloat.mockClear()
    mockIncrby.mockClear()
    mockGet.mockClear()
  })

  it('increments cost and tokens using redis', async () => {
    const metrics: MetricasDeExecucaoCI = { duracaoSegundos: 120, cpus: 2, ramGb: 4 }
    await recordGuestConsumption('guest-123', 'proj-456', metrics, 500)

    expect(mockIncrbyfloat).toHaveBeenCalledWith(
      'guest_consumption:cost:guest-123:project:proj-456',
      12
    )
    expect(mockIncrby).toHaveBeenCalledWith(
      'guest_consumption:tokens:guest-123:project:proj-456',
      500
    )
  })
})

describe('fetchGuestConsumption', () => {
  beforeEach(() => {
    mockGet.mockClear()
  })

  it('returns parsed integer/float values from redis', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'guest_consumption:cost:guest-123:project:proj-456') return '15.5'
      if (key === 'guest_consumption:tokens:guest-123:project:proj-456') return '1000'
      return null
    })

    const res = await fetchGuestConsumption('guest-123', 'proj-456')
    expect(res.consumedCost).toBe(15.5)
    expect(res.consumedTokens).toBe(1000)
    expect(res.proportionCost).toBeUndefined()
    expect(res.proportionTokens).toBeUndefined()
  })

  it('returns 0 when redis returns null', async () => {
    mockGet.mockResolvedValue(null)

    const res = await fetchGuestConsumption('guest-123', 'proj-456')
    expect(res.consumedCost).toBe(0)
    expect(res.consumedTokens).toBe(0)
  })

  it('returns proportion correctly when quota is provided', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'guest_consumption:cost:guest-123:project:proj-456') return '50'
      if (key === 'guest_consumption:tokens:guest-123:project:proj-456') return '500'
      return null
    })

    const quota = { maxTokens: 1000, maxCost: 200 }
    const res = await fetchGuestConsumption('guest-123', 'proj-456', quota)

    expect(res.consumedCost).toBe(50)
    expect(res.consumedTokens).toBe(500)
    expect(res.proportionTokens).toBe(0.5) // 500 / 1000
    expect(res.proportionCost).toBe(0.25) // 50 / 200
  })

  it('handles proportion securely when quota limits are zero', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'guest_consumption:cost:guest-123:project:proj-456') return '50'
      if (key === 'guest_consumption:tokens:guest-123:project:proj-456') return '500'
      return null
    })

    const quota = { maxTokens: 0, maxCost: 0 }
    const res = await fetchGuestConsumption('guest-123', 'proj-456', quota)

    expect(res.proportionTokens).toBe(0)
    expect(res.proportionCost).toBe(0)
  })
})
