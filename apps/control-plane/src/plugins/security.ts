import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

const securityPlugin: FastifyPluginAsync = async (app) => {
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
