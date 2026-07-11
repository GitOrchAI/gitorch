import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import bcryptjs from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { F6_AGENT_ROLES, isF6AgentRuntime, type F6AgentRuntime } from '@gitorch/agents'
import { ensureDefaultSchedules } from '../lib/project-defaults.js'
import { resolveEngineId } from '../services/engine-connection.js'
import { ClientEnvironmentService } from '../services/environment.js'

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
  // Ambiente isolado do cliente: nasce no aceite dos termos, vive por todo o
  // wizard (clone + credenciais dentro dele) e fixa no aceite final. O baseDir
  // vem de env (infra), nunca hardcoded; o `path` é interno e NUNCA vai pro
  // frontend.
  const clientEnvironments = new ClientEnvironmentService(app.prisma)

  // GET /api/v1/github/repos - List user repositories using the encrypted
  // per-user GitHub connection (nunca do JWT da sessão — spec §17.4).
  app.get('/api/v1/github/repos', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
    }
    // Ausente apenas em composições de rota que não registram o plugin de
    // motores (ex.: teste isolado) — sem este guard, a falta virava um
    // TypeError vazando detalhe interno ('Cannot read properties of
    // undefined') pro cliente em vez de um erro limpo.
    if (!app.engineConnections) {
      return reply.code(500).send({ error: 'Engine connections service unavailable' })
    }
    const githubToken = await app.engineConnections.getRawGithubToken(request.user.id)
    if (!githubToken) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: GitHub not connected' })
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
  })

  // POST /api/v1/setup/environment - Nasce o ambiente isolado provisório do
  // cliente no aceite dos termos (passo 3). Idempotente: reabrir o wizard reusa
  // o mesmo ambiente. Responde só id/status — o path interno nunca é exposto.
  app.post(
    '/api/v1/setup/environment',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const env = await clientEnvironments.createProvisional(request.user.id)
      return reply.send({ id: env.id, status: env.status })
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

      // Resolve o dono a partir da sessão (email do usuário autenticado) e o
      // limite de projetos do plano dele. Em ausência de email na sessão,
      // segue sem dono (comportamento legado single-tenant).
      const owner = user.email
        ? await app.prisma.user.findUnique({
            where: { email: user.email },
            include: { plan: true },
          })
        : null

      // 1. Limite de projetos: o MAIOR entre o plano REAL do dono (confirmado,
      // sobe só quando o webhook do Stripe processa o pagamento) e o plano
      // PRETENDIDO nesta submissão (?plan=team, ainda não pago). Só o maior
      // evita dois erros opostos: usar só o real rejeitaria um cliente
      // pago-a-ser com o teto do free ainda gravado; usar só o pretendido
      // rebaixaria um cliente JÁ pagante que reabre o wizard sem `?plan=`
      // (front usa 'free' como default). Plano pretendido nunca é uma string
      // solta do cliente — é buscado no banco; inexistente cai no teto do free.
      const submittedPlan =
        plan !== 'free' ? await app.prisma.plan.findUnique({ where: { id: plan } }) : null
      const maxProjects = Math.max(owner?.plan?.maxProjects ?? 1, submittedPlan?.maxProjects ?? 1)
      if (owner) {
        const currentCount = await app.prisma.project.count({ where: { userId: owner.id } })
        if (currentCount + repos.length > maxProjects) {
          return reply.code(400).send({
            error: `Plan limit reached: up to ${maxProjects} project(s) allowed (${currentCount} in use)`,
          })
        }
      } else if (plan === 'free' && repos.length > 1) {
        return reply.code(400).send({ error: 'Free plan only allows up to 1 repository' })
      }

      // 1.5. Pelo menos um dos motores selecionados precisa estar REALMENTE
      // conectado (validado, não uma string solta) — senão o onboarding
      // "conclui" para uma execução sem credencial nenhuma (spec §17.3).
      const requestedRuntimes = [
        ...new Set(
          (engines ?? [])
            .map((e) => resolveEngineId(e))
            .filter((r): r is F6AgentRuntime => isF6AgentRuntime(r))
        ),
      ]
      if (requestedRuntimes.length === 0) {
        return reply.code(400).send({ error: 'Nenhum motor de IA reconhecido foi selecionado' })
      }
      // Usa o id do DONO resolvido por e-mail (owner.id), não o claim bruto do
      // JWT: EngineConnection.userId é sempre gravado nesse mesmo id (ver
      // plugins/engines.ts resolveUserId), e uma sessão cujo JWT carregue um
      // id diferente (ex.: cookie emitido antes de uma correção de id) não
      // pode ficar bloqueada permanentemente achando que nenhum motor está
      // conectado. Sem e-mail (legado single-tenant), não há id melhor —
      // segue com user.id como já fazia.
      const connections = await app.engineConnections.list(owner?.id ?? user.id)
      const connectedRuntimes = requestedRuntimes.filter((r) =>
        connections.some((c) => c.runtime === r && c.status === 'connected')
      )
      if (connectedRuntimes.length === 0) {
        return reply.code(400).send({
          error:
            'Conecte pelo menos um motor de IA (Claude, Codex ou Antigravity) antes de finalizar',
        })
      }
      // Preferência dos 4 papéis: o motor primário conectado, com os demais
      // conectados como fallback — mesmo formato que resolveRuntimeChain lê.
      const [primaryRuntime, ...fallbackRuntimes] = connectedRuntimes
      const agentsConfig = Object.fromEntries(
        F6_AGENT_ROLES.map((role) => [
          role,
          {
            runtime: primaryRuntime,
            ...(fallbackRuntimes.length
              ? { fallbacks: fallbackRuntimes.map((runtime) => ({ runtime })) }
              : {}),
          },
        ])
      )

      const createdProjects = []

      // 2. Create Project records and API keys
      for (const repoFullName of repos) {
        const repoName = repoFullName.split('/')[1] || repoFullName
        const wingId = repoFullName // owner/repo maps to wingId

        // Check if project already exists
        let project = await app.prisma.project.findFirst({
          where: { wingId },
        })

        if (!project) {
          project = await app.prisma.project.create({
            data: {
              wingId,
              name: repoName,
              description: `Project for ${repoFullName}`,
              ...(owner ? { userId: owner.id } : {}),
              // O token do GitHub NÃO é duplicado aqui em texto puro — já foi
              // persistido cifrado por usuário no callback OAuth
              // (EngineConnection, runtime 'github'); a missão o materializa
              // de lá (spec §17.4).
              runtimeConfig: {
                engines,
                // Formato que resolveRuntimeChain (lib/runtime-resolver.ts)
                // realmente lê — sem isto, a seleção do cliente era
                // silenciosamente ignorada e todo papel caía no default da
                // instância (spec §17.3).
                agents: agentsConfig,
                telegram: telegram ?? null,
                plan,
                envConfig: (envConfig ?? null) as Prisma.JsonObject | null,
              } as Prisma.JsonObject,
            },
          })
        }

        // Projeto novo nasce agendado (senão o scheduler nunca o aciona).
        await ensureDefaultSchedules(app.prisma, project.id)

        // Generate a default API Key for this project (assisted login for CLIs)
        const rawApiKey = `gitorch_${randomBytes(24).toString('hex')}`
        const keyHash = await bcryptjs.hash(rawApiKey, 12)
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

        // Add to created list
        createdProjects.push({
          id: project.id,
          name: project.name,
          wingId: project.wingId,
          apiKey: rawApiKey,
        })

        // 3. Queue mission to clone repository & initialize multi-agent engines
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

      return reply.send({
        success: true,
        projects: createdProjects,
      })
    }
  )
}

export default setupRoutes
