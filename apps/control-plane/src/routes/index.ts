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
import { mintInstallationToken } from '../services/github-app-token.js'
import { GithubExecutionError } from '../services/github-errors.js'

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
    criarIssue: async ({ repo, titulo, corpo, etiquetas }) => {
      // Mesma credencial que os trilhos usam para escrever no repositório do
      // cliente: a instalação do App RESOLVIDA PELO REPOSITÓRIO. Sem passar o
      // repositório, o App emite o token da primeira instalação da lista — de
      // outra conta — e toda escrita volta 403.
      const token =
        process.env['GITORCH_GITHUB_TOKEN'] ??
        (await mintInstallationToken({
          repository: repo,
          onError: (m) => app.log.error(m),
          onWarn: (m) => app.log.warn(m),
        }))
      if (!token) {
        throw new GithubExecutionError(`sem credencial do GitHub para o repositório ${repo}`)
      }

      const resposta = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          authorization: `token ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: titulo, body: corpo, labels: etiquetas }),
      })
      if (!resposta.ok) {
        const detalhe = await resposta.text().catch(() => '')
        throw new GithubExecutionError(
          `GitHub POST /repos/${repo}/issues falhou (${resposta.status}): ${detalhe.slice(0, 150)}`
        )
      }
      const criada = (await resposta.json()) as { number?: number }
      if (typeof criada.number !== 'number') {
        throw new GithubExecutionError(`GitHub criou a issue em ${repo} sem devolver o número`)
      }
      return { numero: criada.number }
    },
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
