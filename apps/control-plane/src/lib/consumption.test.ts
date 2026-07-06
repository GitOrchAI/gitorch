import { describe, expect, it } from 'vitest'
import { computeConsumption } from './consumption.js'

describe('computeConsumption', () => {
  it('antes − depois quando ambos conhecidos', () => {
    expect(computeConsumption(1000, 850)).toEqual({
      quotaBefore: 1000,
      quotaAfter: 850,
      tokensUsed: 150,
    })
  })
  it('consumo zero é válido', () => {
    expect(computeConsumption(500, 500).tokensUsed).toBe(0)
  })
  it('quota que subiu (reset diário) → tokensUsed null (não inventa)', () => {
    expect(computeConsumption(100, 900).tokensUsed).toBeNull()
  })
  it('dado ausente → tokensUsed null, preserva o que tem', () => {
    expect(computeConsumption(null, 500)).toEqual({
      quotaBefore: null,
      quotaAfter: 500,
      tokensUsed: null,
    })
    expect(computeConsumption(1000, undefined).tokensUsed).toBeNull()
    expect(computeConsumption(null, null).tokensUsed).toBeNull()
  })
})
