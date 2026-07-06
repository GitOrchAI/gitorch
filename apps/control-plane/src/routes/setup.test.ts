import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { setupRoutes } from './setup.js'
import type { EngineConnectionService } from '../services/engine-connection.js'

describe('GET /api/v1/github/repos', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let getRawGithubToken: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    getRawGithubToken = vi.fn().mockResolvedValue('gh_encrypted_roundtrip_token')

    app = Fastify()
    app.decorate('engineConnections', {
      getRawGithubToken,
    } as unknown as EngineConnectionService)
    // Simula o hook global de auth já tendo populado request.user (cookie ou
    // Bearer) — o token do GitHub em si NÃO vem mais daqui (spec §17.4).
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('fetches repos using the token decrypted from the user vault, not the session', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          {
            id: 1,
            name: 'repo',
            full_name: 'octocat/repo',
            description: null,
            private: false,
            html_url: 'https://github.com/octocat/repo',
          },
        ]),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall).toBeDefined()
    const headers = fetchCall?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer gh_encrypted_roundtrip_token')
  })

  it('returns 401 when the user has no connected github token', async () => {
    getRawGithubToken.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /api/v1/setup/submit — runtime wiring', () => {
  let app: ReturnType<typeof Fastify>
  let projectCreate: ReturnType<typeof vi.fn>
  let engineConnectionFindMany: ReturnType<typeof vi.fn> &
    ((userId: string) => Promise<Array<{ runtime: string; status: string }>>)

  beforeEach(async () => {
    projectCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'proj_1',
      wingId: data.wingId,
      name: data.name,
      isActive: true,
      runtimeConfig: data.runtimeConfig,
    }))
    engineConnectionFindMany = vi.fn().mockResolvedValue([
      { runtime: 'claude', status: 'connected' },
      { runtime: 'codex', status: 'error' },
    ]) as typeof engineConnectionFindMany

    app = Fastify()
    app.decorate('engineConnections', {
      list: async (userId: string) => {
        const rows = (await engineConnectionFindMany(userId)) as Array<{
          runtime: string
          status: string
        }>
        return rows.map((r) => ({
          ...r,
          modelsRefreshedAt: null,
          lastValidatedAt: null,
          lastError: null,
        }))
      },
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test', plan: null }),
      },
      project: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        create: projectCreate,
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('maps claude-code to claude and writes runtimeConfig.agents for every role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })

    expect(res.statusCode).toBe(200)
    const createCall = projectCreate.mock.calls[0]![0] as {
      data: { runtimeConfig: { agents: Record<string, { runtime: string }> } }
    }
    const agents = createCall.data.runtimeConfig.agents
    for (const role of ['po', 'ra', 'sm', 'qa']) {
      expect(agents[role]?.runtime).toBe('claude')
    }
  })

  it('rejects submit when none of the selected engines is actually connected', async () => {
    engineConnectionFindMany.mockResolvedValue([{ runtime: 'codex', status: 'error' }])
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })
    expect(res.statusCode).toBe(400)
    expect(projectCreate).not.toHaveBeenCalled()
  })
})
