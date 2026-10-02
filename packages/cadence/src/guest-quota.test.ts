import { describe, it, expect } from 'vitest'
import { checkGuestQuotaLimit } from './custo-da-ordem.js'

describe('checkGuestQuotaLimit', () => {
  it('returns true when usage is below limit', () => {
    expect(checkGuestQuotaLimit(50, 100)).toBe(true)
  })

  it('returns true when usage equals limit', () => {
    expect(checkGuestQuotaLimit(100, 100)).toBe(true)
  })

  it('returns false when usage is above limit', () => {
    expect(checkGuestQuotaLimit(150, 100)).toBe(false)
  })

  it('incorporates estimated cost in calculation', () => {
    expect(checkGuestQuotaLimit(90, 100, 5)).toBe(true)
    expect(checkGuestQuotaLimit(90, 100, 15)).toBe(false)
  })
})
