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
