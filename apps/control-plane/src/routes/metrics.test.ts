import { test, expect, describe, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { metricsRoutes } from './metrics.js'

describe('Metrics Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await metricsRoutes(app)
    await app.ready()
  })

  test('GET /metrics returns Prometheus format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.payload).toContain('http_requests_total')
  })
})
