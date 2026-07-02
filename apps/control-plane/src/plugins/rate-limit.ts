import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { FastifyRateLimitOptions } from '@fastify/rate-limit'
import { loadEnv } from '../config/env.js'

declare module 'fastify' {
  interface FastifyRequest {
    wingId?: string
  }
}

const env = loadEnv()

/**
 * Rate limit plugin for the control plane.
 * Uses environment variables for configuration and identifies clients by wingId or IP.
 */
export const rateLimitPlugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => {
      const ip = request.ip
      const wingId = request.wingId
      return wingId ? `wing:${wingId}` : `ip:${ip}`
    },
    errorMessage: 'Rate limit exceeded. Please slow down.',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    allowList: ['127.0.0.1', '::1'],
  } as FastifyRateLimitOptions)
}

Object.assign(rateLimitPlugin, { [Symbol.for('skip-override')]: true })
