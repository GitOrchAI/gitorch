import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { EventEmitter } from 'node:events'
import { ssePlugin } from './sse.js'

describe('SSE Plugin', () => {
  let app: ReturnType<typeof Fastify>
  const mockRedis = {
    exists: vi.fn(),
    del: vi.fn(),
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify()

    app.decorate('redis', mockRedis)
    app.decorate('emitter', new EventEmitter())

    await app.register(ssePlugin)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('registers SSE plugin without error', async () => {
    expect(true).toBe(true)
  })

  it('returns 401 if token does not exist in Redis', async () => {
    mockRedis.exists.mockResolvedValue(0)

    const res = await app.inject({
      method: 'GET',
      url: '/wait/invalidtoken',
    })

    expect(res.statusCode).toBe(401)
    expect(mockRedis.exists).toHaveBeenCalledWith('waiting_room:invalidtoken')
  })

  it('connects successfully and yields connected event if token exists', async () => {
    mockRedis.exists.mockResolvedValue(1)

    // Using LightMyRequest stream approach avoids hanging
    // but the simplest is just testing the SSE reply logic.
    // However, if we do a real network request using app.server.address, we can abort it.
    await app.listen({ port: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = (app.server.address() as any).port

    const resPromise = fetch(`http://localhost:${port}/wait/validtoken`)

    setTimeout(() => {
      app.emitter.emit('guest_status_changed', { token: 'validtoken', status: 'approved' })
    }, 50)

    const res = await resPromise
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body?.getReader()
    let data = ''
    while (true) {
      const { done, value } = await reader!.read()
      if (value) {
        data += new TextDecoder().decode(value)
      }
      if (data.includes('approved') || done) {
        break
      }
    }

    // Abort the fetch request to close the connection
    reader!.cancel()

    expect(data).toContain('event: connected')
    expect(data).toContain('data: {"token":"validtoken"}')
    expect(data).toContain('event: guest_status_changed')
    expect(data).toContain('"status":"approved"')
  })
})
