import { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { metricsRoutes } from './metrics.js'
import { githubWebhookRoutes } from './github-webhook.js'
import { projectRoutes } from './projects.js'
import { missionRoutes } from './missions.js'
import { eventRoutes } from './events.js'
import { runtimeConfigRoutes } from './runtime-config.js'
import { avisoDePublicacaoRoutes } from './aviso-de-publicacao.js'
import { contaDoDevRoutes } from './conta-do-dev.js'
import { authRoutes } from './auth.js'
import { githubAppInstallRoutes } from './github-app-install.js'
import { setupRoutes } from './setup.js'
import { billingRoutes } from './billing.js'
import { diagnoseRoutes } from './diagnose.js'
import { desejosRoutes } from './desejos.js'
import { criarIssueDeDesejo } from '../services/desejo-no-github.js'
import { projetoParaDesejo, projetosParaDesejo } from '../services/projetos-do-desejo.js'
import { provaDeEscritaNoUso } from '../services/acesso-ao-repositorio.js'
import { fetchImplParaProvaDeAcesso } from '../services/fake-github-access.js'

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
  // Quem decide QUAL projeto aceita o pedido é `services/projetos-do-desejo.ts`,
  // a MESMA regra que o mensageiro usa (plugins/telegram.ts). Enquanto cada
  // porta escreveu a própria consulta, elas divergiram: esta aceitava projeto
  // desativado e a outra dizia ao mesmo dono que ele não tinha projeto nenhum.
  await app.register(desejosRoutes, {
    buscarProjeto: ({ projectId, userId }) => projetoParaDesejo(app.prisma, { projectId, userId }),
    // A lista que a TELA mostra sai da mesma regra do aceite acima. Antes ela
    // era deduzida da tela de setup, que não olha se o projeto está ativo: a
    // tela oferecia projeto que o envio recusava, e escondia projeto que o
    // envio aceitaria.
    listarProjetos: (userId) => projetosParaDesejo(app.prisma, userId),
    // Quem assina a issue é a pessoa, com o que o cadastro tem de legível —
    // nome e login do GitHub. O e-mail fica de fora de propósito: a issue pode
    // nascer em repositório público, e publicar o e-mail de alguém não é
    // assinatura, é vazamento.
    buscarAutor: async (userId) => {
      const dono = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, githubLogin: true },
      })
      return dono ? { nome: dono.name, arroba: dono.githubLogin } : null
    },
    // Defesa em profundidade: o acesso ao repositório foi provado UMA vez, no
    // wizard, e o endereço virou `project.wingId` para sempre. Se a organização
    // remove a pessoa depois, o projeto continua ativo apontando para
    // repositório alheio — e o pedido daqui viraria escrita real lá dentro. A
    // MESMA prova roda no mensageiro (plugins/telegram.ts): uma pergunta, dois
    // lugares, nenhuma chance de divergirem.
    confirmarAcesso: provaDeEscritaNoUso(app.engineConnections, fetchImplParaProvaDeAcesso()),
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
  await avisoDePublicacaoRoutes(app)
  await contaDoDevRoutes(app)

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
