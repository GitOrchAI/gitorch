import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { securityHookPlugin } from './security.js'

describe('Security Plugin', () => {
  let app: any

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
