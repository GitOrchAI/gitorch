import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { prisma, wingIdContext } from './prisma.js'
import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcryptjs from 'bcryptjs'
import { getEnv } from '../config/env.js'

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

// Erro de autenticação deve responder 401, não 500: o statusCode é honrado
// pelo error handler padrão do Fastify.
function unauthorized(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = 401
  return error
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
  const publicPaths = [
    '/health',
    '/ready',
    '/metrics',
    '/api/webhooks/github',
    '/api/v1/auth/github',
    '/api/v1/auth/github/callback',
  ]

  const isPublicPath = (url: string) => publicPaths.some((p) => url.startsWith(p))

  // API Key & JWT authentication
  app.addHook('preHandler', async (request, reply) => {
    // Skip auth for health/metrics/public webhook
    if (isPublicPath(request.url)) return

    // Explicitly enforce rate limiting before expensive auth/database work.
    const limiter = request.server.rateLimit({
      max: 20,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip,
      allowList: (req) => {
        if (isPublicPath(req.url)) return true
        if (req.ip === '127.0.0.1' || req.ip === '::1') return true
        return false
      },
    })
    await limiter.call(request.server, request, reply)

    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw unauthorized('UNAUTHORIZED: Missing or invalid Authorization header')
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
        throw unauthorized('UNAUTHORIZED: Invalid or expired JWT session')
      }
    }

    // Otherwise, treat as API Key - prefix-based lookup with bcrypt/SHA256 verification
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
        // codeql [js/insufficient-password-hash]
        isValid = candidate.keyHash === hashKeySHA256(key)
      }

      if (isValid) {
        apiKey = candidate
        break
      }
    }

    if (!apiKey || !apiKey.project.isActive) {
      throw unauthorized('UNAUTHORIZED: Invalid or revoked API key')
    }

    // Verify key hash (supports bcrypt and legacy sha256)
    const isBcrypt = apiKey.keyHash.startsWith('$2a$') || apiKey.keyHash.startsWith('$2b$')
    // codeql [js/insufficient-password-hash]
    const isValid = isBcrypt
      ? await bcryptjs.compare(key, apiKey.keyHash)
      : hashKeySHA256(key) === apiKey.keyHash

    if (!isValid) {
      throw unauthorized('UNAUTHORIZED: Invalid or revoked API key')
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      throw unauthorized('UNAUTHORIZED: API key expired')
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

export const authPlugin = fp(authPluginImpl)
