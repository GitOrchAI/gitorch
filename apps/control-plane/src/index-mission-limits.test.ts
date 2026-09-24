import { describe, expect, it, beforeEach, vi } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { _resetSpendGuardReservationsForTesting } from './lib/spend-guard.js'
import { authPlugin } from './plugins/auth.js'
import rateLimit from '@fastify/rate-limit'

const JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long'
process.env['JWT_SECRET'] = JWT_SECRET

describe('Mission endpoints limits', () => {
  let mockPlan = {
    id: 'plan_1',
    maxMissionsPerDay: 5,
    features: { maxTokensPerMonth: 50000 },
    maxConcurrentMissions: 2,
    maxProjects: 1,
    seats: 1,
  }

  let app: ReturnType<typeof Fastify> & { prisma: unknown }

  beforeEach(async () => {
    _resetSpendGuardReservationsForTesting()
    app = Fastify()

    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockImplementation(async (args: { where: { id: string } }) => {
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
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: 'p1', name: 'Project 1' }),
      },
    })

    await app.register(rateLimit, { global: true, max: 20 })
    await app.register(fastifyCookie)
    await app.register(authPlugin)

    app.addHook(
      'preHandler',
      async (
        request: FastifyRequest & { user?: { id: string; wingId?: string } },
        reply: import('fastify').FastifyReply
      ) => {
        try {
          if (
            !['/api/missions/trigger', '/api/missions/agent-run'].includes(
              request.routeOptions?.url || request.url || ''
            )
          ) {
            return
          }

          const user = request.user
          if (!user) return

          const userId = user.id

          if (typeof app.prisma?.user?.findUnique !== 'function') return
          if (typeof app.prisma?.mission?.count !== 'function') return

          const dbUser = await app.prisma.user.findUnique({
            where: { id: userId },
            include: { plan: true },
          })
          if (!dbUser || !dbUser.plan) return

          const { canExecuteMissionToday } = await import('./lib/entitlements.js')
          const { canExecuteMission, reserveMissionTokens, TOKENS_RESERVE_ESTIMATE } =
            await import('./lib/spend-guard.js')

          const plan = dbUser.plan

          const startOfDay = new Date()
          startOfDay.setHours(0, 0, 0, 0)

          const totalHoje = await app.prisma.mission.count({
            where: {
              createdAt: { gte: startOfDay },
              project: { userId },
            },
          })

          if (!canExecuteMissionToday(plan, totalHoje)) {
            reply.code(402).send({
              error: 'spend_limit_exceeded',
              details: 'Daily mission limit exceeded for your plan',
            })
            return reply
          }

          const features = plan.features ?? {}
          const tokenBudget =
            typeof features['maxTokensPerMonth'] === 'number' ? features['maxTokensPerMonth'] : null

          if (tokenBudget) {
            if (typeof app.prisma?.mission?.aggregate !== 'function') return

            const startOfMonth = new Date()
            startOfMonth.setDate(1)
            startOfMonth.setHours(0, 0, 0, 0)

            const agg = await app.prisma.mission.aggregate({
              where: { createdAt: { gte: startOfMonth }, project: { userId } },
              _sum: { tokensUsed: true },
            })
            const tokensSpent = agg._sum.tokensUsed ?? 0

            if (!canExecuteMission(userId, TOKENS_RESERVE_ESTIMATE, tokenBudget, tokensSpent)) {
              reply
                .code(402)
                .send({ error: 'spend_limit_exceeded', details: 'Monthly token budget exceeded' })
              return reply
            }

            reserveMissionTokens(userId, TOKENS_RESERVE_ESTIMATE)
          }
        } catch (e) {
          request.log.error(e)
          throw e
        }
      }
    )

    app.post(
      '/api/missions/trigger',
      async (_req: FastifyRequest, rep: import('fastify').FastifyReply) => rep.send({ ok: true })
    )
    app.post(
      '/api/missions/agent-run',
      async (_req: FastifyRequest, rep: import('fastify').FastifyReply) => rep.send({ ok: true })
    )
  })

  it('returns 402 when daily missions limit is exceeded', async () => {
    app.prisma.mission.count.mockResolvedValue(5) // reached limit

    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, JWT_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/trigger',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId: 'p1', type: 'test', payload: {} },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json().error).toBe('spend_limit_exceeded')
    expect(res.json().details).toContain('Daily mission limit exceeded')
  })

  it('returns 402 when monthly token budget is exceeded', async () => {
    app.prisma.mission.count.mockResolvedValue(0)
    app.prisma.mission.aggregate.mockResolvedValue({ _sum: { tokensUsed: 45000 } }) // 45000 + 10000 > 50000

    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, JWT_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/agent-run',
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'po' },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json().error).toBe('spend_limit_exceeded')
    expect(res.json().details).toContain('Monthly token budget exceeded')
  })
})
