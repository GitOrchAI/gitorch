import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { setupRoutes } from './setup.js'

// As duas rotas que o passo 8 do wizard passa a usar de verdade: uma cria o
// deep link (com o token que vai voltar no /start) e a outra conta a VERDADE do
// vínculo. Antes disto o passo não chamava backend nenhum — capturava um
// @username em estado local e prometia um aviso que nunca chegaria.

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LinkView {
  status: string
  deepLink: string | null
}

describe('rotas do vínculo do Telegram', () => {
  let app: ReturnType<typeof Fastify>
  let store: Map<string, any>
  let upsert: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    store = new Map<string, any>()
    upsert = vi.fn(async ({ where, create, update }: any) => {
      const existing = [...store.values()].find((r) => r.userId === where.userId)
      const rec = existing
        ? { ...existing, ...update }
        : { id: 'tgl_1', chatId: null, linkedAt: null, ...create }
      store.set(rec.id, rec)
      return rec
    })

    app = Fastify()
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test' }),
      },
      mission: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      clientEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
      telegramLink: {
        findUnique: vi.fn(
          async ({ where }: any) =>
            [...store.values()].find((r) =>
              where.userId !== undefined ? r.userId === where.userId : r.token === where.token
            ) ?? null
        ),
        findFirst: vi.fn(
          async ({ where }: any) => [...store.values()].find((r) => r.token === where.token) ?? null
        ),
        upsert,
        updateMany: vi.fn(async ({ where, data }: any) => {
          const rows = [...store.values()].filter(
            (r) => r.token === where.token && r.status === where.status
          )
          for (const r of rows) store.set(r.id, { ...r, ...data })
          return { count: rows.length }
        }),
      },
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'sessao_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('POST /telegram/link devolve o deep link REAL do bot (t.me/<bot>?start=<token>)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/telegram/link' })

    expect(res.statusCode).toBe(200)
    const body = res.json() as LinkView
    expect(body.status).toBe('pending')
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=/)
  })

  it('o vínculo nasce sob o DONO resolvido por e-mail — não sob o id cru da sessão', async () => {
    // É o mesmo id (owner.id) por onde o notificador procura o chat a partir de
    // project.userId. Gravar sob o id do JWT deixaria o vínculo órfão: o cliente
    // veria "conectado" e nunca receberia nada.
    await app.inject({ method: 'POST', url: '/api/v1/setup/telegram/link' })
    expect(upsert.mock.calls[0]?.[0]?.where).toEqual({ userId: 'owner_1' })
  })

  it('GET /telegram/status conta a verdade: pendente até o Start, vinculado depois dele', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/setup/telegram/link' })
    const deepLink = (created.json() as LinkView).deepLink as string
    const token = new URL(deepLink).searchParams.get('start') as string

    const pendente = await app.inject({ method: 'GET', url: '/api/v1/setup/telegram/status' })
    expect((pendente.json() as LinkView).status).toBe('pending')

    // O cliente aperta Start: o bot recebe /start <token> e o backend vincula.
    const row = [...store.values()][0]
    store.set(row.id, {
      ...row,
      status: 'linked',
      chatId: '555',
      token: null,
      linkedAt: new Date(),
    })
    expect(token).toBeTruthy()

    const vinculado = await app.inject({ method: 'GET', url: '/api/v1/setup/telegram/status' })
    const body = vinculado.json() as LinkView
    expect(body.status).toBe('linked')
    expect(body.deepLink).toBeNull()
  })

  it('a resposta NUNCA carrega o chat_id nem o token do bot (dado de infra/pessoal não vaza pro front)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/setup/telegram/link' })
    const row = [...store.values()][0]
    store.set(row.id, { ...row, status: 'linked', chatId: '987654321', token: null })

    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/telegram/status' })

    expect(created.statusCode).toBe(200)
    expect(res.payload).not.toContain('987654321')
    expect(res.payload).not.toContain('chatId')
    expect(res.payload).not.toContain('botToken')
  })
})

describe('rotas do vínculo do Telegram — sem sessão', () => {
  const anon = async () => {
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
    } as any)
    await setupRoutes(app)
    await app.ready()
    return app
  }

  it('401 em ambas (o Telegram de alguém não é público)', async () => {
    const app = await anon()
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/setup/telegram/link' })).statusCode
    ).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/setup/telegram/status' })).statusCode
    ).toBe(401)
  })
})
