import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import type { EngineConnectionService } from '../services/engine-connection.js'

// Evita spawn real de processo/rede em teste de rota — só verifica o
// contrato HTTP (201/202/401/400/404 + shape). A lógica de orquestração já
// tem TDD dedicado em free-diagnosis.test.ts.
const processDiagnosisJob = vi.fn(
  async (_id: string, _args: unknown, _deps: unknown): Promise<void> => undefined
)
vi.mock('../services/free-diagnosis.js', () => ({
  processDiagnosisJob: (id: string, args: unknown, deps: unknown) =>
    processDiagnosisJob(id, args, deps),
}))

const { diagnoseRoutes } = await import('./diagnose.js')

interface FakePrisma {
  diagnosisJob: {
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
}

function buildApp(prisma: FakePrisma, getRawGithubToken: ReturnType<typeof vi.fn>) {
  const app = Fastify()
  app.decorate('prisma', prisma as never)
  app.decorate('engineConnections', { getRawGithubToken } as unknown as EngineConnectionService)
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { id: 'user_1', wingId: 'octocat' }
  })
  return app
}

describe('POST /api/v1/diagnose', () => {
  let getRawGithubToken: ReturnType<typeof vi.fn>
  let prisma: FakePrisma

  beforeEach(() => {
    processDiagnosisJob.mockClear()
    getRawGithubToken = vi.fn().mockResolvedValue('gh_token')
    prisma = {
      diagnosisJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'job_1', status: 'pending' }),
      },
    }
  })

  it('cria o job, dispara o processamento e responde 202 na hora (não espera o clone)', async () => {
    const app = buildApp(prisma, getRawGithubToken)
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnose',
      payload: { repo: 'acme/loja' },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ id: 'job_1', status: 'pending' })
    expect(prisma.diagnosisJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: 'user_1', repoFullName: 'acme/loja', status: 'pending' },
      })
    )
    expect(processDiagnosisJob).toHaveBeenCalledWith(
      'job_1',
      { userId: 'user_1', repoFullName: 'acme/loja', githubToken: 'gh_token' },
      expect.anything()
    )
  })

  it('reaproveita job pending/running existente (idempotente — não clona 2x)', async () => {
    prisma.diagnosisJob.findFirst.mockResolvedValue({ id: 'job_prev', status: 'running' })
    const app = buildApp(prisma, getRawGithubToken)
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnose',
      payload: { repo: 'acme/loja' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'job_prev', status: 'running' })
    expect(prisma.diagnosisJob.create).not.toHaveBeenCalled()
    expect(processDiagnosisJob).not.toHaveBeenCalled()
  })

  it('rejeita repo mal formatado (400)', async () => {
    const app = buildApp(prisma, getRawGithubToken)
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnose',
      payload: { repo: 'não-é-owner-slash-repo' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('sem sessão -> 401', async () => {
    const app = Fastify()
    app.decorate('prisma', prisma as never)
    app.decorate('engineConnections', { getRawGithubToken } as unknown as EngineConnectionService)
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnose',
      payload: { repo: 'acme/loja' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('sem GitHub conectado -> 401', async () => {
    getRawGithubToken.mockResolvedValue(null)
    const app = buildApp(prisma, getRawGithubToken)
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnose',
      payload: { repo: 'acme/loja' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/v1/diagnose/:id', () => {
  it('devolve o job só do DONO (ownership) e 404 se não achar/for de outro usuário', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { diagnosisJob: { findFirst, create: vi.fn() } }
    const app = buildApp(prisma, vi.fn())
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnose/job_x' })
    expect(res.statusCode).toBe(404)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job_x', userId: 'user_1' } })
    )
  })

  it('devolve status+progress+result quando encontrado', async () => {
    const job = {
      id: 'job_1',
      status: 'completed',
      progress: 'done',
      result: { healthScore: 90 },
      error: null,
      repoFullName: 'acme/loja',
    }
    const prisma = { diagnosisJob: { findFirst: vi.fn().mockResolvedValue(job), create: vi.fn() } }
    const app = buildApp(prisma, vi.fn())
    await diagnoseRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnose/job_1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(job)
  })
})
