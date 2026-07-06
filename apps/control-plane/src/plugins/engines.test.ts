import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import Fastify, { FastifyRequest } from 'fastify'
import { enginesPlugin } from './engines.js'

describe('POST /api/v1/engines/:runtime/token', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    app = Fastify()
    app.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user_1' }) },
      engineConnection: {
        upsert: vi.fn().mockResolvedValue({
          runtime: 'claude',
          status: 'connected',
          modelsRefreshedAt: null,
          lastValidatedAt: new Date(),
          lastError: null,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await app.register(enginesPlugin)
    await app.ready()
  })

  it('connects claude via a pasted setup-token (env credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: { token: 'sk-ant-oat01-FAKE' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
    expect(app.prisma.engineConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ credentialKind: 'env' }),
      })
    )
  })

  it('connects codex via pasted auth.json content (file credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/token',
      payload: { token: JSON.stringify({ auth_mode: 'chatgpt' }) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
  })

  it('connects antigravity via pasted oauth-token content (file credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/antigravity/token',
      payload: { token: 'oauth-token-fake' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
  })

  it('rejects an unsupported runtime with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/nonsense/token',
      payload: { token: 'whatever' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing token with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 401 without a session', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: { token: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })
})
