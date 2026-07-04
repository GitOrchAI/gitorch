import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { EngineConnectionService } from '../services/engine-connection.js'

// Expõe o serviço de conexões de motor e as rotas do usuário para ver/gerir
// suas conexões. A credencial cifrada NUNCA é retornada — apenas o status.
const enginesPluginImpl: FastifyPluginAsync = async (app) => {
  const service = new EngineConnectionService(app.prisma)
  app.decorate('engineConnections', service)

  // Lista as conexões de motor do usuário autenticado (só status).
  app.get('/api/v1/engines', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    return reply.send({ engines: await service.list(userId) })
  })

  // Revoga (desconecta) um motor do usuário.
  app.delete('/api/v1/engines/:runtime', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { runtime } = request.params as { runtime: string }
    await service.revoke(userId, runtime)
    return reply.send({ revoked: true, runtime })
  })

  // Atualiza e retorna o catálogo de modelos do provider (descoberto ao vivo).
  app.post('/api/v1/engines/:runtime/models/refresh', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { runtime } = request.params as { runtime: string }
    const models = await service.refreshModels(userId, runtime)
    return reply.send({ runtime, models })
  })
}

// Resolve o id do usuário-dono a partir da sessão (email do JWT).
async function resolveUserId(
  app: Parameters<FastifyPluginAsync>[0],
  request: { user?: { email?: string } }
): Promise<string | null> {
  const email = request.user?.email
  if (!email) return null
  const user = await app.prisma.user.findUnique({ where: { email } })
  return user?.id ?? null
}

export const enginesPlugin = fp(enginesPluginImpl)

declare module 'fastify' {
  interface FastifyInstance {
    engineConnections: EngineConnectionService
  }
}
