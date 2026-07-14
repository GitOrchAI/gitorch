import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'
import {
  GitHubWebhookNormalizer,
  GitHubSyncEngine,
  GitHubDeliveryEnvelope,
  GitHubWebhookEventName,
} from '@gitorch/github-sync'

import type { F6AgentRole } from '@gitorch/agents'

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
  // CI concluiu (passou ou falhou) -> o QA acorda. QA só começa depois do CI;
  // ele mesmo é no-op se não houver PR delegado, então acordar em qualquer
  // conclusão de CI é seguro.
  if ((event === 'check_suite' || event === 'workflow_run') && payload.action === 'completed') {
    return 'qa'
  }
  return null
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

      // Find project by GitHub identifiers.
      //
      // `wingId` deixou de ser único global (um repo pode estar cadastrado por
      // mais de um cliente — dois colaboradores de "acme/api"), então o casamento
      // por full_name pode ter MAIS DE UM candidato. Sem uma ordem explícita, o
      // Postgres devolveria um qualquer e a entrega do MESMO repo cairia ora num
      // cliente, ora noutro. `createdAt asc` fixa o destino no primeiro projeto
      // que cadastrou aquele repositório — estável entre entregas.
      //
      // (Os ids numéricos do GitHub continuam sendo únicos globais e, quando
      // presentes, casam um único projeto; o desempate só importa no fallback
      // por full_name, que é o caminho de todo projeto criado pelo wizard.)
      const project = await app.prisma.project.findFirst({
        where: {
          OR: [
            ...(installationId ? [{ githubInstallationId: installationId }] : []),
            ...(repoId ? [{ githubRepoId: BigInt(repoId) }] : []),
            ...(repoFullName ? [{ wingId: repoFullName }] : []),
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          wingId: true,
          githubInstallationId: true,
          githubRepoId: true,
        },
      })

      if (!project) {
        app.log.warn(
          { deliveryId, event, installationId, repoId },
          'Project not found for GitHub identifiers'
        )
        return reply
          .code(404)
          .send({ error: 'Project not found for this GitHub repository/installation' })
      }

      // Set wingId context for Prisma RLS
      const { wingIdContext } = await import('../plugins/prisma.js')
      return await wingIdContext.run({ wingId: project.wingId }, async () => {
        // Auto-cura: se o projeto casou por wingId mas os IDs numéricos do
        // GitHub estão nulos, preenche-os agora — assim as próximas entregas
        // usam o caminho rápido por ID (o wizard não preenchia esses campos).
        if (
          (repoId && project.githubRepoId == null) ||
          (installationId && project.githubInstallationId == null)
        ) {
          await app.prisma.project
            .update({
              where: { id: project.id },
              data: {
                ...(repoId && project.githubRepoId == null ? { githubRepoId: BigInt(repoId) } : {}),
                ...(installationId && project.githubInstallationId == null
                  ? { githubInstallationId: installationId }
                  : {}),
              },
            })
            .catch((err) =>
              app.log.warn({ err, projectId: project.id }, 'Falha ao backfill de IDs do GitHub')
            )
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

          // Sistema nervoso do loop: acorda o agente do papel certo. Fire-and-
          // forget — a missão leva minutos e o GitHub exige resposta rápida; o
          // guard de missão ativa do scheduler evita duplicatas em paralelo.
          const role = missionRoleForEvent(event, parsedPayload)
          if (role && app.triggerAgentMission) {
            app.log.info(
              { deliveryId, event, role, projectId: project.id },
              'Webhook acorda missão'
            )
            void app
              .triggerAgentMission(role, project.id)
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
