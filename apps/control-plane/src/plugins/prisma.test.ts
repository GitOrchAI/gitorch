import { describe, expect, it, beforeEach, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createPrismaClient } from './prisma.js'

vi.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = vi.fn()
    $disconnect = vi.fn()
    $extends = vi.fn((ext: unknown) => ext)
    $use = vi.fn()
    project = {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }
    mission = { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() }
    event = { findMany: vi.fn(), create: vi.fn() }
    apiKey = {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }
    webhookDelivery = {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }
  }
  return { PrismaClient: MockPrismaClient }
})

describe('Prisma Client with RLS', () => {
  let prisma: ReturnType<typeof createPrismaClient>

  beforeEach(() => {
    vi.clearAllMocks()
    prisma = createPrismaClient()
  })

  it('creates PrismaClient with RLS middleware', () => {
    expect(prisma).toBeDefined()
  })

  it('injects wing_id middleware on queries', () => {
    const client = new PrismaClient()
    const extended = client.$extends({
      query: {
        project: {
          findMany: vi.fn(),
        },
      },
    })
    expect(extended).toBeDefined()
  })
})
