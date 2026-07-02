import { FastifyPluginAsync } from 'fastify'
import { prisma, wingIdContext } from './prisma.js'
import { createHash } from 'crypto'
import jwt from 'jsonwebtoken'
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
    // Ensure rate limiting is applied to the authentication process itself
    // to mitigate brute-force and DoS attacks on DB/JWT operations.
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
    const keyHash = hashKey(key)

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash, isActive: true },
      include: { project: true },
    })

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
