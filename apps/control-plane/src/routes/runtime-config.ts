import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'

interface ProjectParams {
  id: string
}

export const runtimeConfigRoutes = async (app: FastifyInstance): Promise<void> => {
  // PATCH /api/projects/:id/runtime-config - Update project runtime config (F8 ownership)
  app.patch<{ Params: ProjectParams; Body: { runtimeConfig: Prisma.InputJsonValue } }>(
    '/api/projects/:id/runtime-config',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: ProjectParams
        Body: { runtimeConfig: Prisma.InputJsonValue }
      }>,
      reply: FastifyReply
    ) => {
      const wingId = request.wingId!
      const { id } = request.params
      const { runtimeConfig } = request.body

      const existing = await app.prisma.project.findFirst({
        where: { id, wingId },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      const project = await app.prisma.project.update({
        where: { id },
        data: { runtimeConfig: runtimeConfig as Prisma.InputJsonValue },
        select: {
          id: true,
          name: true,
          runtimeConfig: true,
          updatedAt: true,
        },
      })

      return project
    }
  )
}

export default runtimeConfigRoutes
