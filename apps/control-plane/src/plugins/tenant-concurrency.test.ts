import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { authPlugin } from './auth.js'
import { tenantContext } from './prisma.js'
import { getEnv, resetEnvCache } from '../config/env.js'

/**
 * O isolamento entre clientes vive num AsyncLocalStorage. A documentação do Node
 * é explícita: `enterWith()` "persiste pelo resto da execução síncrona, então
 * handlers subsequentes podem rodar dentro dele" — e recomenda `run()`.
 *
 * Um vazamento aqui seria PIOR que o bug original (guard inerte): em vez de não
 * filtrar nada, filtraria pelo dono ERRADO — servindo dado de um cliente a
 * outro. Este teste existe para que essa hipótese nunca seja aceita por
 * dedução: ele dispara clientes distintos em paralelo (e em keep-alive na mesma
 * conexão TCP, que é onde um contexto reaproveitado apareceria) e exige que cada
 * requisição enxergue exclusivamente o seu dono.
 */
describe('isolamento sob concorrência (o contexto não pode vazar entre clientes)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetEnvCache()
    app = Fastify({ keepAliveTimeout: 5000 })
    await app.register(fastifyCookie)
    app.decorate('prisma', {
      apiKey: { findMany: vi.fn().mockResolvedValue([]) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await app.register(authPlugin)

    // Devolve o dono que o guard do Prisma enxergaria NESTA requisição.
    app.get('/api/v1/quem-sou-eu', async (request) => {
      // um await no meio: o contexto tem que sobreviver ao salto de tick
      await new Promise((r) => setImmediate(r))
      return {
        doSessao: request.user?.id ?? null,
        doContexto: tenantContext.getStore()?.userId ?? null,
      }
    })

    await app.listen({ port: 0, host: '127.0.0.1' })
  })

  afterEach(async () => {
    await app.close()
    resetEnvCache()
  })

  const tokenDe = (userId: string): string =>
    jwt.sign({ userId, wingId: `wing_${userId}` }, getEnv().JWT_SECRET)

  it('20 clientes simultâneos: cada requisição enxerga APENAS o seu dono', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `user_${i}`)

    const respostas = await Promise.all(
      ids.map((id) =>
        app
          .inject({
            method: 'GET',
            url: '/api/v1/quem-sou-eu',
            headers: { authorization: `Bearer ${tokenDe(id)}` },
          })
          .then((r) => ({ esperado: id, corpo: r.json() }))
      )
    )

    for (const { esperado, corpo } of respostas) {
      expect(corpo.doSessao).toBe(esperado)
      // o coração do teste: o escopo que o Prisma usaria é o do dono da requisição
      expect(corpo.doContexto).toBe(esperado)
    }
  })

  it('requisições em sequência na MESMA conexão (keep-alive) não herdam o dono anterior', async () => {
    const porta = (app.server.address() as { port: number }).port
    const base = `http://127.0.0.1:${porta}/api/v1/quem-sou-eu`
    // Uma única conexão TCP reaproveitada — o cenário em que um contexto
    // reciclado entregaria o dono da requisição ANTERIOR.
    const { Agent } = await import('node:http')
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })

    const chamar = async (id: string): Promise<{ doSessao: string; doContexto: string }> => {
      const res = await fetch(base, {
        headers: { authorization: `Bearer ${tokenDe(id)}` },
        // @ts-expect-error - `agent` é aceito pelo undici/node fetch em runtime
        agent,
      })
      return (await res.json()) as { doSessao: string; doContexto: string }
    }

    for (const id of ['user_a', 'user_b', 'user_c', 'user_a']) {
      const corpo = await chamar(id)
      expect(corpo.doSessao).toBe(id)
      expect(corpo.doContexto).toBe(id)
    }
    agent.destroy()
  })

  it('fora de requisição (scheduler/webhook) NÃO existe dono — nada é escopado por engano', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/v1/quem-sou-eu',
      headers: { authorization: `Bearer ${tokenDe('user_x')}` },
    })

    // Depois da requisição terminar, código que roda fora dela (o tick do
    // scheduler, por exemplo) não pode herdar o dono de ninguém: se herdasse, as
    // queries do scheduler seriam silenciosamente filtradas por um cliente
    // aleatório.
    await new Promise((r) => setImmediate(r))
    expect(tenantContext.getStore()).toBeUndefined()
  })
})
