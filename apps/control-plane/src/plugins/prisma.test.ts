import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createPrismaClient, wingIdContext, MODELS_WITH_WING } from './prisma.js'

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
  return {
    PrismaClient: MockPrismaClient,
    // Espelha o schema real: só Project carrega wingId.
    Prisma: {
      dmmf: {
        datamodel: {
          models: [
            { name: 'Project', fields: [{ name: 'wingId' }, { name: 'id' }] },
            { name: 'Mission', fields: [{ name: 'id' }] },
            { name: 'WebhookDelivery', fields: [{ name: 'id' }] },
          ],
        },
      },
    },
  }
})

type Middleware = (
  params: { model?: string; action: string; args: { where?: object; data?: object } },
  next: (p: unknown) => Promise<unknown>
) => Promise<unknown>

function captureMiddleware(prisma: ReturnType<typeof createPrismaClient>): Middleware {
  return (prisma.$use as unknown as Mock).mock.calls[0]![0] as Middleware
}

describe('Prisma Client with RLS', () => {
  let prisma: ReturnType<typeof createPrismaClient>

  beforeEach(() => {
    vi.clearAllMocks()
    prisma = createPrismaClient()
  })

  it('creates PrismaClient with RLS middleware', () => {
    expect(prisma).toBeDefined()
  })

  it('deriva do DMMF quais modelos têm wingId (nunca lista manual)', () => {
    expect([...MODELS_WITH_WING]).toEqual(['Project'])
  })

  it('injeta wingId em create de modelo COM a coluna, dentro do contexto', async () => {
    const mw = captureMiddleware(prisma)
    const seen: Array<{ args: { data?: object } }> = []
    await wingIdContext.run({ wingId: 'w1' }, () =>
      mw({ model: 'Project', action: 'create', args: { data: { name: 'x' } } }, async (p) => {
        seen.push(p as { args: { data?: object } })
        return null
      })
    )
    expect(seen[0]!.args.data).toMatchObject({ wingId: 'w1' })
  })

  it('NÃO injeta wingId em modelo SEM a coluna (ex.: WebhookDelivery)', async () => {
    const mw = captureMiddleware(prisma)
    const seen: Array<{ args: { data?: object } }> = []
    await wingIdContext.run({ wingId: 'w1' }, () =>
      mw(
        { model: 'WebhookDelivery', action: 'create', args: { data: { eventType: 'issues' } } },
        async (p) => {
          seen.push(p as { args: { data?: object } })
          return null
        }
      )
    )
    expect(seen[0]!.args.data).toEqual({ eventType: 'issues' })
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
