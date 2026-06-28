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

export default missionRoutes
