import { describe, expect, it, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { ssePlugin } from './sse.js'

describe('SSE Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(ssePlugin)
    await app.ready()
  })

  it('registers SSE plugin without error', async () => {
    // Just verify the plugin registers without throwing
    expect(true).toBe(true)
  })
})
