import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'

interface SSEQuery {
  lastEventId?: string
}

export const eventRoutes = async (app: FastifyInstance): Promise<void> => {
  // GET /api/events - SSE stream for real-time events
  app.get<{ Querystring: SSEQuery }>(
    '/api/events',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SSEQuery }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const lastEventId = request.query.lastEventId

      const clientId = `${wingId}:${Date.now()}:${Math.random().toString(36).slice(2)}`

      // Send initial connection event
      reply.sse({
        event: 'connected',
        data: JSON.stringify({ clientId, wingId, timestamp: new Date().toISOString() }),
      })

      // Send replay events if Last-Event-ID provided
      if (lastEventId) {
        const missedEvents = await app.prisma.event.findMany({
          where: {
            project: { wingId },
            id: { gt: lastEventId },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })

        for (const event of missedEvents) {
          reply.sse({
            id: event.id,
            event: event.type,
            data: JSON.stringify(event.payload),
          })
        }
      }

      // Register SSE client
      const client = {
        id: clientId,
        wingId,
        reply,
        lastHeartbeat: Date.now(),
      }
      app.sseClients.set(clientId, client)

      // Heartbeat interval
      const heartbeatInterval = setInterval(() => {
        reply.sse({ comment: 'heartbeat' })
        client.lastHeartbeat = Date.now()
      }, 30000)

      // Cleanup on close
      request.raw.on('close', () => {
        clearInterval(heartbeatInterval)
        app.sseClients.delete(clientId)
        app.broadcastEvent(wingId, 'client.disconnected', {
          clientId,
          wingId,
          timestamp: new Date().toISOString(),
        })
        const sseContext = (reply as unknown as { sseContext?: { source?: { end: () => void } } })
          .sseContext
        if (sseContext && sseContext.source) {
          sseContext.source.end()
        }
      })

      request.raw.on('error', () => {
        clearInterval(heartbeatInterval)
        app.sseClients.delete(clientId)
        const sseContext = (reply as unknown as { sseContext?: { source?: { end: () => void } } })
          .sseContext
        if (sseContext && sseContext.source) {
          sseContext.source.end()
        }
      })

      // Keep the async handler alive so Fastify doesn't close the request prematurely
      await new Promise(() => {})
    }
  )
}

export default eventRoutes
