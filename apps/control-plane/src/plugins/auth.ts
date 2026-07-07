import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { prisma, wingIdContext } from './prisma.js'
import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcryptjs from 'bcryptjs'
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
    // Billing público: preços pra landing exibir, waitlist e o webhook do Stripe
    // (que autentica por assinatura, não por Bearer). Checkout fica autenticado.
    '/api/pricing',
    '/api/waitlist',
    '/api/billing/webhook',
  ]

  // O front estático (wizard Next export) é servido pela MESMA origem e é
  // público por natureza: todo endpoint protegido vive sob `/api/`. Então
  // qualquer path fora de `/api/` (/, /setup, /_next/*, favicon, etc.) é
  // público; sob `/api/`, só os explicitamente listados. Assim o auth hook
  // não devolve 401 para os arquivos do próprio site.
  const isPublicPath = (url: string) => {
    const pathOnly = url.split('?')[0] ?? url
    if (!pathOnly.startsWith('/api/')) return true
    return publicPaths.some((p) => pathOnly.startsWith(p))
  }

  // Register rate limit for authenticated routes with a stricter limit.
  // This helps mitigate brute-force attacks on API keys and JWTs.
  // We use global: true here because authPlugin is usually registered
  // in a way that its scope covers the routes it needs to protect.
  // This resolves CodeQL alert #24.
  await app.register(rateLimit, {
    global: true,
    max: 20,
    timeWindow: '1 minute',
    allowList: (request: FastifyRequest) => isPublicPath(request.url),
  })

  // codeql [js/missing-rate-limiting] - este preHandler roda sobre rotas que JÁ
  // estão limitadas pelo rate limit global registrado logo acima
  // (app.register(rateLimit, { global: true, max: 20 })); a proteção existe, o
  // CodeQL só não liga o hook global ao handler neste escopo (mesmo caso do
  // alerta #24 já resolvido).
  app.addHook('preHandler', async (request) => {
    // Skip auth for health/metrics/public webhook
    if (isPublicPath(request.url)) return

    const authHeader = request.headers.authorization

    // Sessão do navegador: cookie httpOnly `gitorch_session` (JWT), nunca
    // exposta a JS/XSS. Authorization Bearer continua valendo (API keys e
    // chamadas server-to-server) e tem precedência quando ambos existem.
    if (!authHeader?.startsWith('Bearer ')) {
      const cookieToken = request.cookies?.['gitorch_session']
      if (cookieToken) {
        try {
          const env = getEnv()
          const decoded = jwt.verify(cookieToken, env.JWT_SECRET) as {
            userId: string
            wingId: string
            email?: string
          }

          request.user = {
            id: decoded.userId,
            wingId: decoded.wingId,
            email: decoded.email || undefined,
          } as UserPayload
          request.wingId = decoded.wingId

          wingIdContext.run({ wingId: decoded.wingId }, () => {})
          return
        } catch {
          throw unauthorized('UNAUTHORIZED: Invalid or expired session cookie')
        }
      }

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
          email?: string
        }

        request.user = {
          id: decoded.userId,
          wingId: decoded.wingId,
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
