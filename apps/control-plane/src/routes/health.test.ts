import { test, expect, describe, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { healthRoutes } from './health.js'

describe('Health Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await healthRoutes(app)
    await app.ready()
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
})
