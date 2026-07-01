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
}

Object.assign(ssePlugin, { [Symbol.for('skip-override')]: true })
