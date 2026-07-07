import { describe, expect, it, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { authPlugin } from './auth.js'
import rateLimit from '@fastify/rate-limit'

// Mesmo segredo que src/test/setup.ts injeta globalmente — getEnv() cacheia
// no primeiro uso, então sobrescrever process.env aqui não teria efeito.
const JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long'

describe('Auth Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(fastifyCookie)
    await app.register(rateLimit)
    await app.register(authPlugin)
    app.get('/api/projects', async (request: FastifyRequest) => ({
      projects: [],
      user: request.user ?? null,
    }))
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

  it('authenticates via gitorch_session cookie when no Authorization header is present', async () => {
    const token = jwt.sign({ userId: 'user_1', wingId: 'wing_1' }, JWT_SECRET)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: token },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: 'user_1', wingId: 'wing_1' })
  })

  it('rejects an invalid gitorch_session cookie with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: 'not-a-valid-jwt' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('prefers Authorization header over cookie when both are present', async () => {
    const cookieToken = jwt.sign({ userId: 'cookie_user', wingId: 'wing_cookie' }, JWT_SECRET)
    const headerToken = jwt.sign({ userId: 'header_user', wingId: 'wing_header' }, JWT_SECRET)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: cookieToken },
      headers: { authorization: `Bearer ${headerToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: 'header_user' })
  })
})
