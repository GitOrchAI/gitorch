import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'

interface GitHubRepo {
  id: number
  name: string
  full_name: string
  description: string | null
  private: boolean
  html_url: string
}

interface SetupSubmitBody {
  repos: string[]
  engines: string[]
  telegram?: string
  plan: string
  envConfig?: Record<string, unknown>
}

export const setupRoutes = async (app: FastifyInstance): Promise<void> => {
  // GET /api/v1/github/repos - List user repositories using OAuth session token
  app.get(
    '/api/v1/github/repos',
    {
      config: {
        rateLimit: {
          max: 40,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const githubToken = request.user?.githubToken
      if (!githubToken) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: Missing GitHub Token in session' })
      }

      const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'gitorch-control-plane',
        },
      })

      const repos = (await response.json()) as GitHubRepo[]
      if (!Array.isArray(repos)) {
        return reply.code(500).send({ error: 'Failed to fetch repositories from GitHub' })
      }

      // Map to simplified structure for the frontend setup list
      const mappedRepos = repos.map((repo: GitHubRepo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        url: repo.html_url,
      }))

      return reply.send(mappedRepos)
    }
  )

  // POST /api/v1/setup/submit - Submit final setup wizard data
  app.post(
    '/api/v1/setup/submit',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user
      if (!user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: User session required' })
      }

      const { repos, engines, telegram, plan, envConfig } = request.body as SetupSubmitBody

      if (!repos || repos.length === 0) {
        return reply.code(400).send({ error: 'At least one repository must be selected' })
      }

      const createdProjects = []

      // 2. Create Project records and API keys
      for (const repoFullName of repos) {
        const repoName = repoFullName.split('/')[1] || repoFullName
        const wingId = repoFullName // owner/repo maps to wingId

        // Check if project already exists
        let project = await app.prisma.project.findFirst({
          where: { wingId },
        })

        // 1. Cria o projeto (já existente no fluxo)
        if (!project) {
          project = await app.prisma.project.create({
            data: {
              wingId,
              name: repoName,
              description: `Project for ${repoFullName}`,
              runtimeConfig: {
                engines,
                telegram: telegram ?? null,
                plan,
                envConfig: (envConfig ?? null) as Prisma.JsonObject | null,
                userGithubToken: user.githubToken ?? null,
              } as Prisma.JsonObject,
            },
          })
        }

        // 2. Gera a API key padrão para o projeto
        const rawApiKey = `gitorch_${randomBytes(24).toString('hex')}`
        const keyHash = createHash('sha256').update(rawApiKey).digest('hex')
        const prefix = rawApiKey.substring(0, 12)

        await app.prisma.apiKey.create({
          data: {
            projectId: project.id,
            name: 'Default Setup Key',
            keyHash,
            prefix,
            scopes: ['read', 'write'],
          },
        })

        // 3. Adiciona ao array de projetos criados
        createdProjects.push({
          id: project.id,
          name: project.name,
          wingId: project.wingId,
          apiKey: rawApiKey,
        })

        // 4. Enfileira missão para clonar repositório e iniciar engines
        await app.prisma.mission.create({
          data: {
            projectId: project.id,
            type: 'clone_and_start_engines',
            payload: {
              repoUrl: `https://github.com/${repoFullName}`,
              engines,
              telegram: telegram ?? null,
              envConfig: (envConfig ?? null) as Prisma.JsonObject | null,
            } as Prisma.JsonObject,
            status: 'pending',
          },
        })
      }
      // 5. Responda ao cliente
      return reply.send({
        success: true,
        projects: createdProjects,
      })
    }
  )
}

export default setupRoutes
