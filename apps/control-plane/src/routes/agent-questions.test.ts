import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { setupRoutes } from './setup.js'

// GET /api/v1/setup/agent-questions — o painel passa a EXIBIR as dúvidas dos
// agentes (W3.4.2), read-only: responder continua sendo só pelo Telegram (ver
// agent-question.ts + telegram-bot.ts). O que este teste trava de verdade é o
// escopo por DONO — a mesma garantia anti-vazamento que listForUser já dá, só
// que agora exposta numa rota HTTP.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface AgentQuestionRow {
  id: string
  projectId: string
  userId: string
  text: string
  context: string | null
  options: unknown
  dedupKey: string | null
  status: string
  answer: string | null
  answeredAt: Date | null
  answeredVia: string | null
  telegramMessageId: number | null
  createdAt: Date
  updatedAt: Date
}

const makeQuestion = (overrides: Partial<AgentQuestionRow> = {}): AgentQuestionRow => ({
  id: 'q_1',
  projectId: 'proj_1',
  userId: 'owner_1',
  text: 'Pergunta padrão',
  context: null,
  options: [],
  dedupKey: null,
  status: 'open',
  answer: null,
  answeredAt: null,
  answeredVia: null,
  telegramMessageId: null,
  createdAt: new Date('2026-07-20T10:00:00Z'),
  updatedAt: new Date('2026-07-20T10:00:00Z'),
  ...overrides,
})

describe('GET /api/v1/setup/agent-questions — painel lê as dúvidas (read-only)', () => {
  let app: ReturnType<typeof Fastify>
  let store: AgentQuestionRow[]

  beforeEach(async () => {
    store = []
    app = Fastify()
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test' }),
      },
      mission: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      clientEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
      telegramLink: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      agentQuestion: {
        findMany: vi.fn(async ({ where }: any) => store.filter((q) => q.userId === where.userId)),
      },
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'sessao_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('devolve só as dúvidas do DONO autenticado — NUNCA as de outro dono (anti-vazamento)', async () => {
    store.push(makeQuestion({ id: 'q_a1', userId: 'owner_1', text: 'A1' }))
    store.push(
      makeQuestion({
        id: 'q_a2',
        userId: 'owner_1',
        text: 'A2',
        status: 'answered',
        answer: 'sim',
      })
    )
    store.push(makeQuestion({ id: 'q_b1', userId: 'owner_B_outro_dono', text: 'B1' }))

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/agent-questions' })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { questions: Array<{ id: string }> }
    expect(body.questions).toHaveLength(2)
    expect(body.questions.map((q) => q.id).sort()).toEqual(['q_a1', 'q_a2'])
    expect(res.payload).not.toContain('owner_B_outro_dono')
  })

  it('a resposta NUNCA carrega userId/telegramMessageId/dedupKey (dado interno não vaza pro front)', async () => {
    store.push(
      makeQuestion({
        id: 'q_1',
        dedupKey: 'chave-interna-secreta',
        telegramMessageId: 555111,
      })
    )

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/agent-questions' })
    const body = res.json() as { questions: Array<Record<string, unknown>> }

    expect(res.payload).not.toContain('chave-interna-secreta')
    expect(res.payload).not.toContain('555111')
    expect(res.payload).not.toContain('telegramMessageId')
    expect(res.payload).not.toContain('dedupKey')
    expect(body.questions[0]).not.toHaveProperty('userId')
    expect(body.questions[0]).not.toHaveProperty('telegramMessageId')
    expect(body.questions[0]).not.toHaveProperty('dedupKey')
  })

  it('options sempre vira array de {label,value} — nunca lança se vier torto', async () => {
    store.push(
      makeQuestion({
        id: 'q_opts',
        options: [{ label: 'Sim', value: 'yes' }],
      })
    )
    store.push(makeQuestion({ id: 'q_opts_torto', options: 'não é array' as unknown }))

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/agent-questions' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { questions: Array<{ id: string; options: unknown }> }
    const ok = body.questions.find((q) => q.id === 'q_opts')
    const torto = body.questions.find((q) => q.id === 'q_opts_torto')
    expect(ok?.options).toEqual([{ label: 'Sim', value: 'yes' }])
    expect(torto?.options).toEqual([])
  })
})

describe('GET /api/v1/setup/agent-questions — sem sessão', () => {
  it('401 (a dúvida de alguém não é pública)', async () => {
    const app = Fastify()
    app.decorate('prisma', {
      user: { findUnique: vi.fn() },
      mission: { findMany: vi.fn(), create: vi.fn() },
      clientEnvironment: { findFirst: vi.fn() },
      telegramLink: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      agentQuestion: { findMany: vi.fn() },
    } as any)
    await setupRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/agent-questions' })
    expect(res.statusCode).toBe(401)
  })
})
