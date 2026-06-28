import { FastifyPluginAsync } from 'fastify'
import fastifyHelmet from '@fastify/helmet'

export const helmetPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'wss:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
}
