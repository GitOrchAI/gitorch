import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import crypto from 'node:crypto'
import {
  GitHubWebhookNormalizer,
  GitHubSyncEngine,
  GitHubDeliveryEnvelope,
  GitHubWebhookEventName,
} from '@gitorch/github-sync'

import type { F6AgentRole } from '@gitorch/agents'
import { casarPrComSessao } from '../services/casar-pr-com-sessao.js'
import { mintInstallationToken } from '../services/github-app-token.js'
import { nomeDeRepositorioValido } from '../services/nome-de-repositorio.js'
import { enderecoPermitido } from '../services/endereco-seguro.js'
import { registrarPr, sessoesVivas, type PrismaDevSession } from '../services/dev-session-store.js'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    verifyGitHubWebhook: (payload: string, signature: string) => boolean
    // triggerAgentMission é declarado (globalmente) pelo scheduler; usamos aqui.
  }
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

const normalizer = new GitHubWebhookNormalizer()
const syncEngine = new GitHubSyncEngine()

// Label que marca uma issue como "desejo" (wishlist) para o RA analisar.
const WISHLIST_LABEL = 'wishlist'

// Decide qual missão de agente um evento do GitHub deve acordar (o "sistema
// nervoso" do loop). Retorna o papel a disparar, ou null se o evento não é um
// gatilho. É deliberadamente conservador: só dispara nos casos do loop SCRUM.
export function missionRoleForEvent(
  event: string | undefined,
  payload: {
    action?: string
    issue?: { labels?: Array<{ name?: string }> }
    pull_request?: { user?: { login?: string } }
    sender?: { login?: string }
    check_suite?: { pull_requests?: Array<{ number?: number }> }
    workflow_run?: { pull_requests?: Array<{ number?: number }> }
  }
): F6AgentRole | null {
  // Issue de wishlist recém-aberta -> o RA acorda e produz contexto.
  if (event === 'issues' && payload.action === 'opened') {
    const labels = (payload.issue?.labels ?? []).map((l) => (l.name ?? '').toLowerCase())
    if (labels.includes(WISHLIST_LABEL)) return 'ra'
  }
  // PR recém-aberto pelo Jules -> o QA acorda e julga.
  if (event === 'pull_request' && payload.action === 'opened') {
    const author = (payload.pull_request?.user?.login ?? payload.sender?.login ?? '').toLowerCase()
    if (author.includes('jules')) return 'qa'
  }
  // CI concluiu (passou ou falhou) -> o QA acorda para julgar o PR.
  //
  // Só quando o CI é DE UM PR. Antes acordava em qualquer conclusão, com o
  // argumento de que o QA é no-op sem PR delegado — mas "no-op" aqui não é
  // grátis: sobe container e gasta cota do motor do cliente. Num repositório
  // com CI ativo, cada push virava uma rajada de missões que só respondiam
  // "nada a julgar". Sem PR no evento, não há o que julgar: não acorda.
  if ((event === 'check_suite' || event === 'workflow_run') && payload.action === 'completed') {
    const prsDoEvento =
      payload.check_suite?.pull_requests ?? payload.workflow_run?.pull_requests ?? []
    return prsDoEvento.length > 0 ? 'qa' : null
  }
  return null
}

/**
 * Este aviso exige conferir se a verificação INTEIRA terminou antes de acordar?
 *
 * Um repositório com oito workflows dispara oito avisos de conclusão para o
 * mesmo commit — um por workflow que termina. O julgamento acordava em todos,
 * encontrava a entrega, via que ainda havia verificação rodando, e voltava
 * vazio. Medido em 23/08/2026: das trinta e quatro acordadas por aviso do
 * GitHub, vinte e seis devolveram "verificação em pending", e havia sondagens
 * do MESMO pull request separadas por quinze segundos.
 *
 * Só o ÚLTIMO desses avisos tem informação nova. Os outros sete são o mesmo
 * commit num estado que ainda não dá para julgar.
 *
 * A conferência custa uma chamada de API por aviso — barata perto de subir um
 * contêiner e gastar cota do motor do cliente, que é o que acontecia antes.
 */
export function precisaConferirSeOCiTerminou(
  event: string | undefined,
  payload: { action?: string }
): boolean {
  return (event === 'check_suite' || event === 'workflow_run') && payload.action === 'completed'
}

/** O commit que o aviso de verificação está falando. */
export function headDoAvisoDeVerificacao(payload: {
  check_suite?: { head_sha?: string }
  workflow_run?: { head_sha?: string }
}): string | null {
  return payload.check_suite?.head_sha ?? payload.workflow_run?.head_sha ?? null
}

/**
 * A verificação daquele commit terminou por inteiro?
 *
 * `null` quando não deu para saber — e quem chama trata isso como "pode
 * acordar". Na dúvida, acordar de menos é pior que acordar à toa: uma entrega
 * sem parecer fica parada para sempre, uma acordada em falso custa um
 * contêiner.
 */
export function verificacaoTerminou(
  runs: Array<{ status?: string }> | undefined | null
): boolean | null {
  if (!Array.isArray(runs) || runs.length === 0) return null
  return runs.every((r) => r.status === 'completed')
}

/**
 * Liga o pull request recém-nascido à tarefa que o produto delegou — AGORA.
 *
 * Antes disto a ligação só era gravada quando o dev externo reportava que
 * tinha terminado, e o número do PR vinha de um campo que ele preenche quando
 * quer. Medido em produção (20/08/2026): PR #132 aberto às 16:58, ligação
 * gravada às 23:28 — seis horas e meia. Dentro dessa janela o QA acorda pelo
 * aviso do CI, não encontra a linha, e julga a própria entrega do produto como
 * obra de terceiro: o parecer sai como comentário e leva junto a frase "esta
 * entrega não foi encomendada pelo produto", escrita no repositório do
 * CLIENTE. A mesclagem, que exige aprovação formal, nunca acontece.
 *
 * O aviso de "pull request aberto" chega no segundo zero e já traz o
 * identificador da sessão no branch. Gravar aqui fecha a janela.
 *
 * Devolve o que foi ligado, ou `null` quando não havia o que ligar — que é o
 * caso normal de um pull request de humano.
 */
export async function ligarPrDaEntrega(deps: {
  prisma: PrismaDevSession
  projectId: string
  event: string | undefined
  payload: {
    action?: string
    pull_request?: { number?: number; body?: string; head?: { ref?: string } }
  }
  agora?: Date
}): Promise<{ sessionName: string; numeroDoPr: number } | null> {
  if (deps.event !== 'pull_request') return null
  if (deps.payload.action !== 'opened' && deps.payload.action !== 'reopened') return null

  const numeroDoPr = deps.payload.pull_request?.number
  if (typeof numeroDoPr !== 'number') return null

  const sessoes = await sessoesVivas({ prisma: deps.prisma, projectId: deps.projectId })
  if (sessoes.length === 0) return null

  const casamento = casarPrComSessao({
    headRefName: deps.payload.pull_request?.head?.ref,
    corpo: deps.payload.pull_request?.body,
    numeroDoPr,
    sessoes,
  })
  if (!casamento) return null

  await registrarPr({
    prisma: deps.prisma,
    sessionName: casamento.sessionName,
    numeroDoPr,
    agora: deps.agora ?? new Date(),
  })
  return { sessionName: casamento.sessionName, numeroDoPr }
}

// Map GitHub event header to supported event names
function toGitHubEventName(event: string | undefined): GitHubWebhookEventName {
  const supported: GitHubWebhookEventName[] = [
    'ping',
    'issues',
    'pull_request',
    'sub_issues',
    'issue_dependencies',
    'projects_v2',
    'projects_v2_item',
    'projects_v2_status_update',
  ]
  return supported.includes(event as GitHubWebhookEventName)
    ? (event as GitHubWebhookEventName)
    : 'ping'
}

/**
 * Como o projeto desta entrega foi encontrado. A assinatura HMAC prova que o
 * aviso veio do GitHub; ela NÃO diz a qual projeto do gitorch ele pertence.
 * Quem responde isso é o critério abaixo — e eles têm forças muito diferentes:
 *
 * - `repoId`: identificador numérico do repositório, atribuído pelo GitHub,
 *   único e imutável (sobrevive a renomear e a transferir). É prova.
 * - `wingId`: o endereço "dono/repositorio" que o CLIENTE declarou no wizard.
 *   O wizard confere se ele tem acesso de escrita ali, mas o endereço muda
 *   quando o repositório é renomeado e pode ser declarado por mais de um
 *   cliente (dois colaboradores do mesmo repositório). É indício, não prova.
 * - `instalacao`: a instalação do App cobre MUITOS repositórios de uma conta.
 *   Casar por ela uma entrega que fala de UM repositório entregaria a um
 *   projeto os avisos de todos os outros repositórios daquela conta — por isso
 *   ela só vale para entrega que não traz repositório nenhum (evento de quadro
 *   ou de ciclo de vida da instalação).
 */
type CriterioDeCasamento = 'repoId' | 'wingId' | 'instalacao'

interface ProjetoDaEntrega {
  id: string
  wingId: string
  githubInstallationId: number | null
  githubRepoId: bigint | null
}

interface Casamento {
  projeto: ProjetoDaEntrega
  criterio: CriterioDeCasamento
  /** Mais de um projeto declarou este mesmo endereço: o escolhido pode ser o errado. */
  empatado: boolean
}

const CAMPOS_DO_PROJETO = {
  id: true,
  wingId: true,
  githubInstallationId: true,
  githubRepoId: true,
} as const

/**
 * Procura o projeto da entrega do critério MAIS FORTE para o mais fraco, em
 * vez de um `OU` cego entre os três. O `OU` deixava o banco escolher qualquer
 * linha que satisfizesse qualquer um deles — na prática, a instalação (a mais
 * ampla) competia de igual para igual com o identificador do repositório.
 */
async function casarProjeto(
  prisma: PrismaClient,
  entrega: {
    repoId: number | undefined
    repoFullName: string | undefined
    installationId: number | undefined
  }
): Promise<Casamento | null> {
  if (entrega.repoId) {
    const porId = await prisma.project.findFirst({
      where: { githubRepoId: BigInt(entrega.repoId) },
      select: CAMPOS_DO_PROJETO,
    })
    if (porId) return { projeto: porId, criterio: 'repoId', empatado: false }
  }

  if (entrega.repoFullName) {
    // `take: 2` porque a única pergunta que interessa além de "quem?" é "tem
    // mais de um?". `createdAt asc` fixa o destino entre entregas, como antes.
    const candidatos = await prisma.project.findMany({
      where: { wingId: entrega.repoFullName },
      orderBy: { createdAt: 'asc' },
      take: 2,
      select: CAMPOS_DO_PROJETO,
    })
    const primeiro = candidatos[0]
    if (primeiro) {
      return { projeto: primeiro, criterio: 'wingId', empatado: candidatos.length > 1 }
    }
  }

  // Só entrega SEM repositório chega aqui: quando há repositório e nem o id nem
  // o endereço acharam dono, a resposta certa é "não é de ninguém" — nunca
  // "então fica com quem tem a mesma instalação".
  if (entrega.installationId && !entrega.repoId && !entrega.repoFullName) {
    const porInstalacao = await prisma.project.findFirst({
      where: { githubInstallationId: entrega.installationId },
      select: CAMPOS_DO_PROJETO,
    })
    if (porInstalacao) return { projeto: porInstalacao, criterio: 'instalacao', empatado: false }
  }

  return null
}

export async function githubWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/webhooks/github',
    {
      config: {
        rateLimit: {
          max: 100,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined
      const event = request.headers['x-github-event'] as string | undefined
      const deliveryId = request.headers['x-github-delivery'] as string | undefined
      const payload = request.rawBody || JSON.stringify(request.body)

      if (!payload) {
        return reply.code(400).send({ error: 'Missing payload' })
      }

      if (!signature) {
        return reply.code(401).send({ error: 'Missing signature' })
      }

      // Verify HMAC signature using decorated verifier
      const verified = app.verifyGitHubWebhook(payload.toString(), signature)
      if (!verified) {
        app.log.warn({ deliveryId, event }, 'Invalid GitHub webhook signature')
        return reply.code(401).send({ error: 'Invalid signature' })
      }

      // Parse payload to get GitHub identifiers
      const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload

      // Identify project by GitHub installation ID, repo ID, or repo full name.
      // O wizard cria o Project só com wingId (owner/repo) e deixa
      // githubInstallationId/githubRepoId NULOS — então casar por full_name
      // (== wingId) é o que conecta o webhook a projetos já existentes; sem
      // isto todo projeto criado pelo wizard fica invisível ("Project not found").
      const installationId = parsedPayload.installation?.id
      const repoId = parsedPayload.repository?.id
      const repoFullName = parsedPayload.repository?.full_name as string | undefined

      if (!installationId && !repoId && !repoFullName) {
        app.log.warn({ deliveryId, event }, 'Webhook missing installation/repo ID')
        return reply.code(400).send({ error: 'Missing GitHub identifiers' })
      }

      const casamento = await casarProjeto(app.prisma, {
        repoId,
        repoFullName,
        installationId,
      })

      if (!casamento) {
        app.log.warn(
          { deliveryId, event, installationId, repoId },
          'Project not found for GitHub identifiers'
        )
        return reply
          .code(404)
          .send({ error: 'Project not found for this GitHub repository/installation' })
      }

      const project = casamento.projeto

      // Set wingId context for Prisma RLS
      const { wingIdContext } = await import('../plugins/prisma.js')
      return await wingIdContext.run({ wingId: project.wingId }, async () => {
        // AUTO-CURA — o que ela pode e o que ela NUNCA pode.
        //
        // Ela existe porque o wizard grava só o endereço declarado, e endereço
        // muda: renomear o repositório no GitHub deixaria o projeto órfão de
        // todas as entregas seguintes. Trocar o texto pelo identificador
        // numérico da própria entrega conserta isso.
        //
        // Mas ela só pode ESTREITAR a identidade do projeto, nunca ALARGAR:
        //
        // - `githubInstallationId` deixou de ser escrito aqui. Adotar uma
        //   instalação é alargar: ela cobre a conta inteira, e o projeto
        //   passaria a receber avisos de repositórios que ninguém declarou.
        //   Quem prova posse de instalação é o retorno assinado do fluxo de
        //   instalação (routes/github-app-install.ts), que pergunta ao GitHub
        //   antes de gravar — não uma entrega que apenas calhou de casar.
        // - `githubRepoId` só é gravado quando o casamento foi pelo endereço E
        //   um único projeto declara aquele endereço. Havendo empate, o
        //   escolhido pode ser o errado, e carimbar nele um identificador
        //   imutável congelaria o engano.
        const podeCurar =
          casamento.criterio === 'wingId' &&
          !casamento.empatado &&
          repoId &&
          project.githubRepoId == null

        if (podeCurar) {
          try {
            await app.prisma.project.update({
              where: { id: project.id },
              data: { githubRepoId: BigInt(repoId) },
            })
          } catch (err) {
            // As duas colunas são únicas no banco. Numa corrida (duas entregas
            // do mesmo repositório ao mesmo tempo), a segunda gravação colide —
            // e colisão não pode derrubar a entrega: o projeto já foi
            // encontrado, a cura era só um atalho para as próximas.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              app.log.warn(
                { projectId: project.id, repoId, alvo: err.meta?.['target'] },
                'Identificador do repositório já pertence a outro projeto: cura ignorada'
              )
            } else {
              app.log.warn({ err, projectId: project.id }, 'Falha ao backfill de IDs do GitHub')
            }
          }
        }

        // Persist webhook delivery for idempotency/retry tracking
        await app.prisma.webhookDelivery.create({
          data: {
            projectId: project.id,
            githubDeliveryId: deliveryId || crypto.randomUUID(),
            eventType: event || 'unknown',
            payload: parsedPayload,
            processed: false,
          },
        })

        // Process webhook via @gitorch/github-sync
        try {
          const eventName = toGitHubEventName(event)
          const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
          const envelope: GitHubDeliveryEnvelope = {
            headers: {
              deliveryId: deliveryId || crypto.randomUUID(),
              eventName,
              signature256: signature,
            },
            payload: parsedPayload,
            body: payloadStr,
            receivedAt: new Date().toISOString(),
          }

          const syncEvent = normalizer.normalize(envelope)
          const ingestResult = syncEngine.ingest(syncEvent)

          if (ingestResult.accepted) {
            app.log.info(
              { eventId: syncEvent.id, deliveryId: syncEvent.deliveryId },
              'GitHub event ingested by sync engine'
            )
          } else {
            app.log.info(
              { eventId: syncEvent.id, reason: ingestResult.reason },
              'GitHub event deduplicated'
            )
          }

          // A ligação PR↔tarefa nasce ANTES de qualquer missão acordar. Se o
          // QA acordasse primeiro, julgaria a entrega do próprio produto como
          // obra de terceiro — e o parecer sairia sem poder de mesclagem.
          // Awaited de propósito: é uma leitura e uma escrita, e a ordem aqui é
          // o conserto inteiro. Falha não derruba o webhook: o caminho antigo
          // (o dev reportar) continua existindo como rede de segurança.
          try {
            const ligado = await ligarPrDaEntrega({
              prisma: app.prisma as unknown as PrismaDevSession,
              projectId: project.id,
              event,
              payload: parsedPayload,
            })
            if (ligado) {
              app.log.info(
                { projectId: project.id, ...ligado },
                'Entrega do dev reconhecida no ato: PR ligado à tarefa'
              )
            }
          } catch (err) {
            app.log.error({ err, projectId: project.id }, 'Falha ao ligar PR à tarefa delegada')
          }

          // Sistema nervoso do loop: acorda o agente do papel certo. Fire-and-
          // forget — a missão leva minutos e o GitHub exige resposta rápida; o
          // guard de missão ativa do scheduler evita duplicatas em paralelo.
          let role = missionRoleForEvent(event, parsedPayload)

          // NÃO ACORDAR ENQUANTO A VERIFICAÇÃO AINDA RODA.
          //
          // Um repositório com oito workflows dispara oito avisos de conclusão
          // para o mesmo commit. O julgamento acordava em todos, encontrava a
          // entrega, via que ainda havia verificação rodando e voltava vazio —
          // vinte e seis de trinta e quatro acordadas em 23/08/2026, com
          // sondagens do mesmo pull request separadas por quinze segundos.
          //
          // Só o ÚLTIMO aviso tem informação nova. A conferência custa uma
          // chamada de API; o que ela evita é subir contêiner e gastar cota do
          // motor do cliente para não julgar nada.
          //
          // NA DÚVIDA, ACORDA: se não der para consultar (sem credencial, erro
          // do GitHub, resposta estranha), o disparo acontece do mesmo jeito.
          // Acordar à toa custa um contêiner; não acordar deixa a entrega sem
          // parecer, e isso é muito pior.
          if (role === 'qa' && precisaConferirSeOCiTerminou(event, parsedPayload)) {
            const head = headDoAvisoDeVerificacao(parsedPayload)
            // O nome do repositório e o commit vêm do AVISO, que é dado de
            // fora, e entrariam crus numa URL que leva credencial. Sem validar
            // aqui, um texto com `..` ou `?` troca o endereço de destino e o
            // token vai para onde o texto mandar — mesma classe de furo que
            // `github-app-token.ts` já barra na porta dele. Commit é
            // hexadecimal: o que não for, não é commit.
            const repoValido = nomeDeRepositorioValido(project.wingId)
            const [dono = '', repo = ''] = project.wingId.split('/')
            const headValido = typeof head === 'string' && /^[0-9a-f]{7,40}$/i.test(head)
            const token =
              repoValido && headValido
                ? await mintInstallationToken({ repository: project.wingId }).catch(() => null)
                : null
            if (head && token && repoValido && headValido) {
              // A URL é MONTADA por `URL` com base fixa e segmentos escapados,
              // e depois passa pela guarda de saída de rede do projeto.
              //
              // Interpolar direto numa template string é o que já custou um
              // achado crítico de request-forgery aqui: o nome do repositório
              // e o commit vêm do aviso, que é dado de fora, e a chamada leva
              // credencial. Validar por expressão regular não basta — a guarda
              // tem que ficar na PORTA DE SAÍDA, com o host comparado por
              // igualdade exata, senão `api.github.com.alheio` passa.
              const alvo = new URL(
                `repos/${encodeURIComponent(dono)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(head)}/check-runs`,
                'https://api.github.com/'
              )
              const veredito = enderecoPermitido(alvo.toString())
              if (!veredito.permitido) {
                app.log.warn(
                  { deliveryId, motivo: veredito.motivo },
                  'Webhook: endereço recusado pela guarda de saída; não consulto a verificação'
                )
                return
              }
              const terminou = await fetch(alvo.toString(), {
                headers: {
                  authorization: `token ${token}`,
                  accept: 'application/vnd.github+json',
                  'user-agent': 'gitorch',
                },
              })
                .then((r) => (r.ok ? r.json() : null))
                .then((b) =>
                  verificacaoTerminou(
                    (b as { check_runs?: Array<{ status?: string }> } | null)?.check_runs
                  )
                )
                .catch(() => null)

              if (terminou === false) {
                app.log.info(
                  { deliveryId, event, head, projectId: project.id },
                  'Webhook NÃO acorda o julgamento: a verificação deste commit ainda está rodando'
                )
                role = null
              }
            }
          }

          if (role && app.triggerAgentMission) {
            app.log.info(
              { deliveryId, event, role, projectId: project.id },
              'Webhook acorda missão'
            )
            // Origem 'aviso-do-github': este disparo FURA o descanso pós-acordada-
            // vazia (descanso-apos-vazia.ts). O aviso fala de um pull request
            // específico que acabou de mudar de estado — é informação nova, não
            // o relógio batendo de novo, e calá-lo seria calar o julgamento.
            void app
              .triggerAgentMission(role, project.id, undefined, 'aviso-do-github')
              .catch((err) => app.log.error({ err, role }, 'Falha ao disparar missão via webhook'))
          }

          // Mark as processed
          await app.prisma.webhookDelivery.updateMany({
            where: { githubDeliveryId: deliveryId || '', projectId: project.id },
            data: { processed: true, processedAt: new Date() },
          })

          return { received: true }
        } catch (err) {
          app.log.error({ err, event, deliveryId }, 'Webhook processing failed')
          await app.prisma.webhookDelivery.updateMany({
            where: { githubDeliveryId: deliveryId || '', projectId: project.id },
            data: { processingError: String(err), processedAt: new Date() },
          })
          return reply.code(500).send({ error: 'Webhook processing failed' })
        }
      })
    }
  )
}
