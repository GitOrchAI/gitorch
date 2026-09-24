import { FastifyPluginAsync } from 'fastify'
import type { FastifyReply } from 'fastify'

import fastifySseModule from 'fastify-sse-v2'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fastifySse = (fastifySseModule as any).default ?? fastifySseModule

// Type from fastify-sse-v2 module augmentation
interface EventMessage {
  data?: string
  id?: string
  event?: string
  retry?: number
  comment?: string
}

export interface TelemetryGuestQuotaAlertEvent {
  type: 'telemetry:guest_quota_alert'
  guestId: string
  projectId: string
  fraction: number
  used: number
  limit: number
}

export interface TelemetrySpanEvent {
  type: 'telemetry:span'
  missionId: string
  role?: string
  cost?: number
  latency?: number
  error?: string
}

export interface TelemetryQuotaAlertEvent {
  type: 'telemetry:quota_alert'
  missionId: string
  role?: string
  limit?: number
  used?: number
  reason: string
}

interface SseClient {
  id: string
  wingId: string
  reply: FastifyReply
  lastHeartbeat: number
}

declare module 'fastify' {
  interface FastifyInstance {
    sseClients: Map<string, SseClient>
    broadcastEvent: (wingId: string, event: string, data: unknown) => void
  }

  interface FastifyReply {
    sse: (message: EventMessage | AsyncIterable<EventMessage>) => void
  }
}

import { getMissionExecutionHistory } from '../lib/migration-ledger.js'

export const ssePlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifySse as FastifyPluginAsync)

  app.decorate('sseClients', new Map<string, SseClient>())

  app.decorate('broadcastEvent', (wingId: string, event: string, data: unknown) => {
    for (const [, client] of app.sseClients) {
      if (client.wingId === wingId) {
        const message: EventMessage = {
          data: JSON.stringify(data),
          event,
        }
        client.reply.sse(message)
      }
    }
  })

  // Heartbeat cleanup
  const heartbeatInterval = 30000
  setInterval(() => {
    const now = Date.now()
    for (const [id, client] of app.sseClients) {
      if (now - client.lastHeartbeat > heartbeatInterval * 3) {
        // Send end event to close connection gracefully
        const endMessage: EventMessage = {
          data: '',
          event: 'end',
        }
        client.reply.sse(endMessage)
        app.sseClients.delete(id)
      }
    }
  }, heartbeatInterval)

  // Mission session history stream endpoint
  app.get<{ Params: { missionId: string } }>(
    '/missions/:missionId/stream',
    async (request, reply) => {
      const { missionId } = request.params

      const mission = await app.prisma.mission.findUnique({
        where: { id: missionId },
      })

      if (!mission) {
        return reply.code(404).send({ error: 'Mission not found' })
      }

      // Registrar cliente de SSE
      const clientId = `${missionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const client: SseClient = {
        id: clientId,
        wingId: missionId,
        reply,
        lastHeartbeat: Date.now(),
      }
      app.sseClients.set(clientId, client)

      request.raw.on('close', () => app.sseClients.delete(clientId))
      request.raw.on('end', () => app.sseClients.delete(clientId))

      // Recupera a trilha histórica já consolidada e envia o playback inicial imediatamente
      const history = await getMissionExecutionHistory(missionId)

      reply.sse(
        (async function* () {
          yield { event: 'connected', data: JSON.stringify({ missionId }) }

          for (const checkpoint of history) {
            yield { event: 'history', data: JSON.stringify(checkpoint) }
          }

          let cleanupDone = false
          const cleanup = () => {
            cleanupDone = true
          }
          request.raw.on('close', cleanup)
          request.raw.on('end', cleanup)

          while (!cleanupDone) {
            await new Promise((resolve) => setTimeout(resolve, heartbeatInterval))
            if (cleanupDone) break
            client.lastHeartbeat = Date.now()
            yield { event: 'heartbeat', data: '' }
          }
        })()
      )
    }
  )

  // Waiting room stream endpoint
  app.get<{ Params: { token: string } }>('/wait/:token', async (request, reply) => {
    const { token } = request.params

    const exists = await app.redis.exists(`waiting_room:${token}`)
    if (!exists) {
      return reply.code(401).send({ error: 'Invalid or expired waiting room token' })
    }

    reply.sse(
      (async function* () {
        yield { event: 'connected', data: JSON.stringify({ token }) }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let resolveNextMessage: ((msg: unknown) => void) | null = null
        let cleanupDone = false

        const listener = (data: { token: string; status: string }) => {
          if (data.token === token && resolveNextMessage) {
            resolveNextMessage({ event: 'guest_status_changed', data: JSON.stringify(data) })
            resolveNextMessage = null
          }
        }

        app.emitter.on('guest_status_changed', listener)

        const cleanup = async () => {
          if (cleanupDone) return
          cleanupDone = true
          app.emitter.off('guest_status_changed', listener)
          // Clean up the session if the connection closes before moderation
          await app.redis.del(`waiting_room:${token}`)
        }

        request.raw.on('close', cleanup)
        request.raw.on('end', cleanup)

        try {
          while (!cleanupDone) {
            const msg = await Promise.race([
              new Promise((resolve) => {
                resolveNextMessage = resolve
              }),
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve({ event: 'heartbeat', data: '' })
                }, heartbeatInterval)
              }),
            ])

            if (cleanupDone) break

            yield msg as EventMessage
          }
        } finally {
          await cleanup()
        }
      })()
    )
  })
}

Object.assign(ssePlugin, { [Symbol.for('skip-override')]: true })
