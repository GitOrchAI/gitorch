import { FastifyInstance, FastifyReply } from 'fastify'
import { metricsRegistry } from '../plugins/telemetry.js'
import { METRICS_PATH } from '../config/constants.js'

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // GET /metrics - Prometheus exposition format
  app.get(
    METRICS_PATH,
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (_request, reply: FastifyReply) => {
      reply.header('Content-Type', metricsRegistry.contentType)
      return metricsRegistry.metrics()
    }
  )
}
