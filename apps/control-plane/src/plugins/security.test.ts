import { describe, test, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { securityHookPlugin, revokeGuestAccess, clearRevokedGuests } from './security.js'

describe('Security Plugin', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    await app.register(securityHookPlugin)
    app.get('/', async () => {
      return { success: true }
    })
    await app.ready()
  })

  it('should allow requests with normal headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        'X-Normal-Header': 'NormalValue',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })
  })

  it('should reject requests with tab in header value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        'X-Bad-Header': 'ValueWith\tTab',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Tab characters are not allowed in headers',
    })
  })

  it('should reject requests with tab in header name', async () => {
    // Fastify/Node might normalize header names, but let's try to inject it
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        ['X-Bad\tHeader' as string]: 'Value',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Tab characters are not allowed in headers',
    })
  })

  it('should reject requests with tab in array header value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        'X-Bad-Header': ['Value1', 'ValueWith\tTab'],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Tab characters are not allowed in headers',
    })
  })
})

describe('Guest Revocation in Security Plugin', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    app.decorateRequest(
      'user',
      null as unknown as { id: string; wingId: string; email?: string } | undefined
    )
    app.addHook('onRequest', async (req) => {
      req.user = { id: 'revoked-guest', wingId: 'w_123', email: 'guest@test.com' }
    })
    await app.register(securityHookPlugin)
    app.get('/test', async (_request, _reply) => {
      return { success: true }
    })
    clearRevokedGuests()
  })

  afterEach(async () => {
    await app.close()
    clearRevokedGuests()
  })

  test('should block revoked guest access', async () => {
    revokeGuestAccess('revoked-guest', 'testing block')

    const response = await app.inject({
      method: 'GET',
      url: '/test',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().message).toBe('Guest access revoked')
  })
})
