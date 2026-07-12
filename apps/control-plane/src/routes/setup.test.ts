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

describe('GET /api/v1/github/repos — sem o plugin de motores registrado', () => {
  it('retorna um 500 limpo em vez de vazar o TypeError interno pro cliente', async () => {
    const app = Fastify()
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })
    expect(res.statusCode).toBe(500)
    const body = res.json() as { message?: string; error?: string }
    const leaked = `${body.message ?? ''} ${body.error ?? ''}`
    expect(leaked).not.toContain('getRawGithubToken')
    expect(leaked).not.toContain('Cannot read properties')
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
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 2 }) },
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
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
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

  it('checks connected engines under the resolved owner.id, not the raw session claim, when they differ', async () => {
    // Sessão com um userId diferente do id real do dono (ex.: cookie emitido
    // antes de uma correção de id) — EngineConnection sempre foi gravado sob
    // o id resolvido por e-mail (owner.id), então é esse que tem que ser usado
    // pra achar o motor conectado, senão o gate bloqueia um dono já conectado.
    app.prisma.user.findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'owner_real_cuid', email: 'octocat@example.test', plan: null })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })

    expect(engineConnectionFindMany).toHaveBeenCalledWith('owner_real_cuid')
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/setup/submit — coleta de contexto: board Projects V2 não duplica em re-submit', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let byWingId: Map<string, { id: string; wingId: string; name: string; runtimeConfig: unknown }>
  let cortexWriteDrawer: ReturnType<typeof vi.fn>

  // Roteia o `fetch` GraphQL pelo conteúdo da query — mesma técnica usada nos
  // testes de repo-context-collector/repo-context-cortex, mas aqui contra o
  // `global.fetch` de verdade: setup.ts não injeta um transporte de teste,
  // então é o único jeito de exercitar o fluxo INTEIRO (rota → collector →
  // GraphQL) sem bater na rede real.
  function stubGithubGraphQL(handlers: { boardNumberCreated: number }): typeof fetch {
    return vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { query: string }
      if (body.query.includes('RepoOwner')) {
        return new Response(
          JSON.stringify({
            data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } },
          }),
          { status: 200 }
        )
      }
      if (body.query.includes('GetProjectId')) {
        // Só é chamada quando um boardNumber já é conhecido (reuse) — devolve
        // o MESMO board criado na 1ª rodada.
        return new Response(
          JSON.stringify({ data: { user: { projectV2: { id: 'PVT_reused' } } } }),
          { status: 200 }
        )
      }
      if (body.query.includes('CreateProjectV2')) {
        return new Response(
          JSON.stringify({
            data: {
              createProjectV2: {
                projectV2: { id: 'PVT_created', number: handlers.boardNumberCreated },
              },
            },
          }),
          { status: 200 }
        )
      }
      if (body.query.includes('RepoContext')) {
        return new Response(
          JSON.stringify({
            data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
          }),
          { status: 200 }
        )
      }
      throw new Error(`stub sem handler para a query:\n${body.query}`)
    }) as unknown as typeof fetch
  }

  beforeEach(async () => {
    byWingId = new Map()
    let nextId = 1
    cortexWriteDrawer = vi.fn().mockResolvedValue(undefined)

    app = Fastify()
    app.decorate('cortex', { writeDrawer: cortexWriteDrawer } as never)
    app.decorate('engineConnections', {
      list: async () => [
        {
          runtime: 'claude',
          status: 'connected',
          modelsRefreshedAt: null,
          lastValidatedAt: null,
          lastError: null,
        },
      ],
      getRawGithubToken: async () => 'gh_test_token',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.decorate('prisma', {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test', plan: null }),
      },
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 2 }) },
      project: {
        count: vi.fn().mockResolvedValue(0),
        // Stateful: reflete o estado real entre os dois submits do teste — é
        // isso que prova a idempotência (2º submit ACHA o project do 1º).
        findFirst: vi.fn(async ({ where }: { where: { wingId: string } }) => {
          return byWingId.get(where.wingId) ?? null
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const rec = {
            id: `proj_${nextId++}`,
            wingId: data['wingId'] as string,
            name: data['name'] as string,
            runtimeConfig: data['runtimeConfig'],
          }
          byWingId.set(rec.wingId, rec)
          return rec
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const rec = [...byWingId.values()].find((p) => p.id === where.id)
            if (rec) Object.assign(rec, data)
            return rec
          }
        ),
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('2 submits do mesmo repo: só o 1º cria o board GitHub; o 2º reusa via runtimeConfig persistido', async () => {
    global.fetch = stubGithubGraphQL({ boardNumberCreated: 42 })

    const payload = { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' }

    const first = await app.inject({ method: 'POST', url: '/api/v1/setup/submit', payload })
    expect(first.statusCode).toBe(200)

    const fetchCalls1 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const queriesRound1 = fetchCalls1.map((c) => (JSON.parse(c[1].body) as { query: string }).query)
    expect(queriesRound1.some((q) => q.includes('CreateProjectV2'))).toBe(true)
    expect(queriesRound1.some((q) => q.includes('GetProjectId'))).toBe(false)

    // O board criado (número 42) foi persistido no Project.
    const project = byWingId.get('octocat/repo')
    expect((project?.runtimeConfig as { githubBoardNumber?: number })?.githubBoardNumber).toBe(42)

    // 2ª submissão do MESMO repo (reabrir/refinalizar o wizard) — a rota deve
    // ler o boardNumber persistido e REUSAR, não criar um board novo.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockClear()
    const second = await app.inject({ method: 'POST', url: '/api/v1/setup/submit', payload })
    expect(second.statusCode).toBe(200)

    const fetchCalls2 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const queriesRound2 = fetchCalls2.map((c) => (JSON.parse(c[1].body) as { query: string }).query)
    expect(queriesRound2.some((q) => q.includes('GetProjectId'))).toBe(true)
    expect(queriesRound2.some((q) => q.includes('CreateProjectV2'))).toBe(false)

    // Só 1 Project foi criado no total (2ª submissão reusou o registro).
    expect(byWingId.size).toBe(1)
  })
})

describe('POST /api/v1/setup/submit — plano autoritativo (paid-intent, ainda não pago)', () => {
  let app: ReturnType<typeof Fastify>
  let projectCreate: ReturnType<typeof vi.fn>
  let planFindUnique: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    projectCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'proj_1',
      wingId: data.wingId,
      name: data.name,
      isActive: true,
      runtimeConfig: data.runtimeConfig,
    }))
    // Plano REAL do dono no banco (schema default): 'free', maxProjects 1 —
    // ainda não subiu porque o webhook do Stripe só roda após o pagamento.
    const freePlan = { id: 'free', maxProjects: 1, features: {} }
    planFindUnique = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'team' ? { id: 'team', maxProjects: 10, features: {} } : null
      )

    app = Fastify()
    app.decorate('engineConnections', {
      list: async () => [{ runtime: 'claude', status: 'connected' }],
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'owner_1',
          email: 'octocat@example.test',
          plan: freePlan,
        }),
      },
      plan: { findUnique: planFindUnique },
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
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('permite múltiplos repos quando o cliente veio de ?plan=team, mesmo o dono ainda estando no free no banco', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2', 'octocat/repo3'],
        engines: ['claude-code'],
        plan: 'team',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(projectCreate).toHaveBeenCalledTimes(3)
  })

  it('rejeita um plano inventado pelo cliente que não existe no banco (cai no teto free)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2'],
        engines: ['claude-code'],
        plan: 'plano-fake-inventado',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(projectCreate).not.toHaveBeenCalled()
  })

  it('cliente JÁ pagante (plano real pro) reabrindo o wizard sem ?plan= mantém o teto real, não o do free', async () => {
    // Front usa 'free' como default quando não há ?plan= na URL — um cliente
    // que já paga não pode ser rebaixado ao teto do free só por isso.
    app.prisma.user.findUnique = vi.fn().mockResolvedValue({
      id: 'owner_1',
      email: 'octocat@example.test',
      plan: { id: 'pro', maxProjects: 5 },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2'],
        engines: ['claude-code'],
        plan: 'free',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(projectCreate).toHaveBeenCalledTimes(2)
  })
})
