import { describe, expect, it, vi, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { devAgentQuestionRoutes } from './dev-agent-question.js'

// Prova real (W3.5.1): rota de DEV, protegida por flag (nunca por NODE_ENV —
// o ambiente dev deployado roda NODE_ENV=production, ver plugins/index.ts),
// que dispara a DÚVIDA REAL das cores oficiais pelo mesmo caminho de produção
// (AgentQuestionService.ask). Mesmo padrão de fake de prisma/app das rotas
// vizinhas (ver routes/telegram-link.test.ts, routes/diagnose.test.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
const FLAG = 'GITORCH_DEV_ROUTES'

// Fake do Prisma: só o que a rota + AgentQuestionService.ask usam
// (project.findFirst, agentQuestion.findFirst/create, event.create) — mesmo
// padrão de agent-question.test.ts, nunca banco real.
function fakePrisma(opts: { projects?: { id: string; userId: string; createdAt: Date }[] } = {}) {
  const projects = opts.projects ?? []
  const questions = new Map<string, any>()
  const events: any[] = []
  let seq = 0
  return {
    projects,
    questions,
    events,
    project: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const rows = projects.filter((p) => p.userId === where.userId)
        if (rows.length === 0) return null
        const sorted = [...rows].sort((a, b) =>
          orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime()
        )
        return sorted[0]
      }),
    },
    agentQuestion: {
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = [...questions.values()].filter((r) => {
          if (where.projectId !== undefined && r.projectId !== where.projectId) return false
          if (where.dedupKey !== undefined && r.dedupKey !== where.dedupKey) return false
          if (where.status !== undefined && r.status !== where.status) return false
          return true
        })
        return rows[0] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        const rec = {
          id: `q_${++seq}`,
          context: null,
          dedupKey: null,
          answer: null,
          answeredAt: null,
          answeredVia: null,
          telegramMessageId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        }
        questions.set(rec.id, rec)
        return rec
      }),
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        const rec = { id: `e_${++seq}`, createdAt: new Date(), ...data }
        events.push(rec)
        return rec
      }),
    },
  }
}

function buildApp(prisma: ReturnType<typeof fakePrisma>, opts: { withUser?: boolean } = {}) {
  const app = Fastify()
  app.decorate('prisma', prisma as never)
  if (opts.withUser ?? true) {
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat' }
    })
  }
  return app
}

describe('POST /api/v1/dev/agent-question (W3.5.1 — prova real das cores)', () => {
  const ORIGINAL_FLAG = process.env[FLAG]

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL_FLAG
  })

  it('flag ausente → 404, mesmo com sessão (feature desligada por padrão)', async () => {
    delete process.env[FLAG]
    const prisma = fakePrisma({
      projects: [{ id: 'proj_1', userId: 'owner_1', createdAt: new Date() }],
    })
    const app = buildApp(prisma)
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'NOT_FOUND' })
  })

  it('flag ligada + sem sessão → 401', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma()
    const app = buildApp(prisma, { withUser: false })
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED: session required' })
  })

  it('flag ligada + sessão + sem projeto do dono → 400', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma({ projects: [] })
    const app = buildApp(prisma)
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'NO_PROJECT: conecte um repositório primeiro' })
  })

  it('flag ligada + sessão + projeto → 200, cria a AgentQuestion real das cores', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma({
      projects: [{ id: 'proj_1', userId: 'owner_1', createdAt: new Date('2026-07-20T10:00:00Z') }],
    })
    const app = buildApp(prisma)
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { created: boolean; deduped: boolean; questionId: string }
    expect(body.created).toBe(true)
    expect(body.deduped).toBe(false)
    expect(body.questionId).toBeTruthy()

    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)
    const created = prisma.questions.get(body.questionId)
    expect(created).toMatchObject({
      projectId: 'proj_1',
      userId: 'owner_1',
      text: 'As páginas Home, Preço e Painel usam 3 azuis diferentes. Qual é o azul oficial do site?',
      dedupKey: 'cor-azul-oficial',
      status: 'open',
    })
    expect(created.options).toEqual([
      { label: '#2563EB', value: '#2563EB' },
      { label: '#1E40AF', value: '#1E40AF' },
      { label: '#3B82F6', value: '#3B82F6' },
    ])
  })

  it('escolhe o projeto MAIS RECENTE do dono quando há mais de um', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma({
      projects: [
        { id: 'proj_velho', userId: 'owner_1', createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'proj_novo', userId: 'owner_1', createdAt: new Date('2026-07-20T00:00:00Z') },
      ],
    })
    const app = buildApp(prisma)
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })
    const body = res.json() as { questionId: string }

    expect(prisma.questions.get(body.questionId)?.projectId).toBe('proj_novo')
  })

  it('segundo POST com o mesmo dedupKey: devolve deduped:true e NÃO duplica', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma({
      projects: [{ id: 'proj_1', userId: 'owner_1', createdAt: new Date() }],
    })
    const app = buildApp(prisma)
    await devAgentQuestionRoutes(app)
    await app.ready()

    // Simula que o dono já respondeu a dúvida (mesma chave, mesmo projeto):
    // é assim que dedupKey funciona no contrato de AgentQuestionService.ask —
    // sem uma answered com a MESMA chave, o 2º POST criaria outra dúvida
    // (2 dúvidas abertas com a mesma pergunta), o que o dedupKey existe pra
    // evitar quando o dono já decidiu antes.
    const first = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })
    const firstBody = first.json() as { questionId: string }
    const rec = prisma.questions.get(firstBody.questionId)
    prisma.questions.set(firstBody.questionId, { ...rec, status: 'answered', answer: '#2563EB' })

    const second = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })
    const secondBody = second.json() as { created: boolean; deduped: boolean; questionId: string }

    expect(second.statusCode).toBe(200)
    expect(secondBody.deduped).toBe(true)
    expect(secondBody.created).toBe(false)
    expect(secondBody.questionId).toBe(firstBody.questionId)
    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)
  })

  it('reusa app.agentQuestionService quando decorado (mesmo caminho de notify do produto)', async () => {
    process.env[FLAG] = '1'
    const prisma = fakePrisma({
      projects: [{ id: 'proj_1', userId: 'owner_1', createdAt: new Date() }],
    })
    const app = buildApp(prisma)
    const fakeQuestion = {
      id: 'q_reused',
      projectId: 'proj_1',
      userId: 'owner_1',
      text: 'x',
      options: [],
      status: 'open',
    }
    const askSpy = vi.fn(async () => ({ deduped: false, question: fakeQuestion }))
    app.decorate('agentQuestionService', { ask: askSpy } as any)
    await devAgentQuestionRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/dev/agent-question' })

    expect(res.statusCode).toBe(200)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy).toHaveBeenCalledWith(
      'owner_1',
      'proj_1',
      expect.objectContaining({ dedupKey: 'cor-azul-oficial' })
    )
    // A rota NÃO criou uma instância própria nem tocou o prisma.agentQuestion
    // diretamente — passou pelo serviço decorado (o mesmo do plugin do Telegram).
    expect(prisma.agentQuestion.create).not.toHaveBeenCalled()
  })
})
