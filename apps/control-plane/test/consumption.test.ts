import { describe, it, expect, vi } from 'vitest'
import { recordGuestConsumption, verificarQuotaDoConvidado } from '../src/lib/consumption.js'
import type { PrismaClient } from '@prisma/client'

// Mock dependencies
vi.mock('../src/plugins/prisma.js', () => ({
  incrementGuestUsedQuota: vi.fn().mockResolvedValue({
    id: 'guest-123',
    usedQuota: 15,
    executionLimits: { maxQuota: 100 },
  }),
}))

describe('recordGuestConsumption', () => {
  it('increments by delta and calculates proportion', async () => {
    const mockPrisma = {} as unknown as PrismaClient
    const result = await recordGuestConsumption('guest-123', mockPrisma, 1)

    expect(result.usedQuota).toBe(15)
    expect(result.guestQuota).toBe(100)
    expect(result.proportion).toBe(0.15)
  })
})

describe('verificarQuotaDoConvidado', () => {
  it('returns true if no limit is set', async () => {
    const mockPrisma = {
      projectInvitation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'guest-123',
          usedQuota: 15,
          executionLimits: {}, // No maxQuota
        }),
      },
    } as unknown as PrismaClient

    const result = await verificarQuotaDoConvidado('guest-123', mockPrisma)
    expect(result).toBe(true)
  })

  it('returns true if usedQuota < maxQuota', async () => {
    const mockPrisma = {
      projectInvitation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'guest-123',
          usedQuota: 15,
          executionLimits: { maxQuota: 100 },
        }),
      },
    } as unknown as PrismaClient

    const result = await verificarQuotaDoConvidado('guest-123', mockPrisma)
    expect(result).toBe(true)
  })

  it('returns false if usedQuota >= maxQuota', async () => {
    const mockPrisma = {
      projectInvitation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'guest-123',
          usedQuota: 100,
          executionLimits: { maxQuota: 100 },
        }),
      },
    } as unknown as PrismaClient

    const result = await verificarQuotaDoConvidado('guest-123', mockPrisma)
    expect(result).toBe(false)
  })
})
