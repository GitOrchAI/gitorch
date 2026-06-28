import { FastifyInstance, FastifyReply } from 'fastify'
import { metricsRegistry } from '../plugins/telemetry.js'
import { METRICS_PATH } from '../config/constants.js'

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // GET /metrics - Prometheus exposition format
  app.get(METRICS_PATH, async (_request, reply: FastifyReply) => {
    reply.header('Content-Type', metricsRegistry.contentType)
    return metricsRegistry.metrics()
  })
}
