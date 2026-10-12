import { FastifyInstance } from 'fastify'
import { lerVersaoNoAr } from '../services/commit-publicado.js'

/**
 * `/api/v1/status` e `/api/v1/version`. A versão é pública (como `/health`):
 * quem publica e o painel conferem por fora, sem credencial, qual commit está
 * no ar e desde quando.
 */
export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/status', async () => ({
    status: 'operational',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/v1/version', async () => {
    const { commit, noArDesde } = lerVersaoNoAr()
    return { name: 'gitorch-control-plane', commit, noArDesde }
  })
}
