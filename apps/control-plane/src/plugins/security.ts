import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { getEnv } from '../config/env.js'
import { getInvitationRateLimitMax, getInvitationRateLimitKey } from './rate-limit-keys.js'
import { verifyInvitationToken } from '../lib/credential-crypto.js'
import fp from 'fastify-plugin'

const securityPlugin: FastifyPluginAsync = async (app) => {
  const env = getEnv()
  await app.register(rateLimit, {
    global: true,
    max: getInvitationRateLimitMax(env),
    timeWindow: '1 minute',
    keyGenerator: getInvitationRateLimitKey,
    allowList: (request: FastifyRequest) =>
      !request.url.startsWith('/api/v1/invitations/validate/'),
  })

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/v1/invitations/validate/')) {
      const match = request.url.match(/\/api\/v1\/invitations\/validate\/([^/?]+)/)
      if (match) {
        const token = match[1]
        if (!token || !/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(token)) {
          reply.code(403).send({ error: 'Invalid or tampered invitation token' })
          return reply
        }

        try {
          // Token is verified here. The payload is not used in this hook, but
          // throwing inside verifyInvitationToken catches tampered/expired tokens early.
          verifyInvitationToken(token)
        } catch (err: any) {
          if (err.message === 'Project invitation expired') {
            reply.code(401).send({ error: 'Project invitation expired' })
          } else {
            reply.code(403).send({ error: 'Invalid or tampered invitation token' })
          }
          return reply
        }
      }
    }
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

export const securityHookPlugin = fp(securityPlugin)
