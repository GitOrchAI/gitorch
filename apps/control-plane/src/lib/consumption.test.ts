import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { computeConsumption, recordGuestConsumption } from './consumption.js'
import * as prismaPlugins from '../plugins/prisma.js'

describe('recordGuestConsumption', () => {
  it('increments tokens properly and returns consumed proportion', async () => {
    let capturedId = ''
    let capturedTokens = 0
    vi.spyOn(prismaPlugins, 'incrementGuestUsedQuota').mockImplementation(
      async (guestId: string, tokens: number) => {
        capturedId = guestId
        capturedTokens = tokens
        return {
          id: guestId,
          userId: 'some_user',
          targetProjects: {},
          status: 'pending',
          expiresAt: new Date(),
          engineMapping: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          usedQuota: 1500, // assume 1000 previous + 500 new
          executionLimits: { maxQuota: 3000 },
        }
      }
    )

    const proportion = await recordGuestConsumption(
      'guest_1',
      'proj_1',
      {
        usage: { promptTokens: 300, completionTokens: 200 },
        runtime: 'claude',
      }
    )

    expect(capturedId).toBe('guest_1')
    expect(capturedTokens).toBe(500)
    expect(proportion).toBe(0.5) // 1500 / 3000
    vi.restoreAllMocks()
  })

  it('returns 0 if usage is zero or missing', async () => {
    const spy = vi.spyOn(prismaPlugins, 'incrementGuestUsedQuota')

    const proportion = await recordGuestConsumption(
      'guest_1',
      'proj_1',
      {
        usage: { promptTokens: 0, completionTokens: 0 },
        runtime: 'claude',
      }
    )

    expect(spy).not.toHaveBeenCalled()
    expect(proportion).toBe(0)
    vi.restoreAllMocks()
  })

  it('returns 0 if maxQuota is not configured', async () => {
    vi.spyOn(prismaPlugins, 'incrementGuestUsedQuota').mockImplementation(
      async (guestId: string) => {
        return {
          id: guestId,
          userId: 'some_user',
          targetProjects: {},
          status: 'pending',
          expiresAt: new Date(),
          engineMapping: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          usedQuota: 1500,
          executionLimits: null,
        }
      }
    )

    const proportion = await recordGuestConsumption(
      'guest_1',
      'proj_1',
      {
        usage: { promptTokens: 300, completionTokens: 200 },
        runtime: 'claude',
      }
    )

    expect(proportion).toBe(0)
    vi.restoreAllMocks()
  })
})

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
