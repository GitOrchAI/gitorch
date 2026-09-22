import { describe, expect, it, beforeEach, vi } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { authPlugin } from './auth.js'
import rateLimit from '@fastify/rate-limit'

const JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long'
process.env['JWT_SECRET'] = JWT_SECRET

describe('Mission endpoints limits in Auth Plugin', () => {
  let mockPlan = {
    id: 'plan_1',
    maxMissionsPerDay: 5,
    features: { maxTokensPerMonth: 50000 },
    maxConcurrentMissions: 2,
    maxProjects: 1,
    seats: 1,
  }

  let app: ReturnType<typeof Fastify> & {
    prisma: {
      user: { findUnique: unknown }
      mission: { count: unknown; aggregate: unknown }
      apiKey: { findMany: unknown; update: unknown }
    }
  }

  beforeEach(async () => {
    app = Fastify()

    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockImplementation(async (args) => {
          if (args.where.id === 'user_123') {
            return { id: 'user_123', plan: mockPlan }
          }
          return null
        }),
      },
      mission: { count: vi.fn(), aggregate: vi.fn() },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'k1',
            keyHash: 'fake_hash',
            projectId: 'p1',
            isActive: true,
            project: { wingId: 'wing_123', userId: 'user_123', isActive: true },
            scopes: ['all'],
          },
        ]),
        update: vi.fn(),
      },
    })

    await app.register(rateLimit, { global: true, max: 20 })
    await app.register(fastifyCookie)
    await app.register(authPlugin)

    app.post(
      '/api/missions/trigger',
      async (_req: FastifyRequest, rep: import('fastify').FastifyReply) => rep.send({ ok: true })
    )
  })

  it('returns 403 when daily missions limit is exceeded', async () => {
    app.prisma.mission.count.mockResolvedValue(5) // reached limit

    // Test with JWT as it's correctly mapped by resolveScope to \`request.user\`
    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, JWT_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/trigger',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId: 'p1', type: 'test', payload: {} },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('Daily mission limit exceeded')
  })

  it('returns 403 when monthly token budget is exceeded', async () => {
    app.prisma.mission.count.mockResolvedValue(0)
    app.prisma.mission.aggregate.mockResolvedValue({ _sum: { tokensUsed: 45000 } }) // 45000 + 10000 > 50000

    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, JWT_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/trigger',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId: 'p1', type: 'test', payload: {} },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('Monthly token budget exceeded')
  })
})
