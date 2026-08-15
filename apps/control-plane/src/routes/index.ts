import { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { metricsRoutes } from './metrics.js'
import { githubWebhookRoutes } from './github-webhook.js'
import { projectRoutes } from './projects.js'
import { missionRoutes } from './missions.js'
import { eventRoutes } from './events.js'
import { runtimeConfigRoutes } from './runtime-config.js'
import { authRoutes } from './auth.js'
import { githubAppInstallRoutes } from './github-app-install.js'
import { setupRoutes } from './setup.js'
import { billingRoutes } from './billing.js'
import { diagnoseRoutes } from './diagnose.js'
import { desejosRoutes } from './desejos.js'
import { criarIssueDeDesejo } from '../services/desejo-no-github.js'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Health and readiness endpoints
  await healthRoutes(app)

  // Metrics endpoint (Prometheus)
  await metricsRoutes(app)

  // GitHub webhook endpoint
  await githubWebhookRoutes(app)

  // Auth and Setup endpoints
  await authRoutes(app)
  await githubAppInstallRoutes(app)
  await setupRoutes(app)

  // Diagnóstico grátis (F1) — antes de existir Project/pagamento
  await diagnoseRoutes(app)

  // Projects CRUD endpoints
  await projectRoutes(app)

  // Missions trigger and status endpoints
  await missionRoutes(app)

  // Porta do desejo: pedido em linguagem natural vira a issue oficial.
  //
  // `wingId` do Project é o endereço do REPOSITÓRIO ("dono/repo"), não a chave
  // do tenant — por isso é ele que vira `githubRepo`. O filtro é por `userId`
  // (o DONO), como no painel: cruzar `request.wingId` (login do GitHub) com o
  // `wingId` do Project nunca casa.
  await app.register(desejosRoutes, {
    buscarProjeto: async ({ projectId, userId }) => {
      const projeto = await app.prisma.project.findFirst({
        where: { id: projectId, userId },
        select: { id: true, wingId: true },
      })
      return projeto ? { id: projeto.id, githubRepo: projeto.wingId } : null
    },
    // A escrita da issue mora no serviço porque o mensageiro (bot do Telegram)
    // registra o desejo pelo MESMO caminho — o pedido do dono nasce igual venha
    // da tela ou do celular.
    criarIssue: ({ repo, titulo, corpo, etiquetas }) =>
      criarIssueDeDesejo({
        repo,
        titulo,
        corpo,
        etiquetas,
        log: { onError: (m) => app.log.error(m), onWarn: (m) => app.log.warn(m) },
      }),
  })

  // Runtime Config endpoint
  await runtimeConfigRoutes(app)

  // Billing: pricing geo, checkout, webhook Stripe, waitlist
  await billingRoutes(app)

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
