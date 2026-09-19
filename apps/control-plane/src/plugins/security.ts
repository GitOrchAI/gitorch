import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { getEnv } from '../config/env.js'
import { getInvitationRateLimitMax } from './rate-limit-keys.js'
import fp from 'fastify-plugin'

const securityPlugin: FastifyPluginAsync = async (app) => {
  const env = getEnv()
  await app.register(rateLimit, {
    global: true,
    max: getInvitationRateLimitMax(env),
    timeWindow: '1 minute',
    allowList: (request: FastifyRequest) =>
      !request.url.startsWith('/api/v1/invitations/validate/'),
  })

  app.addHook('onRequest', async (request, reply) => {
    const headers = request.headers
    for (const [key, value] of Object.entries(headers)) {
      if (key.includes('\t') || (typeof value === 'string' && value.includes('\t'))) {
        reply.code(400).send({
          error: 'Bad Request',
          message: 'Tab characters are not allowed in headers',
        })
        return
      }
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v.includes('\t')) {
            reply.code(400).send({
              error: 'Bad Request',
              message: 'Tab characters are not allowed in headers',
            })
            return
          }
        }
      }
    }
  })
}

const revokedGuests = new Set<string>()

export function revokeGuestAccess(guestId: string, reason?: string): void {
  revokedGuests.add(guestId)
  if (reason) {
    console.log(`Guest security revoked: ${guestId}. Reason: ${reason}`)
  }
}

export function isGuestRevoked(guestId: string): boolean {
  return revokedGuests.has(guestId)
}

export function clearRevokedGuests(): void {
  revokedGuests.clear()
}

export const securityHookPlugin = fp(securityPlugin)
