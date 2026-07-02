import { FastifyPluginAsync } from 'fastify'
import { prisma, wingIdContext } from './prisma.js'
import { createHash } from 'node:crypto'
import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getEnv } from '../config/env.js'
import rateLimit from '@fastify/rate-limit'

interface ApiKeyPayload {
  projectId: string
  wingId: string
  scopes: string[]
}

interface UserPayload {
  id: string
  wingId: string
  githubToken?: string
  email?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyPayload
    wingId?: string
    user?: UserPayload
  }
}

function hashKeySHA256(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export const authPlugin: FastifyPluginAsync = async (app) => {
  // Register rate limiter for auth endpoints to protect expensive auth hooks from DoS
  await app.register(rateLimit, {
    max: 20,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (request) => request.ip,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    allowList: ['127.0.0.1', '::1'],
  })

  // API Key & JWT authentication
  app.addHook('preHandler', async (request) => {
    // Explicitly call rate limit before expensive auth logic
    await request.rateLimit()

    // Skip auth for health/metrics/public webhook
    const publicPaths = [
      '/health',
      '/ready',
      '/metrics',
      '/api/webhooks/github',
      '/api/v1/auth/github',
      '/api/v1/auth/github/callback',
    ]
    if (publicPaths.some((p) => request.url.startsWith(p))) return

    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('UNAUTHORIZED: Missing or invalid Authorization header')
    }

    const key = authHeader.slice(7) // Remove "Bearer "

    // If it looks like a JWT, verify it
    if (key.split('.').length === 3) {
      try {
        const env = getEnv()
        const decoded = jwt.verify(key, env.JWT_SECRET) as {
          userId: string
          wingId: string
          githubToken?: string
          email?: string
        }

        request.user = {
          id: decoded.userId,
          wingId: decoded.wingId,
          githubToken: decoded.githubToken || undefined,
          email: decoded.email || undefined,
        } as UserPayload
        request.wingId = decoded.wingId

        // Set wing_id context for Prisma RLS
        wingIdContext.run({ wingId: decoded.wingId }, () => {})
        return
      } catch (err) {
        throw new Error('UNAUTHORIZED: Invalid or expired JWT session')
      }
    }

    // Otherwise, treat as API Key
    const prefix = key.substring(0, 12)
    const apiKeys = await prisma.apiKey.findMany({
      where: { prefix, isActive: true },
      include: { project: true },
    })

    let apiKey = null
    for (const candidate of apiKeys) {
      const isBcrypt = candidate.keyHash.startsWith('$2a$') || candidate.keyHash.startsWith('$2b$')
      let isValid = false

      if (isBcrypt) {
        isValid = await bcryptjs.compare(key, candidate.keyHash)
      } else {
        // Fallback for legacy SHA256 keys
        isValid = candidate.keyHash === hashKeySHA256(key)
      }

      if (isValid) {
        apiKey = candidate
        break
      }
    }

    if (!apiKey || !apiKey.project.isActive) {
      throw new Error('UNAUTHORIZED: Invalid or revoked API key')
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      throw new Error('UNAUTHORIZED: API key expired')
    }

    // Update last used
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })

    // Attach to request
    request.apiKey = {
      projectId: apiKey.projectId,
      wingId: apiKey.project.wingId,
      scopes: apiKey.scopes,
    }
    request.wingId = apiKey.project.wingId

    // Set wing_id context for Prisma RLS
    wingIdContext.run({ wingId: apiKey.project.wingId }, () => {})
  })

  // JWT helper decorator
  app.decorate('verifyJwt', async (token: string) => {
    const env = getEnv()
    return jwt.verify(token, env.JWT_SECRET) as UserPayload
  })
}
