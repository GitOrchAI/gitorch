import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv, resetEnvCache } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { healthRoutes } from './health.js'

describe('Health Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    // Zera a allowlist (achado M2): request.ip via app.inject() sem
    // X-Forwarded-For é '127.0.0.1', que está no default de
    // GITORCH_RATE_LIMIT_ALLOWLIST ('127.0.0.1,::1'). Antes da correção do
    // achado M2 a allowlist era inerte (comparava contra a chave
    // pós-keyGenerator, nunca contra o IP cru) e headers de rate limit
    // sempre apareciam por acidente; agora que funciona de verdade, o teste
    // abaixo (cujo ponto é provar que os headers existem) precisa de um IP
    // fora da allowlist — igual à produção atrás do Funnel (GITORCH_RATE_LIMIT_ALLOWLIST=).
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = ''
    resetEnvCache()

    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await healthRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    delete process.env['GITORCH_RATE_LIMIT_ALLOWLIST']
    resetEnvCache()
  })

  test('GET /health returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })

  test('GET /ready returns ready when deps healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json().checks).toEqual({ database: true, redis: true })
  })

  test('GET /ready has rate limit headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.headers).toHaveProperty('x-ratelimit-limit')
    expect(res.headers).toHaveProperty('x-ratelimit-remaining')
    expect(res.headers).toHaveProperty('x-ratelimit-reset')
  })
})
