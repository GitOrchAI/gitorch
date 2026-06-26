import { FastifyInstance } from 'fastify'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
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
