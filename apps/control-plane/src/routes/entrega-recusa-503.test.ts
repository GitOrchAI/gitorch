import { describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import { missionRoutes } from './missions.js'
import { diagnoseRoutes } from './diagnose.js'
import setupRoutes from './setup.js'
import { enginesPlugin } from '../plugins/engines.js'
import { MENSAGEM_EM_ENTREGA } from '../services/trava-de-entrega.js'

// Com a trava de entrega ligada, toda rota que INICIA trabalho recusa com 503 e
// um Retry-After, sem tocar no banco de trabalho (nada é criado). A trava
// desligada é o comportamento de sempre e fica coberto pelos testes de cada rota.

function prismaComTrava(ligada: boolean) {
  const criou = vi.fn()
  const prisma = {
    travaDeEntrega: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          ligada
            ? { id: 'entrega', ligada: true, desde: new Date(), motivo: 'm', ligadaPor: 'p' }
            : null
        ),
    },
    mission: { create: criou, findMany: vi.fn().mockResolvedValue([]) },
    diagnosisJob: { create: criou, findFirst: vi.fn().mockResolvedValue(null) },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', name: 'x' }), findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user_1' }) },
    clientEnvironment: { create: criou, findFirst: vi.fn().mockResolvedValue(null) },
  }
  return { prisma, criou }
}

async function montar(
  registrar: (app: ReturnType<typeof Fastify>) => Promise<unknown>,
  ligada: boolean,
  decorarMotores = true
) {
  const { prisma, criou } = prismaComTrava(ligada)
  const app = Fastify()
  app.decorate('prisma', prisma as never)
  if (decorarMotores) {
    app.decorate('engineConnections', {
      getRawGithubToken: vi.fn().mockResolvedValue('gh'),
    } as never)
  }
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { id: 'user_1', wingId: 'octocat', email: 'a@example.test' }
    request.wingId = 'octocat'
  })
  await registrar(app)
  await app.ready()
  return { app, criou }
}

const rotas: Array<{
  nome: string
  registrar: (app: ReturnType<typeof Fastify>) => Promise<unknown>
  req: { method: 'POST'; url: string; payload: Record<string, unknown> }
  decorarMotores?: boolean
}> = [
  {
    nome: 'POST /api/missions/trigger',
    registrar: (app) => missionRoutes(app),
    req: {
      method: 'POST',
      url: '/api/missions/trigger',
      payload: { projectId: 'p1', type: 'sync', payload: {} },
    },
  },
  {
    nome: 'POST /api/v1/diagnose',
    registrar: (app) => diagnoseRoutes(app),
    req: { method: 'POST', url: '/api/v1/diagnose', payload: { repo: 'dono/repo' } },
  },
  {
    nome: 'POST /api/v1/setup/submit',
    registrar: (app) => setupRoutes(app),
    req: { method: 'POST', url: '/api/v1/setup/submit', payload: { repos: ['dono/repo'] } },
  },
  {
    nome: 'POST /api/v1/setup/retry',
    registrar: (app) => setupRoutes(app),
    req: { method: 'POST', url: '/api/v1/setup/retry', payload: {} },
  },
  {
    nome: 'POST /api/v1/engines/:runtime/login/start',
    registrar: async (app) => {
      await app.register(enginesPlugin)
    },
    req: { method: 'POST', url: '/api/v1/engines/codex/login/start', payload: {} },
    decorarMotores: false,
  },
]

describe('trava de entrega ligada: rotas que iniciam trabalho respondem 503', () => {
  it.each(rotas)('$nome recusa com 503 + Retry-After e não cria nada', async (rota) => {
    const { app, criou } = await montar(rota.registrar, true, rota.decorarMotores ?? true)
    const res = await app.inject(rota.req)
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBeDefined()
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.json()).toMatchObject({ error: MENSAGEM_EM_ENTREGA })
    expect(criou).not.toHaveBeenCalled()
  })

  it('com a trava desligada a mesma rota de missão segue normal (não vira 503)', async () => {
    const { app } = await montar((a) => missionRoutes(a), false)
    const res = await app.inject(rotas[0]!.req)
    expect(res.statusCode).not.toBe(503)
  })

  it('POST /api/missions/agent-run: o disparo recusado pela trava vira 503, não 409', async () => {
    const { app } = await montar(async (a) => {
      a.decorate(
        'triggerAgentMission',
        vi.fn().mockResolvedValue({ triggered: false, reason: 'em-entrega' })
      )
      await missionRoutes(a)
    }, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/agent-run',
      payload: { role: 'ra' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
