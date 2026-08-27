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
function fakePrisma(over: Record<string, any> = {}) {
  return {
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

  async function build(prisma: any = fakePrisma()) {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    ;(app as any).prisma = prisma
    await painelRoutes(app)
    const token = jwt.sign({ userId: 'owner_1', wingId: 'octocat' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }
    await app.ready()
    return prisma
  }

  const getPulso = () =>
    app.inject({ method: 'GET', url: '/api/v1/painel/pulso', headers: authHeaders })

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

    test('escopo por dono: a consulta filtra por project.userId, nunca por wingId', async () => {
      const prisma = await build()
      await getPulso()
      const chamada = prisma.event.findFirst.mock.calls[0]
      expect(chamada).toBeDefined()
      expect(chamada[0].where).toEqual({ project: { userId: 'owner_1' } })
      expect(JSON.stringify(prisma.mission.findFirst.mock.calls[0][0].where)).not.toContain(
        'octocat'
      )
    })
  })
})
