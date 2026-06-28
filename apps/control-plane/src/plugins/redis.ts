import { FastifyPluginAsync } from 'fastify'
import Redis from 'ioredis'
import type { Redis as RedisType } from 'ioredis'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisType
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
    const redis = createRedisClient()

    redis.on('error', (err: Error) => app.log.error({ err }, 'Redis error'))

    await redis.connect()

    app.decorate('redis', redis)

    app.addHook('onClose', async () => {
      await redis.quit()
    })
  } catch (e) {
    throw e
  }
}

Object.assign(redisPlugin, { [Symbol.for('skip-override')]: true })
