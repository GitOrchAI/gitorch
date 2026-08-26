import { expect, describe, vi, beforeEach, test } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { avisoDePublicacaoRoutes } from './aviso-de-publicacao.js'

describe('quem publica em VM própria avisa o produto (D49)', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await avisoDePublicacaoRoutes(app)
    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }
    await app.ready()
  })

  test('aviso do commit certo destrava a entrega com veredito de no ar', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    app.prisma.devSession.findFirst = vi.fn().mockResolvedValue({
      sessionName: 'sessions/1',
      mergeCommitSha: 'abc123',
      closedAt: null,
    })
    const update = vi.fn().mockResolvedValue({})
    app.prisma.devSession.update = update

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: { commit: 'abc123', url: 'https://patinhas.exemplo' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ registrado: true, estado: 'no-ar' })
    expect(update.mock.calls[0]![0].data.deployState).toBe('no-ar')
  })

  test('aviso de falha registra falha — nunca "no ar"', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    app.prisma.devSession.findFirst = vi.fn().mockResolvedValue({
      sessionName: 'sessions/1',
      mergeCommitSha: 'abc123',
      closedAt: null,
    })
    const update = vi.fn().mockResolvedValue({})
    app.prisma.devSession.update = update

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: { commit: 'abc123', sucesso: false },
    })

    expect(res.json()).toEqual({ registrado: true, estado: 'falhou' })
    expect(update.mock.calls[0]![0].data.deployState).toBe('falhou')
  })

  test('aviso de um commit que não é entrega nenhuma: não carimba nada', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    // A busca é PELO COMMIT: um commit desconhecido simplesmente não acha.
    app.prisma.devSession.findFirst = vi.fn().mockResolvedValue(null)
    const update = vi.fn()
    app.prisma.devSession.update = update

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: { commit: 'versao-antiga' },
    })

    expect(res.json().registrado).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  test('com DUAS entregas esperando aviso, cada aviso acha a SUA — não a mais recente', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    const entregas = [
      { sessionName: 'sessions/A', mergeCommitSha: 'aaa111', closedAt: null },
      { sessionName: 'sessions/B', mergeCommitSha: 'bbb222', closedAt: null },
    ]
    // Fake honesto: responde ao FILTRO, como o banco de verdade faria.
    type Filtro = { where: { mergeCommitSha: { equals: string } } }
    app.prisma.devSession.findFirst = vi.fn(async (args: Filtro) => {
      const procurado = args.where.mergeCommitSha.equals.toLowerCase()
      return entregas.find((e) => e.mergeCommitSha.toLowerCase() === procurado) ?? null
    })
    const update = vi.fn().mockResolvedValue({})
    app.prisma.devSession.update = update

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: { commit: 'bbb222' },
    })

    expect(res.json()).toEqual({ registrado: true, estado: 'no-ar' })
    // Carimbou a B, que é de quem era o aviso — nunca a A.
    expect(update.mock.calls[0]![0].where.sessionName).toBe('sessions/B')
  })

  test('sem commit no corpo: recusa na porta', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  test('projeto de outro dono: 404, sem nem olhar a entrega', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
    const buscarEntrega = vi.fn()
    app.prisma.devSession.findFirst = buscarEntrega

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_alheio/publicado',
      headers: authHeaders,
      payload: { commit: 'abc123' },
    })

    expect(res.statusCode).toBe(404)
    expect(buscarEntrega).not.toHaveBeenCalled()
  })

  test('reenvio sobre entrega já encerrada devolve 200 — CD que recebe erro repete em rajada', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    app.prisma.devSession.findFirst = vi.fn().mockResolvedValue({
      sessionName: 'sessions/1',
      mergeCommitSha: 'abc123',
      closedAt: new Date(),
    })
    const update = vi.fn()
    app.prisma.devSession.update = update

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_1/publicado',
      headers: authHeaders,
      payload: { commit: 'abc123' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().registrado).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })
})
