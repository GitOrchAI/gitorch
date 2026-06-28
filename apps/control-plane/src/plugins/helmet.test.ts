import { describe, expect, it, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { helmetPlugin } from './helmet.js'

describe('Helmet Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(helmetPlugin)
    app.get('/api/test', async () => ({ ok: true }))
    await app.ready()
  })

  it('registers helmet plugin and sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' })
    expect(res.statusCode).toBe(200)
  })

  it('disables crossOriginEmbedderPolicy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' })
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined()
  })
})
