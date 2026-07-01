import { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { metricsRoutes } from './metrics.js'
import { githubWebhookRoutes } from './github-webhook.js'
import { projectRoutes } from './projects.js'
import { missionRoutes } from './missions.js'
import { eventRoutes } from './events.js'
import { runtimeConfigRoutes } from './runtime-config.js'
import { authRoutes } from './auth.js'
import { setupRoutes } from './setup.js'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Health and readiness endpoints
  await healthRoutes(app)

  // Metrics endpoint (Prometheus)
  await metricsRoutes(app)

  // GitHub webhook endpoint
  await githubWebhookRoutes(app)

  // Auth and Setup endpoints
  await authRoutes(app)
  await setupRoutes(app)

  // Projects CRUD endpoints
  await projectRoutes(app)

  // Missions trigger and status endpoints
  await missionRoutes(app)

  // Runtime Config endpoint
  await runtimeConfigRoutes(app)

  // Events SSE endpoint
  await eventRoutes(app)

  app.get('/api/v1/status', async () => ({
    status: 'operational',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/v1/version', async () => ({
    version: '0.1.0',
    name: 'gitorch-control-plane',
    timestamp: new Date().toISOString(),
  }))
}
