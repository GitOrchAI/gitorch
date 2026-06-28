import { FastifyPluginAsync } from 'fastify'
import fastifyCors from '@fastify/cors'

export const corsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyCors, {
    origin:
      process.env['NODE_ENV'] === 'production'
        ? ['https://mission-control.gitorch.dev'] // F9 domain
        : true, // allow all in dev
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-GitHub-Delivery', 'X-Hub-Signature-256'],
  })
}
