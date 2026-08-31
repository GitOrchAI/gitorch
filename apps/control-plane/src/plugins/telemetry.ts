import { FastifyPluginAsync } from 'fastify'
import client from 'prom-client'
import { parsePipelineError } from '../config/pipeline-check.js'

// Create a Registry to register metrics
export const metricsRegistry = new client.Registry()

// Default metrics collection moved to plugin scope to allow cleanup in tests

// Custom metrics
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status', 'wing_id'],
  registers: [metricsRegistry],
})

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'wing_id'],
  registers: [metricsRegistry],
})

export const activeMissions = new client.Gauge({
  name: 'active_missions',
  help: 'Currently active missions',
  labelNames: ['wing_id'],
  registers: [metricsRegistry],
})

export const sseConnections = new client.Gauge({
  name: 'sse_connections',
  help: 'Active SSE connections per wing',
  labelNames: ['wing_id'],
  registers: [metricsRegistry],
})

// Extend FastifyRequest to add startTime
declare module 'fastify' {
  interface FastifyRequest {
    startTime?: bigint
  }
  interface FastifyInstance {
    trackPipelineError(error: unknown, stepContext: string): void
  }
}

let defaultMetricsInterval: ReturnType<typeof client.collectDefaultMetrics> | undefined

export const telemetryPlugin: FastifyPluginAsync = async (app) => {
  if (!defaultMetricsInterval && process.env['NODE_ENV'] !== 'test') {
    defaultMetricsInterval = client.collectDefaultMetrics({ register: metricsRegistry })
  }

  // Request metrics
  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint()
  })

  app.addHook('onResponse', async (request, reply) => {
    if (!request.startTime) return
    const duration = Number(process.hrtime.bigint() - request.startTime) / 1e9
    const wingId = request.wingId || 'unknown'

    httpRequestsTotal.inc({
      method: request.method,
      route: request.routeOptions?.url || 'unknown',
      status: reply.statusCode.toString(),
      wing_id: wingId,
    })

    httpRequestDuration.observe(
      { method: request.method, route: request.routeOptions?.url || 'unknown', wing_id: wingId },
      duration
    )
  })

  app.addHook('onClose', async () => {
    if (defaultMetricsInterval) {
      clearInterval(defaultMetricsInterval)
      defaultMetricsInterval = undefined
    }
    metricsRegistry.clear()
  })

  app.decorate('trackPipelineError', function (error: unknown, stepContext: string) {
    const metadata = parsePipelineError(error, stepContext)
    app.log.error(
      {
        step: metadata.step,
        reason: metadata.reason,
        mitigationAction: metadata.mitigationAction,
        requiresAction: metadata.requiresAction,
        err: error,
      },
      'Pipeline error tracked'
    )
    if ('broadcastEvent' in app) {
      app.broadcastEvent('global', 'pipeline.error', metadata)
    }
    if ('emitter' in app) {
      // @ts-ignore - emitter is dynamically added by other plugins or in index
      app.emitter.emit('pipeline.error', metadata)
    }
  })
}
Object.assign(telemetryPlugin, { [Symbol.for('skip-override')]: true })
