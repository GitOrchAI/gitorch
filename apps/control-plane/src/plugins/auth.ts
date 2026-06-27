import { FastifyPluginAsync } from 'fastify'
import { prisma, wingIdContext } from './prisma.js'
import { createHash } from 'crypto'

interface ApiKeyPayload {
  projectId: string
  wingId: string
  scopes: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyPayload
    wingId?: string
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export const authPlugin: FastifyPluginAsync = async (app) => {
  // API Key authentication
  app.addHook('preHandler', async (request) => {
    // Skip auth for health/metrics/public webhook
    const publicPaths = ['/health', '/ready', '/metrics', '/api/webhooks/github']
    if (publicPaths.some((p) => request.url.startsWith(p))) return

    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('UNAUTHORIZED: Missing or invalid Authorization header')
    }

    const key = authHeader.slice(7) // Remove "Bearer "
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

  // JWT support for future F10 (GitHub OAuth)
  app.decorate('verifyJwt', async (_token: string) => {
    throw new Error('JWT not implemented yet')
  })
}
