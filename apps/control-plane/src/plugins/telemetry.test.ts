import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { telemetryPlugin } from './telemetry.js'
import { metricsRoutes } from '../routes/metrics.js'

describe('Telemetry Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(telemetryPlugin, { serviceName: 'test-service' })
    await app.register(metricsRoutes)
    app.get('/api/test', async () => ({ ok: true }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('registers telemetry plugin and exposes metrics endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('records http request metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' })
    expect(res.statusCode).toBe(200)
  })
})
