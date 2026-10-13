import { describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import { painelRoutes } from './painel.js'

// A faixa "atualização em andamento" do painel lê só duas coisas: se a trava
// está ligada e desde quando. Nada de motivo, quem ligou nem contagens.

async function montar(linha: Record<string, unknown> | null, falhar = false) {
  const app = Fastify()
  app.decorate('prisma', {
    travaDeEntrega: {
      findUnique: vi.fn(async () => {
        if (falhar) throw new Error('banco fora do ar')
        return linha
      }),
    },
  } as never)
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { id: 'user_1', wingId: 'octocat', email: 'a@example.test' }
  })
  await painelRoutes(app)
  await app.ready()
  return app
}

describe('GET /api/v1/painel/atualizacao', () => {
  it('trava ligada: devolve ligada e desde, e só isso', async () => {
    const app = await montar({
      id: 'entrega',
      ligada: true,
      desde: new Date('2030-01-01T10:00:00Z'),
      motivo: 'segredo interno',
      ligadaPor: 'entregador',
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/painel/atualizacao' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ligada: true, desde: '2030-01-01T10:00:00.000Z' })
  })

  it('trava desligada: ligada false e desde nulo', async () => {
    const app = await montar(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/painel/atualizacao' })
    expect(res.json()).toEqual({ ligada: false, desde: null })
  })

  it('sem sessão: 401', async () => {
    const app = Fastify()
    app.decorate('prisma', {} as never)
    await painelRoutes(app)
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/painel/atualizacao' })
    expect(res.statusCode).toBe(401)
  })

  it('banco fora do ar: o painel não afirma atualização (ligada false), sem erro na tela', async () => {
    const app = await montar(null, true)
    const res = await app.inject({ method: 'GET', url: '/api/v1/painel/atualizacao' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ligada: false, desde: null })
  })
})
