import { describe, expect, it, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { authPlugin } from './auth.js'

describe('Auth Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(authPlugin)
    app.get('/api/projects', async () => ({ projects: [] }))
    app.get('/health', async () => ({ status: 'ok' }))
    app.get('/ready', async () => ({ status: 'ready' }))
    app.get('/metrics', async () => 'metrics')
    app.post('/api/webhooks/github', async () => ({ ok: true }))
    await app.ready()
  })

  it('skips auth for public paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('skips auth for metrics endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
  })

  it('skips auth for ready endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
  })

  it('skips auth for webhook endpoint', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/github' })
    expect(res.statusCode).toBe(200)
  })
})
