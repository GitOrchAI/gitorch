import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  GitHubWebhookNormalizer,
  GitHubSyncEngine,
  GitHubDeliveryEnvelope,
  GitHubWebhookEventName,
} from '@gitorch/github-sync'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    verifyGitHubWebhook: (payload: string, signature: string) => boolean
  }
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

const normalizer = new GitHubWebhookNormalizer()
const syncEngine = new GitHubSyncEngine()

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
  app.post('/api/webhooks/github', async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Identify project by GitHub installation ID or repo ID
    const installationId = parsedPayload.installation?.id
    const repoId = parsedPayload.repository?.id

    if (!installationId && !repoId) {
      app.log.warn({ deliveryId, event }, 'Webhook missing installation/repo ID')
      return reply.code(400).send({ error: 'Missing GitHub identifiers' })
    }

    // Find project by GitHub identifiers
    const project = await app.prisma.project.findFirst({
      where: {
        OR: [
          ...(installationId ? [{ githubInstallationId: installationId }] : []),
          ...(repoId ? [{ githubRepoId: BigInt(repoId) }] : []),
        ],
      },
      select: { id: true, wingId: true },
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
  })
}
