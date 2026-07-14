import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { setupRoutes } from './setup.js'

// A VERDADE do provisionamento. O passo final do wizard não pode inventar
// sucesso: quem sabe se o ambiente subiu é a missão `clone_and_start_engines`
// no banco (pending -> running -> completed/failed, processada pelo scheduler),
// não a lista de motores (que já nasce "connected" no login e sempre diria
// "pronto" no primeiro poll — a tautologia que estas rotas eliminam).

interface MissionRow {
  id: string
  projectId: string
  type: string
  status: string
  error: string | null
  payload: Record<string, unknown>
  createdAt: Date
  project: { id: string; wingId: string }
}

interface StatusBody {
  status: string
  error: string | null
  missions: Array<{ projectId: string; wingId: string; status: string; error: string | null }>
  environment: { id: string; status: string } | null
}

interface MissionWhere {
  type?: string
  status?: unknown
  projectId?: { in: string[] }
  project?: { userId: string }
}

const missionRow = (over: Partial<MissionRow> = {}): MissionRow => ({
  id: 'm_1',
  projectId: 'proj_1',
  type: 'clone_and_start_engines',
  status: 'pending',
  error: null,
  payload: { repoUrl: 'https://github.com/octocat/repo', engines: ['claude-code'] },
  createdAt: new Date('2026-07-14T12:00:00Z'),
  project: { id: 'proj_1', wingId: 'octocat/repo' },
  ...over,
})

describe('GET /api/v1/setup/status', () => {
  let app: ReturnType<typeof Fastify>
  let missionFindMany: ReturnType<typeof vi.fn>
  let environmentFindFirst: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    missionFindMany = vi.fn().mockResolvedValue([])
    environmentFindFirst = vi.fn().mockResolvedValue({
      id: 'env_1',
      userId: 'user_1',
      status: 'fixed',
      path: '/caminho/interno/que/nunca/pode/vazar/env_1',
      fixedAt: new Date('2026-07-14T12:00:00Z'),
      createdAt: new Date('2026-07-14T11:00:00Z'),
      updatedAt: new Date('2026-07-14T12:00:00Z'),
    })

    app = Fastify()
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test' }),
      },
      mission: { findMany: missionFindMany, create: vi.fn().mockResolvedValue({}) },
      clientEnvironment: { findFirst: environmentFindFirst },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  const get = async (url = '/api/v1/setup/status'): Promise<StatusBody> => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    return res.json() as StatusBody
  }

  it('missão pendente -> pending (o wizard mostra "provisionando", nunca ✓)', async () => {
    missionFindMany.mockResolvedValue([missionRow({ status: 'pending' })])
    const body = await get()
    expect(body.status).toBe('pending')
    expect(body.error).toBeNull()
    expect(body.missions).toEqual([
      { projectId: 'proj_1', wingId: 'octocat/repo', status: 'pending', error: null },
    ])
  })

  it('missão em andamento -> running (o scheduler pegou; ainda não acabou)', async () => {
    missionFindMany.mockResolvedValue([missionRow({ status: 'running' })])
    expect((await get()).status).toBe('running')
  })

  it('missão concluída -> completed (só AQUI o ambiente está de fato ativo)', async () => {
    missionFindMany.mockResolvedValue([missionRow({ status: 'completed' })])
    const body = await get()
    expect(body.status).toBe('completed')
    expect(body.error).toBeNull()
  })

  it('missão falhou -> failed COM a causa real (o cliente sabe o que aconteceu)', async () => {
    missionFindMany.mockResolvedValue([
      missionRow({ status: 'failed', error: 'git clone falhou: repositório não encontrado' }),
    ])
    const body = await get()
    expect(body.status).toBe('failed')
    expect(body.error).toBe('git clone falhou: repositório não encontrado')
    expect(body.missions[0]?.error).toBe('git clone falhou: repositório não encontrado')
  })

  it('falha vence sucesso parcial: um repo ok + um quebrado ainda é failed', async () => {
    missionFindMany.mockResolvedValue([
      missionRow({ id: 'm_2', projectId: 'proj_2', status: 'completed' }),
      missionRow({
        id: 'm_1',
        projectId: 'proj_1',
        status: 'failed',
        error: 'sem espaço em disco',
      }),
    ])
    const body = await get()
    expect(body.status).toBe('failed')
    expect(body.error).toBe('sem espaço em disco')
  })

  it('falha sem texto de erro -> error null (a UI cai num texto localizado, não numa mentira)', async () => {
    missionFindMany.mockResolvedValue([missionRow({ status: 'failed', error: null })])
    const body = await get()
    expect(body.status).toBe('failed')
    expect(body.error).toBeNull()
  })

  it('pendente vence concluída: um repo pronto e outro na fila ainda é "provisionando"', async () => {
    missionFindMany.mockResolvedValue([
      missionRow({ id: 'm_2', projectId: 'proj_2', status: 'completed' }),
      missionRow({ id: 'm_1', projectId: 'proj_1', status: 'pending' }),
    ])
    expect((await get()).status).toBe('pending')
  })

  it('running vence pending quando não há falha (o mais avançado que ainda trabalha)', async () => {
    missionFindMany.mockResolvedValue([
      missionRow({ id: 'm_2', projectId: 'proj_2', status: 'running' }),
      missionRow({ id: 'm_1', projectId: 'proj_1', status: 'pending' }),
    ])
    expect((await get()).status).toBe('running')
  })

  it('nenhuma missão -> unknown (não inventa sucesso nem fracasso)', async () => {
    missionFindMany.mockResolvedValue([])
    const body = await get()
    expect(body.status).toBe('unknown')
    expect(body.missions).toEqual([])
  })

  it('só a missão MAIS RECENTE de cada projeto conta (senão uma falha velha assombra pra sempre)', async () => {
    // findMany devolve em createdAt desc: a nova (completed) vem antes da velha.
    missionFindMany.mockResolvedValue([
      missionRow({
        id: 'm_novo',
        status: 'completed',
        createdAt: new Date('2026-07-14T13:00:00Z'),
      }),
      missionRow({
        id: 'm_velho',
        status: 'failed',
        error: 'falha antiga já superada',
        createdAt: new Date('2026-07-10T09:00:00Z'),
      }),
    ])
    const body = await get()
    expect(body.status).toBe('completed')
    expect(body.error).toBeNull()
    expect(body.missions).toHaveLength(1)
  })

  it('escopo pelo DONO resolvido por e-mail e pelo tipo da missão do wizard', async () => {
    await get()
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.type).toBe('clone_and_start_engines')
    expect(where.project).toEqual({ userId: 'owner_1' })
  })

  it('?projects= restringe ao submit atual (projetos de outrem não entram: o escopo do dono é mantido)', async () => {
    await get('/api/v1/setup/status?projects=proj_2,proj_3')
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.projectId).toEqual({ in: ['proj_2', 'proj_3'] })
    expect(where.project).toEqual({ userId: 'owner_1' })
  })

  it('?projects= vazio é ignorado (não vira um filtro impossível)', async () => {
    await get('/api/v1/setup/status?projects=')
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.projectId).toBeUndefined()
  })

  it('estado de missão que não conhecemos -> unknown (nunca chuta ✓)', async () => {
    missionFindMany.mockResolvedValue([missionRow({ status: 'cancelled' })])
    expect((await get()).status).toBe('unknown')
  })

  it('dono não encontrado por e-mail -> cai no id da sessão (não vaza missão de ninguém)', async () => {
    app.prisma.user.findUnique = vi.fn().mockResolvedValue(null)
    await get()
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.project).toEqual({ userId: 'user_1' })
  })

  it('devolve o ambiente do cliente, mas o caminho em disco NUNCA vaza', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    const body = res.json() as StatusBody
    expect(body.environment).toEqual({ id: 'env_1', status: 'fixed' })
    expect(res.payload).not.toContain('/caminho/interno')
    expect(res.payload).not.toContain('path')
  })

  it('sem ambiente registrado -> environment null (sem fingir)', async () => {
    environmentFindFirst.mockResolvedValue(null)
    expect((await get()).environment).toBeNull()
  })
})

describe('GET /api/v1/setup/status — sessão ausente', () => {
  it('401 sem sessão (o estado do provisionamento é de quem é dono dele)', async () => {
    const app = Fastify()
    app.decorate('prisma', {
      user: { findUnique: vi.fn() },
      mission: { findMany: vi.fn() },
      clientEnvironment: { findFirst: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await setupRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/v1/setup/status — sessão legada sem e-mail', () => {
  it('sem e-mail na sessão, escopa pelo id da sessão sem nem consultar o dono', async () => {
    const app = Fastify()
    const missionFindMany = vi.fn().mockResolvedValue([])
    const userFindUnique = vi.fn()
    app.decorate('prisma', {
      user: { findUnique: userFindUnique },
      mission: { findMany: missionFindMany },
      clientEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'legacy_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/status' })

    expect(res.statusCode).toBe(200)
    expect(userFindUnique).not.toHaveBeenCalled()
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.project).toEqual({ userId: 'legacy_1' })
  })
})

describe('POST /api/v1/setup/retry', () => {
  let app: ReturnType<typeof Fastify>
  let missionFindMany: ReturnType<typeof vi.fn>
  let missionCreate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    missionFindMany = vi.fn().mockResolvedValue([])
    missionCreate = vi.fn().mockResolvedValue({})

    app = Fastify()
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test' }),
      },
      mission: { findMany: missionFindMany, create: missionCreate },
      clientEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('reenfileira uma missão NOVA com o mesmo payload (nunca ressuscita a velha)', async () => {
    // Ressuscitar a linha antiga (status <- pending) seria um tiro no pé: o
    // sweeper do scheduler mata como "presa" qualquer pending com createdAt
    // além do PENDING_TIMEOUT_MS — a retentativa "falharia" na hora.
    const failed = missionRow({
      status: 'failed',
      error: 'git clone falhou',
      payload: { repoUrl: 'https://github.com/octocat/repo', engines: ['claude-code'] },
    })
    missionFindMany.mockResolvedValue([failed])

    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/retry', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ retried: 1 })
    expect(missionCreate).toHaveBeenCalledWith({
      data: {
        projectId: 'proj_1',
        type: 'clone_and_start_engines',
        payload: { repoUrl: 'https://github.com/octocat/repo', engines: ['claude-code'] },
        status: 'pending',
      },
    })
  })

  it('busca só as missões FALHAS do dono (nunca as de outro usuário)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/setup/retry', payload: {} })
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.type).toBe('clone_and_start_engines')
    expect(where.status).toBe('failed')
    expect(where.project).toEqual({ userId: 'owner_1' })
  })

  it('nada falhou -> não cria missão nenhuma (retried: 0)', async () => {
    missionFindMany.mockResolvedValue([])
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/retry', payload: {} })
    expect(res.json()).toEqual({ retried: 0 })
    expect(missionCreate).not.toHaveBeenCalled()
  })

  it('reenfileira só os projetos pedidos no corpo', async () => {
    missionFindMany.mockResolvedValue([])
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/retry',
      payload: { projects: ['proj_2'] },
    })
    const where = missionFindMany.mock.calls[0]?.[0]?.where as MissionWhere
    expect(where.projectId).toEqual({ in: ['proj_2'] })
  })

  it('só a falha MAIS RECENTE de cada projeto vira retentativa (não duplica missão)', async () => {
    missionFindMany.mockResolvedValue([
      missionRow({ id: 'm_2', status: 'failed', error: 'falha nova' }),
      missionRow({ id: 'm_1', status: 'failed', error: 'falha velha' }),
    ])
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/retry', payload: {} })
    expect(res.json()).toEqual({ retried: 1 })
    expect(missionCreate).toHaveBeenCalledTimes(1)
  })

  it('401 sem sessão', async () => {
    const anon = Fastify()
    anon.decorate('prisma', {
      user: { findUnique: vi.fn() },
      mission: { findMany: vi.fn(), create: vi.fn() },
      clientEnvironment: { findFirst: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await setupRoutes(anon)
    await anon.ready()

    const res = await anon.inject({ method: 'POST', url: '/api/v1/setup/retry', payload: {} })
    expect(res.statusCode).toBe(401)
  })
})
