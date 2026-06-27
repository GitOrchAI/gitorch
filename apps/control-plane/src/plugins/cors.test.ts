import { describe, expect, it, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { corsPlugin } from './cors.js'

describe('CORS Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(corsPlugin)
    app.get('/api/test', async () => ({ ok: true }))
    await app.ready()
  })

  it('registers CORS plugin without error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' })
    expect(res.statusCode).toBe(200)
  })
})
