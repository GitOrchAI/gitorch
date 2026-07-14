import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import bcryptjs from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { F6_AGENT_ROLES, isF6AgentRuntime, type F6AgentRuntime } from '@gitorch/agents'
import { ensureDefaultSchedules } from '../lib/project-defaults.js'
import { resolveEngineId } from '../services/engine-connection.js'
import { ClientEnvironmentService } from '../services/environment.js'
import { collectAndRememberRepoContext } from '../services/repo-context-cortex.js'

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

// Lê o número do board GitHub Projects V2 já criado pra este repo, se algum
// submit anterior já criou um (gravado por persistBoardNumber abaixo). Sem
// isto, resolveBoard (repo-context-collector) nunca recebe um número conhecido
// e cria um board NOVO a cada submit — um board GitHub por reabertura do
// wizard, acumulando duplicados na conta do cliente.
function readKnownBoardNumber(
  runtimeConfig: Prisma.JsonValue | null | undefined
): number | undefined {
  if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) {
    return undefined
  }
  const raw = (runtimeConfig as Record<string, unknown>)['githubBoardNumber']
  return typeof raw === 'number' ? raw : undefined
}

// A missão que o submit enfileira — o provisionamento REAL do wizard (clone do
// repo + subida dos motores no ambiente do cliente), processada pelo scheduler.
const SETUP_MISSION_TYPE = 'clone_and_start_engines'

// Estado agregado do provisionamento, do ponto de vista do cliente.
type ProvisionStatus = 'unknown' | 'pending' | 'running' | 'completed' | 'failed'

interface SetupMissionRow {
  projectId: string
  status: string
  error: string | null
  payload: Prisma.JsonValue
  project: { wingId: string }
}

/**
 * Só a missão MAIS RECENTE de cada projeto conta. Uma retentativa cria uma
 * missão NOVA (a antiga fica no histórico); sem este corte, uma falha velha —
 * já superada — assombraria o status do cliente para sempre. Depende de a
 * consulta vir em `createdAt desc`.
 */
function latestPerProject<T extends { projectId: string }>(missions: T[]): T[] {
  const seen = new Set<string>()
  const latest: T[] = []
  for (const mission of missions) {
    if (seen.has(mission.projectId)) continue
    seen.add(mission.projectId)
    latest.push(mission)
  }
  return latest
}

/**
 * Agregação HONESTA do provisionamento:
 * - qualquer falha vence tudo (o cliente precisa saber que algo quebrou, mesmo
 *   que outro repo tenha subido);
 * - depois "ainda trabalhando" (running > pending) vence "concluído" — nada de
 *   ✓ verde enquanto uma missão ainda respira;
 * - completed SÓ quando todas terminaram bem;
 * - sem missão (ou com estado que não conhecemos), unknown: não inventa sucesso
 *   nem fracasso.
 */
function aggregateStatus(missions: Array<{ status: string }>): ProvisionStatus {
  if (missions.length === 0) return 'unknown'
  if (missions.some((m) => m.status === 'failed')) return 'failed'
  if (missions.some((m) => m.status === 'running')) return 'running'
  if (missions.some((m) => m.status === 'pending')) return 'pending'
  if (missions.every((m) => m.status === 'completed')) return 'completed'
  return 'unknown'
}

// `?projects=a,b` / `{ projects: ['a','b'] }` — os projetos criados NESTE submit
// (o front os conhece pela resposta do /submit). Restringe o status ao que o
// cliente acabou de pedir, sem deixar um projeto antigo contaminar a leitura.
// Vazio = sem filtro (nunca vira um `in: []`, que não casaria com nada).
function parseProjectIds(raw: unknown): string[] {
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : []
  return list
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())
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

  // POST /api/v1/setup/clone - Clona os repos escolhidos DENTRO do ambiente do
  // cliente (passo 4), usando o token do próprio cliente. Responde só a
  // contagem — os caminhos internos em disco nunca vão pro frontend.
  app.post(
    '/api/v1/setup/clone',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const { repos } = request.body as { repos?: string[] }
      if (!repos || repos.length === 0) {
        return reply.code(400).send({ error: 'At least one repository must be selected' })
      }
      // Token do PRÓPRIO cliente (repo privado). Ausente em composições sem o
      // plugin de motores; clone anônimo cobre repo público.
      const token = app.engineConnections
        ? await app.engineConnections.getRawGithubToken(request.user.id)
        : null
      const env = await clientEnvironments.createProvisional(request.user.id)
      const cloned = await clientEnvironments.cloneInto(env.id, repos, token ?? undefined)
      return reply.send({ envId: env.id, count: cloned.length })
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
      // repoFullName -> Project criado/reusado nesta submissão. Alimenta a
      // coleta de contexto abaixo: precisa do id (pra persistir o board) e do
      // runtimeConfig (pra ler o board já conhecido de um submit anterior).
      const projectsByRepo = new Map<string, { id: string; runtimeConfig: Prisma.JsonValue }>()

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
        projectsByRepo.set(repoFullName, { id: project.id, runtimeConfig: project.runtimeConfig })

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

      // Aceite final concluído: fixa o ambiente do cliente (provisional → fixed),
      // tirando-o do alcance da faxina 24h — agora é um cliente de verdade.
      await clientEnvironments.fix(user.id)

      // Coleta de contexto → memória (F4.2.3): junta board + PRs + Issues de
      // cada repo e grava no Cortex (ponte GitHub→memória). BEST-EFFORT — nunca
      // derruba o aceite final: sem Cortex/token (ex.: teste de rota isolado) ou
      // numa falha de API, o cliente fica fixado do mesmo jeito e só logamos.
      // `collectAndRememberRepoContext` já não lança; o try/catch é o cinto de
      // segurança para qualquer erro inesperado (nunca vira 500 pro cliente).
      try {
        const githubToken = app.engineConnections
          ? await app.engineConnections.getRawGithubToken(owner?.id ?? user.id)
          : null
        if (app.cortex && githubToken) {
          for (const repoFullName of repos) {
            const project = projectsByRepo.get(repoFullName)
            const boardNumber = readKnownBoardNumber(project?.runtimeConfig)
            const result = await collectAndRememberRepoContext({
              token: githubToken,
              wingId: repoFullName,
              cortex: app.cortex,
              ...(boardNumber !== undefined ? { boardNumber } : {}),
            })
            if (!result.collected) {
              app.log.warn(
                `[setup] coleta de contexto pulada para ${repoFullName}: ${result.reason}`
              )
            } else if (result.boardCreated && result.boardNumber !== undefined && project) {
              // Persiste o número do board recém-criado no Project: o PRÓXIMO
              // submit (reabrir o wizard) lê `boardNumber` acima e REUSA em vez
              // de criar um board GitHub novo — sem isto, cada submit acumula
              // um board duplicado na conta/org do cliente.
              const existingConfig =
                project.runtimeConfig &&
                typeof project.runtimeConfig === 'object' &&
                !Array.isArray(project.runtimeConfig)
                  ? (project.runtimeConfig as Prisma.JsonObject)
                  : {}
              await app.prisma.project.update({
                where: { id: project.id },
                data: {
                  runtimeConfig: {
                    ...existingConfig,
                    githubBoardNumber: result.boardNumber,
                  } as Prisma.JsonObject,
                },
              })
            }
          }
        }
      } catch (err) {
        app.log.warn(err, '[setup] coleta de contexto falhou (aceite final não afetado)')
      }

      return reply.send({
        success: true,
        projects: createdProjects,
      })
    }
  )

  // Dono canônico da sessão: EngineConnection e Project são gravados sob o id
  // resolvido por e-mail (ver submit acima e plugins/engines.ts). Sem e-mail
  // (legado single-tenant), o id da sessão é o melhor que existe.
  const resolveOwnerId = async (user: { id: string; email?: string }): Promise<string> => {
    if (!user.email) return user.id
    const owner = await app.prisma.user.findUnique({ where: { email: user.email } })
    return owner?.id ?? user.id
  }

  // Missões de provisionamento do dono, mais recentes primeiro. O escopo por
  // `project.userId` é o que impede um cliente de ler o provisionamento alheio.
  const findSetupMissions = async (
    ownerId: string,
    projectIds: string[],
    status?: string
  ): Promise<SetupMissionRow[]> => {
    const missions = await app.prisma.mission.findMany({
      where: {
        type: SETUP_MISSION_TYPE,
        ...(status ? { status } : {}),
        project: { userId: ownerId },
        ...(projectIds.length > 0 ? { projectId: { in: projectIds } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { project: { select: { id: true, wingId: true } } },
    })
    return missions as SetupMissionRow[]
  }

  // GET /api/v1/setup/status - A VERDADE do provisionamento (passo 11 do
  // wizard). Lê o estado REAL no banco: a missão `clone_and_start_engines` que
  // o submit enfileirou (pending -> running -> completed/failed, processada
  // pelo scheduler) + o ambiente do cliente. Antes disto o passo final derivava
  // "pronto" da lista de motores — uma tautologia (o submit já exige um motor
  // conectado, e a linha 'github' nasce conectada no OAuth), então o wizard
  // pintava ✓ verde no primeiro poll enquanto o provisionamento sequer havia
  // começado. Limite próprio de taxa: é uma rota de POLLING e o teto global (20
  // req/min) transformaria o acompanhamento honesto num 429.
  app.get(
    '/api/v1/setup/status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user
      if (!user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const ownerId = await resolveOwnerId(user)
      const { projects } = request.query as { projects?: string }
      const missions = latestPerProject(await findSetupMissions(ownerId, parseProjectIds(projects)))

      // A causa da falha vem da PRÓPRIA missão (Mission.error, gravado pelo
      // scheduler) — o cliente merece saber o que quebrou, não um "ops".
      const failed = missions.find((m) => m.status === 'failed')
      const environment = await clientEnvironments.current(user.id)

      return reply.send({
        status: aggregateStatus(missions),
        error: failed?.error ?? null,
        missions: missions.map((m) => ({
          projectId: m.projectId,
          wingId: m.project.wingId,
          status: m.status,
          error: m.error ?? null,
        })),
        // Só id + status: o `path` do ambiente é infra e NUNCA vai pro frontend.
        environment: environment ? { id: environment.id, status: environment.status } : null,
      })
    }
  )

  // POST /api/v1/setup/retry - Retentativa REAL do provisionamento que falhou.
  // Cria uma missão NOVA (mesmo payload) em vez de ressuscitar a antiga: o
  // sweeper do scheduler mata como "presa" qualquer pending cujo createdAt
  // passe do PENDING_TIMEOUT_MS, então reusar a linha velha faria a retentativa
  // "falhar" na hora. O status volta a pending e o próximo tick a processa.
  app.post(
    '/api/v1/setup/retry',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user
      if (!user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const ownerId = await resolveOwnerId(user)
      const { projects } = (request.body ?? {}) as { projects?: string[] }
      const failed = latestPerProject(
        await findSetupMissions(ownerId, parseProjectIds(projects), 'failed')
      )

      for (const mission of failed) {
        await app.prisma.mission.create({
          data: {
            projectId: mission.projectId,
            type: SETUP_MISSION_TYPE,
            payload: mission.payload as Prisma.JsonObject,
            status: 'pending',
          },
        })
      }

      return reply.send({ retried: failed.length })
    }
  )
}

export default setupRoutes
