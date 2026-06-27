import { describe, expect, it, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { rateLimitPlugin } from './rate-limit.js'

describe('Rate Limit Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(rateLimitPlugin, { max: 100, windowMs: 60000 })
    app.get('/api/test', async () => ({ ok: true }))
    await app.ready()
  })

  it('registers rate-limit plugin without error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' })
    expect(res.statusCode).toBe(200)
  })
})
