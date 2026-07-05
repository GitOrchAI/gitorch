import { FastifyPluginAsync } from 'fastify'
import fastifyCors from '@fastify/cors'

export const corsPlugin: FastifyPluginAsync = async (app) => {
  // Origens por CONFIG (CORS_ORIGIN: lista separada por vírgula; '*' libera) —
  // domínio hardcoded aqui já bloqueou frontend real em produção.
  const raw = process.env['CORS_ORIGIN'] ?? '*'
  const origin = raw.trim() === '*' ? true : raw.split(',').map((o) => o.trim())
  await app.register(fastifyCors, {
    origin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-GitHub-Delivery', 'X-Hub-Signature-256'],
  })
}
