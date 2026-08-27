import { test, expect, describe, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { painelRoutes } from './painel.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Fake Prisma injetado (padrão dos testes do control-plane — nunca banco real).
// resolveOwnerId não toca no Prisma quando a sessão não tem e-mail (JWT de
// teste), então basta cobrir event/mission/agentQuestion.
// O dono 'owner_1' tem 1 projeto por padrão (as rotas resolvem os ids do dono
// antes de consultar Event/Mission por `projectId: { in }`).
function fakePrisma(over: Record<string, any> = {}) {
  return {
    project: { findMany: vi.fn().mockResolvedValue([{ id: 'proj_1' }]) },
    event: { findFirst: vi.fn().mockResolvedValue(null) },
    mission: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentQuestion: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    ...over,
  }
}

const ultimoEvento = (over: Record<string, any>) => ({
  event: { findFirst: vi.fn().mockResolvedValue(over) },
})

describe('Rotas do painel do owner', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  async function build(prisma: any = fakePrisma(), opts: any = {}) {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    ;(app as any).prisma = prisma
    await painelRoutes(app, opts)
    const token = jwt.sign({ userId: 'owner_1', wingId: 'octocat' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }
    await app.ready()
    return prisma
  }

  const getPulso = () =>
    app.inject({ method: 'GET', url: '/api/v1/painel/pulso', headers: authHeaders })
  const getAgentes = () =>
    app.inject({ method: 'GET', url: '/api/v1/painel/agentes', headers: authHeaders })

  beforeEach(async () => {
    await build()
  })

  describe('GET /api/v1/painel/pulso', () => {
    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/pulso' })
      expect(res.statusCode).toBe(401)
    })

    test('sem nenhum sinal → campos nulos e quente:false', async () => {
      const res = await getPulso()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        ultimo_sinal_em: null,
        ha_segundos: null,
        descricao: null,
        quente: false,
        limite_frio_segundos: 3600,
      })
    })

    test('usa o createdAt REAL do evento, não a hora da consulta', async () => {
      const quando = new Date(Date.now() - 120_000) // 2 min atrás
      await build(
        fakePrisma(ultimoEvento({ type: 'mission.completed', payload: {}, createdAt: quando }))
      )

      const body = (await getPulso()).json()
      expect(body.ultimo_sinal_em).toBe(quando.toISOString())
      expect(body.ha_segundos).toBeGreaterThanOrEqual(110)
      expect(body.ha_segundos).toBeLessThan(3600)
      expect(body.quente).toBe(true)
      expect(typeof body.descricao).toBe('string')
      expect(body.descricao.length).toBeGreaterThan(0)
    })

    test('sinal com mais de 1h → quente:false', async () => {
      const antigo = new Date(Date.now() - 4_000_000)
      await build(fakePrisma(ultimoEvento({ type: 'x', payload: {}, createdAt: antigo })))
      expect((await getPulso()).json().quente).toBe(false)
    })

    test('escopo por dono: resolve os projetos do dono e filtra por projectId, nunca wingId', async () => {
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]) },
        })
      )
      await getPulso()
      expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ userId: 'owner_1' })
      expect(prisma.event.findFirst.mock.calls[0][0].where).toEqual({
        projectId: { in: ['p1', 'p2'] },
      })
      expect(JSON.stringify(prisma.mission.findFirst.mock.calls[0][0].where)).not.toContain(
        'octocat'
      )
    })

    test('dono sem projeto → campos nulos sem tocar Event/Mission', async () => {
      const prisma = await build(
        fakePrisma({ project: { findMany: vi.fn().mockResolvedValue([]) } })
      )
      const body = (await getPulso()).json()
      expect(body.ultimo_sinal_em).toBeNull()
      expect(prisma.event.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/v1/painel/agentes', () => {
    const comMissoes = (rows: any[]) => ({
      project: { findMany: vi.fn().mockResolvedValue([{ id: 'proj_1' }]) },
      mission: {
        findMany: vi.fn().mockResolvedValue(rows),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    })

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/agentes' })
      expect(res.statusCode).toBe(401)
    })

    test('sem missão rodando → atuando vazio, motores vazio', async () => {
      const res = await getAgentes()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ atuando: [], motores: [] })
    })

    test('missão running → estado trabalhando e progresso SEMPRE null', async () => {
      const t0 = new Date(Date.now() - 60_000)
      await build(
        fakePrisma(
          comMissoes([
            {
              id: 'm1',
              type: 'agent-run-qa',
              payload: { engine: 'Jules' },
              status: 'running',
              waitingStatus: null,
              startedAt: t0,
              createdAt: t0,
              project: { name: 'Checkout' },
            },
          ])
        )
      )
      const [a] = (await getAgentes()).json().atuando
      expect(a.estado).toBe('trabalhando')
      expect(a.progresso).toBeNull()
      expect(a.nome).toBe('Jules')
      expect(a.papel).toBe('Qualidade')
      expect(a.projeto).toBe('Checkout')
      expect(a.desde).toBe(t0.toISOString())
    })

    test('missão com waitingStatus → esperando_voce', async () => {
      const t0 = new Date()
      await build(
        fakePrisma(
          comMissoes([
            {
              id: 'm2',
              type: 'agent-run-ra',
              payload: {},
              status: 'running',
              waitingStatus: 'awaiting_user',
              startedAt: t0,
              createdAt: t0,
              project: { name: 'Checkout' },
            },
          ])
        )
      )
      expect((await getAgentes()).json().atuando[0].estado).toBe('esperando_voce')
    })

    test('lerCotas que rejeita → motores:[] (nunca 500)', async () => {
      await build(fakePrisma(), {
        lerCotas: vi.fn().mockRejectedValue(new Error('sem store de cota')),
      })
      const res = await getAgentes()
      expect(res.statusCode).toBe(200)
      expect(res.json().motores).toEqual([])
    })

    test('lerCotas que responde → motores repassados', async () => {
      const motores = [
        {
          id: 'jules',
          nome: 'Jules',
          usado: 14,
          limite: 20,
          janela: '24h',
          limite_conhecido: true,
        },
      ]
      await build(fakePrisma(), { lerCotas: vi.fn().mockResolvedValue(motores) })
      expect((await getAgentes()).json().motores).toEqual(motores)
    })

    test('escopo por dono: findMany filtra projectId dos projetos do dono + status running/pending', async () => {
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
          mission: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
        })
      )
      await getAgentes()
      const where = prisma.mission.findMany.mock.calls[0][0].where
      expect(where.projectId).toEqual({ in: ['p1'] })
      expect(where.status).toEqual({ in: ['running', 'pending'] })
    })
  })

  describe('POST /api/v1/painel/decisoes/:id/responder', () => {
    const pergunta = (over: Record<string, any> = {}) => ({
      id: 'd1',
      userId: 'owner_1',
      status: 'open',
      answer: null,
      answeredVia: null,
      answeredAt: null,
      ...over,
    })
    const responder = (payload: any) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/painel/decisoes/d1/responder',
        headers: authHeaders,
        payload,
      })

    test('sem sessão → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/decisoes/d1/responder',
        payload: { resposta: 'x' },
      })
      expect(res.statusCode).toBe(401)
    })

    test('resposta vazia → 400', async () => {
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } })
      )
      expect((await responder({ resposta: '   ' })).statusCode).toBe(400)
      expect((await responder({})).statusCode).toBe(400)
    })

    test('pergunta de outra conta → 404 (mesma frase de inexistente)', async () => {
      await build(
        fakePrisma({
          agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta({ userId: 'outro' })) },
        })
      )
      const res = await responder({ resposta: 'x' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Decisão não encontrada.' })
    })

    test('pergunta inexistente → 404 (mesma frase)', async () => {
      await build(fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(null) } }))
      const res = await responder({ resposta: 'x' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Decisão não encontrada.' })
    })

    test('já respondida → 409 com a resposta que existe', async () => {
      await build(
        fakePrisma({
          agentQuestion: {
            findUnique: vi.fn().mockResolvedValue(
              pergunta({
                status: 'answered',
                answer: 'Separado',
                answeredVia: 'telegram',
                answeredAt: new Date('2026-08-27T12:00:00Z'),
              })
            ),
          },
        })
      )
      const res = await responder({ resposta: 'Junto' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'JA_RESPONDIDA',
        answer: 'Separado',
        answeredVia: 'telegram',
        answeredAt: '2026-08-27T12:00:00.000Z',
      })
    })

    test('ok → 200, answeredVia panel, sem campo interno vazando', async () => {
      const answerImpl = vi.fn().mockResolvedValue({
        id: 'd1',
        answer: 'Junto',
        answeredAt: new Date('2026-08-27T12:00:00Z'),
        answeredVia: 'panel',
        status: 'answered',
      })
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } }),
        { answerImpl }
      )
      const res = await responder({ resposta: 'Junto' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toEqual({
        id: 'd1',
        status: 'answered',
        answer: 'Junto',
        answeredAt: '2026-08-27T12:00:00.000Z',
        answeredVia: 'panel',
      })
      expect(body).not.toHaveProperty('userId')
      expect(body).not.toHaveProperty('dedupKey')
      expect(body).not.toHaveProperty('telegramMessageId')
      expect(body).not.toHaveProperty('projectId')
      expect(answerImpl).toHaveBeenCalledWith('d1', 'Junto', 'panel')
    })

    test('corrida: some entre findUnique e answer → 404', async () => {
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } }),
        { answerImpl: vi.fn().mockResolvedValue(null) }
      )
      expect((await responder({ resposta: 'x' })).statusCode).toBe(404)
    })
  })
})
