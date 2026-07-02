import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HEALTH_CHECK_PATH, READINESS_PATH } from '../config/constants.js'
import { PrismaClient } from '@prisma/client'
import type { Redis as RedisType } from 'ioredis'

interface HealthCheckResult {
  status: 'ok' | 'not_ready'
  timestamp: string
  uptime: number
  checks?: {
    database: boolean
    redis: boolean
  }
}

// Extend FastifyInstance with our decorators
declare module 'fastify'
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: RedisType
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // GET /health - Liveness probe (k8s/systemd)
  // Always returns 200 if process is alive
  app.get(HEALTH_CHECK_PATH, async (_request: FastifyRequest, _reply: FastifyReply) => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  // GET /ready - Readiness probe (checks dependencies)
  // Returns 200 if ready, 503 if not ready
  app.get(READINESS_PATH, async (_request: FastifyRequest, reply: FastifyReply) => {
    const checks = {
      database: false,
      redis: false,
    }

    // Check database connection
    try {
      await app.prisma.$queryRaw`SELECT 1`
      checks.database = true
    } catch {
      checks.database = false
    }

    // Check Redis connection
    try {
      const redisPing = await app.redis.ping()
      checks.redis = redisPing === 'PONG'
    } catch {
      checks.redis = false
    }

    const isReady = checks.database && checks.redis

    const result: HealthCheckResult = {
      status: isReady ? 'ok' : 'not_ready',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    }

    if (!isReady) {
      return reply.code(503).send(result)
    }

    return result
  })
}
