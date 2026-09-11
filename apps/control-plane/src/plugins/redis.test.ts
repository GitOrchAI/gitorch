import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'

const mockRedisInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  subscribe: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
}

vi.mock('ioredis', () => {
  class MockRedis {
    constructor() {
      return mockRedisInstance
    }
  }
  return { default: MockRedis }
})

import { redisPlugin } from './redis.js'

describe('Redis Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify()

    app.get('/health', async () => ({ status: 'ok' }))

    await app.register(redisPlugin)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('app works', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('registers Redis plugin and decorates app', async () => {
    const hasRedis = app.hasDecorator('redis')
    console.error('DEBUG: hasDecorator redis:', hasRedis)
    console.error('DEBUG: app.redis:', app.redis)
    console.error('DEBUG: mock connect calls:', mockRedisInstance.connect.mock.calls.length)
    expect(hasRedis).toBe(true)
    expect(app.redis).toBeDefined()
    expect(mockRedisInstance.connect).toHaveBeenCalled()
  })

  it('setWaitingRoomSession calls redis.set with correct params', async () => {
    await app.setWaitingRoomSession('mytoken', 3600)
    expect(mockRedisInstance.set).toHaveBeenCalledWith(
      'waiting_room:mytoken',
      'pending',
      'EX',
      3600
    )
  })

  it('publishGuestStatus calls redis.publish with correct channel and message', async () => {
    await app.publishGuestStatus('mytoken', 'approved')
    expect(mockRedisInstance.publish).toHaveBeenCalledWith(
      'guest_status_changed',
      JSON.stringify({ token: 'mytoken', status: 'approved' })
    )
  })
})
