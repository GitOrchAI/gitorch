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

  // /qa achou isso ao vivo: um cliente cross-origin (web estático + API em
  // domínio separado, a topologia real de produção) recebia
  // "Method DELETE is not allowed by Access-Control-Allow-Methods" no
  // preflight ao tentar desconectar um motor — DELETE /api/v1/engines/:runtime
  // nunca era alcançável fora do mesmo host.
  it('allows a DELETE preflight (disconnecting an engine) cross-origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/test',
      headers: {
        origin: 'http://localhost:3011',
        'access-control-request-method': 'DELETE',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('DELETE')
  })
})
