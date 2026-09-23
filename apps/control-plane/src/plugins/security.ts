import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { getEnv } from '../config/env.js'
import { getInvitationRateLimitMax, getCreateInvitationRateLimitMax } from './rate-limit-keys.js'
import fp from 'fastify-plugin'

const securityPlugin: FastifyPluginAsync = async (app) => {
  const env = getEnv()
  await app.register(rateLimit, {
    global: true,
    max: (request: FastifyRequest) => {
      if (request.url.endsWith('/invitations/create')) {
        return getCreateInvitationRateLimitMax()
      }
      if (
        request.url.startsWith('/api/v1/invitations/validate/') ||
        request.url.startsWith('/api/v1/invites/claim/') ||
        request.url.startsWith('/api/v1/invites/claim/')
      ) {
        return getInvitationRateLimitMax(env)
      }
      return 1000
    },
    timeWindow: '1 minute',
    allowList: (request: FastifyRequest) =>
      !(
        request.url.startsWith('/api/v1/invitations/validate/') ||
        request.url.startsWith('/api/v1/invites/claim/') ||
        request.url.endsWith('/invitations/create')
      ),
    keyGenerator: (request: FastifyRequest) => {
      if (
        request.url.startsWith('/api/v1/invitations/validate/') ||
        request.url.startsWith('/api/v1/invites/claim/') ||
        request.url.startsWith('/api/v1/invites/claim/')
      ) {
        const match = request.url.match(/\/api\/v1\/invitations\/validate\/([^/?]+)/)
        if (match) {
          return `${request.ip}-${match[1]}`
        }
      }
      return request.ip
    },
  })

  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.startsWith('/api/v1/invitations/validate/') ||
      request.url.startsWith('/api/v1/invites/claim/') ||
      request.url.startsWith('/api/v1/invites/claim/')
    ) {
      const match = request.url.match(/\/api\/v1\/invitations\/validate\/([^/?]+)/)
      if (match) {
        const token = match[1]
        // Sanitização: tokens HMAC neste sistema possuem formato payloadB64.expiration.signature
        // base64url usa apenas A-Z, a-z, 0-9, -, _
        if (token && !/^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/.test(token)) {
          reply.code(400).send({ error: 'Bad Request', message: 'Formato de token inválido' })
          return
        }
      }
    }

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
