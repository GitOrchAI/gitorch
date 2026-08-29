import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

/**
 * `githubInstallationId` e `githubRepoId` NÃO estão aqui de propósito.
 *
 * Eles são a identidade do projeto no GitHub: é por eles que o webhook decide
 * de quem é cada entrega (github-webhook.ts monta um OR com os dois) e é por
 * `users.github_installation_id` que o wizard decide de quem é cada
 * repositório. Aceitá-los do corpo da requisição dava a qualquer cliente logado
 * o poder de carimbar no próprio projeto a instalação/repositório de outra
 * pessoa — a mesma classe de envenenamento que o callback de instalação sofria,
 * só que por outra porta.
 *
 * A fonte legítima é uma só: o payload do webhook, assinado por HMAC pelo
 * próprio GitHub, que preenche esses campos na auto-cura.
 */
interface CreateProjectBody {
  name: string
  description?: string
  avatarUrl?: string
  defaultBranch?: string
}

interface UpdateProjectBody {
  name?: string
  description?: string
  avatarUrl?: string
  defaultBranch?: string
  isActive?: boolean
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

/**
 * Campos que o cliente não pode escrever nem por engano. Recusar em voz alta
 * (400) em vez de descartar em silêncio: quem manda merece saber que não
 * gravou — descarte mudo é como um envenenamento passaria despercebido.
 */
const CAMPOS_SO_DO_GITHUB = ['githubInstallationId', 'githubRepoId'] as const

/**
 * `githubRepoId` é BigInt no schema (ids de repo do GitHub estouram Number).
 * Fastify não serializa BigInt — sem esta conversão, qualquer projeto com o
 * campo preenchido (via webhook) faz o endpoint devolver 500 "Do not know how
 * to serialize a BigInt". Aplicar em TODA resposta que devolve um Project.
 */
function serializavel<T extends { githubRepoId?: bigint | null }>(
  p: T
): Omit<T, 'githubRepoId'> & { githubRepoId: string | null } {
  return { ...p, githubRepoId: p.githubRepoId == null ? null : p.githubRepoId.toString() }
}

function campoProibidoNoCorpo(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  for (const campo of CAMPOS_SO_DO_GITHUB) {
    if (campo in (body as Record<string, unknown>)) return campo
  }
  return null
}

export const projectRoutes = async (app: FastifyInstance): Promise<void> => {
  const DEFAULT_PAGE_SIZE = 20
  const MAX_PAGE_SIZE = 100

  // GET /api/projects - List projects for current wing
  app.get<{ Querystring: PaginationQuery }>(
    '/api/projects',
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
        data: projects.map(serializavel),
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
    async (request: FastifyRequest<{ Body: CreateProjectBody }>, reply: FastifyReply) => {
      const wingId = request.wingId!

      const proibido = campoProibidoNoCorpo(request.body)
      if (proibido) {
        return reply.code(400).send({
          error: `O campo ${proibido} é definido pelo GitHub, não pelo cliente.`,
          code: 'CAMPO_NAO_ACEITO',
        })
      }

      const { name, description, avatarUrl, defaultBranch } = request.body

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

      return reply.code(201).send(serializavel(project))
    }
  )

  // GET /api/projects/:id - Get project by ID
  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id',
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

      return serializavel(project)
    }
  )

  // PATCH /api/projects/:id - Update project
  app.patch<{ Params: ProjectParams; Body: UpdateProjectBody }>(
    '/api/projects/:id',
    async (
      request: FastifyRequest<{ Params: ProjectParams; Body: UpdateProjectBody }>,
      reply: FastifyReply
    ) => {
      const wingId = request.wingId!
      const { id } = request.params

      const proibido = campoProibidoNoCorpo(request.body)
      if (proibido) {
        return reply.code(400).send({
          error: `O campo ${proibido} é definido pelo GitHub, não pelo cliente.`,
          code: 'CAMPO_NAO_ACEITO',
        })
      }

      const { name, description, avatarUrl, defaultBranch, isActive, runtimeConfig } = request.body

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

      return serializavel(project)
    }
  )

  // DELETE /api/projects/:id - Delete project (cascades to missions, events, apiKeys)
  app.delete<{ Params: ProjectParams }>(
    '/api/projects/:id',
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
        (acc: Record<string, number>, m: { status: string; _count: number }) => {
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
