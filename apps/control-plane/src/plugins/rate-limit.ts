import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import rateLimit, { RateLimitPluginOptions } from '@fastify/rate-limit'
import { loadEnv } from '../config/env.js'

declare module 'fastify' {
  interface FastifyRequest {
    wingId?: string
  }
}

const env = loadEnv()

/**
 * Rate limit plugin for the control plane.
 * Uses preHandler hook to ensure wingId context is established for multi-tenant rate limiting.
 * Identifies clients by wingId or IP.
 */
export const rateLimitPlugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    hook: 'preHandler',
    keyGenerator: (request: FastifyRequest) => {
      const ip = request.ip
      const wingId = request.wingId
      return wingId ? `wing:${wingId}` : `ip:${ip}`
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    allowList: ['127.0.0.1', '::1'],
  } as RateLimitPluginOptions)
}

Object.assign(rateLimitPlugin, { [Symbol.for('skip-override')]: true })
