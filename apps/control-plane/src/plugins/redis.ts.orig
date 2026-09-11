import { EventEmitter } from 'node:events'
import { FastifyPluginAsync } from 'fastify'
import Redis from 'ioredis'
import type { Redis as RedisType } from 'ioredis'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisType
    emitter: EventEmitter
    setWaitingRoomSession: (token: string, ttl: number) => Promise<void>
    publishGuestStatus: (token: string, status: string) => Promise<void>
  }
}

export function createRedisClient(
  redisUrl?: string,
  RedisCtor?: new (...args: unknown[]) => RedisType
): RedisType {
  const url = redisUrl || env.REDIS_URL
  const Ctor = (RedisCtor || Redis) as new (...args: unknown[]) => RedisType
  const redis = new Ctor(url, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    enableReadyCheck: true,
    lazyConnect: true,
  })
  return redis
}

export const redisPlugin: FastifyPluginAsync = async (app) => {
  try {
    if (!('emitter' in app)) {
      app.decorate('emitter', new EventEmitter())
    }

    const redis = createRedisClient()
    const redisSubscriber = createRedisClient()

    redis.on('error', (err: Error) => app.log.error({ err }, 'Redis error'))
    redisSubscriber.on('error', (err: Error) => app.log.error({ err }, 'Redis subscriber error'))

    await Promise.all([redis.connect(), redisSubscriber.connect()])

    app.decorate('redis', redis)

    app.decorate('setWaitingRoomSession', async (token: string, ttl: number) => {
      await redis.set(`waiting_room:${token}`, 'pending', 'EX', ttl)
    })

    app.decorate('publishGuestStatus', async (token: string, status: string) => {
      const message = JSON.stringify({ token, status })
      await redis.publish('guest_status_changed', message)
    })

    redisSubscriber.on('message', (channel, message) => {
      if (channel === 'guest_status_changed') {
        try {
          const data = JSON.parse(message)
          app.emitter.emit('guest_status_changed', data)
        } catch (e) {
          app.log.error({ err: e }, 'Failed to parse guest_status_changed message')
        }
      }
    })

    await redisSubscriber.subscribe('guest_status_changed')

    app.addHook('onClose', async () => {
      await Promise.all([redis.quit(), redisSubscriber.quit()])
    })
  } catch (e) {
    throw e
  }
}

Object.assign(redisPlugin, { [Symbol.for('skip-override')]: true })
