import { FastifyPluginAsync } from 'fastify'
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

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export const authPlugin: FastifyPluginAsync = async (app) => {
  // API Key & JWT authentication
  app.addHook('preHandler', async (request) => {
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

    if (!apiKeys || apiKeys.length === 0) {
      throw new Error('UNAUTHORIZED: Invalid or revoked API key')
    }

    let authenticatedApiKey = null

    for (const ak of apiKeys) {
      if (!ak.project.isActive) continue

      // Verify key hash (supports bcrypt and legacy sha256)
      const isBcrypt = ak.keyHash.startsWith('$2a$') || ak.keyHash.startsWith('$2b$')
      // codeql [js/insufficient-password-hash]
      const isValid = isBcrypt
        ? await bcryptjs.compare(key, ak.keyHash)
        : hashKey(key) === ak.keyHash

      if (isValid) {
        authenticatedApiKey = ak
        break
      }
    }

    if (!authenticatedApiKey) {
      throw new Error('UNAUTHORIZED: Invalid or revoked API key')
    }

    if (authenticatedApiKey.expiresAt && new Date(authenticatedApiKey.expiresAt) < new Date()) {
      throw new Error('UNAUTHORIZED: API key expired')
    }

    // Update last used
    await prisma.apiKey.update({
      where: { id: authenticatedApiKey.id },
      data: { lastUsedAt: new Date() },
    })

    // Attach to request
    request.apiKey = {
      projectId: authenticatedApiKey.projectId,
      wingId: authenticatedApiKey.project.wingId,
      scopes: authenticatedApiKey.scopes,
    }
    request.wingId = authenticatedApiKey.project.wingId

    // Set wing_id context for Prisma RLS
    wingIdContext.run({ wingId: authenticatedApiKey.project.wingId }, () => {})
  })

  // JWT helper decorator
  app.decorate('verifyJwt', async (token: string) => {
    const env = getEnv()
    return jwt.verify(token, env.JWT_SECRET) as UserPayload
  })
}
