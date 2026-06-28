import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import type { InputJsonValue } from '@prisma/client/runtime/library'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    sseClients: Map<
      string,
      { id: string; wingId: string; reply: FastifyReply; lastHeartbeat: number }
    >
    broadcastEvent: (wingId: string, event: string, data: unknown) => void
  }
}

interface TriggerMissionBody {
  projectId: string
  type: string
  payload: InputJsonValue
}

interface MissionParams {
  id: string
}

interface SSEQuery {
  lastEventId?: string
}

export const missionRoutes = async (app: FastifyInstance): Promise<void> => {
  // POST /api/missions/trigger - Trigger a new mission
  app.post<{ Body: TriggerMissionBody }>(
    '/api/missions/trigger',
    async (request: FastifyRequest<{ Body: TriggerMissionBody }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { projectId, type, payload } = request.body

      // Verify project belongs to wing
      const project = await app.prisma.project.findFirst({
        where: { id: projectId, wingId },
        select: { id: true, name: true },
      })

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      // Create mission
      const mission = await app.prisma.mission.create({
        data: {
          projectId,
          type,
          status: 'pending',
          payload: payload as InputJsonValue,
        },
        select: {
          id: true,
          projectId: true,
          type: true,
          status: true,
          payload: true,
          createdAt: true,
        },
      })

      // Emit event via SSE for real-time updates
      app.broadcastEvent(wingId, 'mission.created', {
        missionId: mission.id,
        projectId: mission.projectId,
        type: mission.type,
        status: mission.status,
        timestamp: mission.createdAt.toISOString(),
      })

      return reply.code(201).send(mission)
    }
  )

  // GET /api/missions/:id - Get mission status
  app.get<{ Params: MissionParams }>(
    '/api/missions/:id',
    async (request: FastifyRequest<{ Params: MissionParams }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { id } = request.params

      const mission = await app.prisma.mission.findFirst({
        where: {
          id,
          project: { wingId },
        },
        select: {
          id: true,
          projectId: true,
          type: true,
          status: true,
          payload: true,
          result: true,
          error: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      if (!mission) {
        return reply.code(404).send({ error: 'Mission not found' })
      }

      return mission
    }
  )
}

export const eventRoutes = async (app: FastifyInstance): Promise<void> => {
  // GET /api/events - SSE stream for real-time events
  app.get<{ Querystring: SSEQuery }>(
    '/api/events',
    async (request: FastifyRequest<{ Querystring: SSEQuery }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const lastEventId = request.query.lastEventId

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const clientId = `${wingId}:${Date.now()}:${Math.random().toString(36).slice(2)}`

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
          reply.raw.write(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`
          )
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

      // Send initial connection event
      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ clientId, wingId, timestamp: new Date().toISOString() })}\n\n`
      )

      // Heartbeat interval
      const heartbeatInterval = setInterval(() => {
        reply.raw.write(`:heartbeat\n\n`)
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
      })

      request.raw.on('error', () => {
        clearInterval(heartbeatInterval)
        app.sseClients.delete(clientId)
      })
    }
  )
}

export default { missionRoutes, eventRoutes }
