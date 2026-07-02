import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

interface CreateProjectBody {
  name: string
  description?: string
  avatarUrl?: string
  defaultBranch?: string
  githubInstallationId?: number
  githubRepoId?: bigint
}

interface UpdateProjectBody {
  name?: string
  description?: string
  avatarUrl?: string
  defaultBranch?: string
  isActive?: boolean
  githubInstallationId?: number
  githubRepoId?: bigint
  runtimeConfig?: Prisma.InputJsonValue
}

interface ProjectParams {
  id: string
}

interface PaginationQuery {
  page?: string
  pageSize?: string
}

function toNullable<T>(value: T | undefined): T | null {
  return value ?? null
}

export const projectRoutes = async (app: FastifyInstance): Promise<void> => {
  const DEFAULT_PAGE_SIZE = 20
  const MAX_PAGE_SIZE = 100

  // GET /api/projects - List projects for current wing
  app.get<{ Querystring: PaginationQuery }>(
    '/api/projects',
    {
      config: {
        rateLimit: {
          max: 40,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: PaginationQuery }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const page = Math.max(1, parseInt(request.query.page || '1', 10))
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, parseInt(request.query.pageSize || String(DEFAULT_PAGE_SIZE), 10))
      )

      const [projects, total] = await Promise.all([
        app.prisma.project.findMany({
          where: { wingId },
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            description: true,
            avatarUrl: true,
            defaultBranch: true,
            isActive: true,
            githubInstallationId: true,
            githubRepoId: true,
            runtimeConfig: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { missions: true, events: true, apiKeys: true },
            },
          },
        }),
        app.prisma.project.count({ where: { wingId } }),
      ])

      return reply.send({
        data: projects,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      })
    }
  )

  // POST /api/projects - Create project
  app.post<{ Body: CreateProjectBody }>(
    '/api/projects',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateProjectBody }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { name, description, avatarUrl, defaultBranch, githubInstallationId, githubRepoId } =
        request.body

      // Check for duplicate name within wing
      const existing = await app.prisma.project.findFirst({
        where: { wingId, name },
      })
      if (existing) {
        return reply.code(409).send({ error: 'Project with this name already exists' })
      }

      const project = await app.prisma.project.create({
        data: {
          wingId,
          name,
          description: toNullable(description),
          avatarUrl: toNullable(avatarUrl),
          defaultBranch: defaultBranch || 'main',
          githubInstallationId: toNullable(githubInstallationId),
          githubRepoId: toNullable(githubRepoId),
        },
        select: {
          id: true,
          name: true,
          description: true,
          avatarUrl: true,
          defaultBranch: true,
          isActive: true,
          githubInstallationId: true,
          githubRepoId: true,
          runtimeConfig: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      return reply.code(201).send(project)
    }
  )

  // GET /api/projects/:id - Get project by ID
  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { id } = request.params

      const project = await app.prisma.project.findFirst({
        where: { id, wingId },
        select: {
          id: true,
          name: true,
          description: true,
          avatarUrl: true,
          defaultBranch: true,
          isActive: true,
          githubInstallationId: true,
          githubRepoId: true,
          runtimeConfig: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { missions: true, events: true, apiKeys: true },
          },
        },
      })

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      return project
    }
  )

  // PATCH /api/projects/:id - Update project
  app.patch<{ Params: ProjectParams; Body: UpdateProjectBody }>(
    '/api/projects/:id',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: ProjectParams; Body: UpdateProjectBody }>,
      reply: FastifyReply
    ) => {
      const wingId = request.wingId!
      const { id } = request.params
      const {
        name,
        description,
        avatarUrl,
        defaultBranch,
        isActive,
        githubInstallationId,
        githubRepoId,
        runtimeConfig,
      } = request.body

      // Check if project exists and belongs to wing
      const existing = await app.prisma.project.findFirst({
        where: { id, wingId },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      // Check for duplicate name if name is being changed
      if (name && name !== existing.name) {
        const duplicate = await app.prisma.project.findFirst({
          where: { wingId, name },
        })
        if (duplicate) {
          return reply.code(409).send({ error: 'Project with this name already exists' })
        }
      }

      // Build update data dynamically - only include fields that are provided
      const updateData: Prisma.ProjectUpdateInput = {}
      if (name !== undefined) updateData.name = name
      if (description !== undefined) updateData.description = description
      if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl
      if (defaultBranch !== undefined) updateData.defaultBranch = defaultBranch
      if (isActive !== undefined) updateData.isActive = isActive
      if (githubInstallationId !== undefined) updateData.githubInstallationId = githubInstallationId
      if (githubRepoId !== undefined) updateData.githubRepoId = githubRepoId
      if (runtimeConfig !== undefined) updateData.runtimeConfig = runtimeConfig

      const project = await app.prisma.project.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          description: true,
          avatarUrl: true,
          defaultBranch: true,
          isActive: true,
          githubInstallationId: true,
          githubRepoId: true,
          runtimeConfig: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      return project
    }
  )

  // DELETE /api/projects/:id - Delete project (cascades to missions, events, apiKeys)
  app.delete<{ Params: ProjectParams }>(
    '/api/projects/:id',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { id } = request.params

      const existing = await app.prisma.project.findFirst({
        where: { id, wingId },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      await app.prisma.project.delete({
        where: { id },
      })

      return reply.code(204).send()
    }
  )

  // GET /api/projects/:id/status - Get project status (aggregated missions, events, health)
  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id/status',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const { id } = request.params

      const project = await app.prisma.project.findFirst({
        where: { id, wingId },
        select: { id: true, name: true, isActive: true },
      })
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      const [missions, events, apiKeys] = await Promise.all([
        app.prisma.mission.groupBy({
          by: ['status'],
          where: { projectId: id },
          _count: true,
        }),
        app.prisma.event.groupBy({
          by: ['type'],
          where: { projectId: id },
          _count: true,
          orderBy: { _count: { type: 'desc' } },
          take: 10,
        }),
        app.prisma.apiKey.findMany({
          where: { projectId: id, isActive: true },
          select: { id: true, name: true, lastUsedAt: true, expiresAt: true },
        }),
      ])

      const missionStatus = missions.reduce(
        (acc: Record<string, number>, m) => {
          acc[m.status] = m._count
          return acc
        },
        {} as Record<string, number>
      )

      return {
        project: { id: project.id, name: project.name, isActive: project.isActive },
        missions: missionStatus,
        recentEvents: events.map((e: { type: string; _count: number }) => ({
          type: e.type,
          count: e._count,
        })),
        apiKeys: apiKeys.length,
        lastActivity: events[0] ? new Date().toISOString() : null,
      }
    }
  )
}

export default projectRoutes
