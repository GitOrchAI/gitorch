import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import bcryptjs from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { F6_AGENT_ROLES, isF6AgentRuntime, type F6AgentRuntime } from '@gitorch/agents'
import { ensureDefaultSchedules } from '../lib/project-defaults.js'
import { resolveEngineId } from '../services/engine-connection.js'
import { ClientEnvironmentService } from '../services/environment.js'
import { collectAndRememberRepoContext } from '../services/repo-context-cortex.js'
import {
  verificarCredencial,
  guardarCredencialDoProjeto,
  lerCredencialDoProjeto,
  VerificacaoIndisponivelError,
} from '../services/project-credential.js'
import { startTelegramLink, readTelegramLink } from '../services/telegram-link.js'
import { AgentQuestionService, type AgentQuestionRecord } from '../services/agent-question.js'
import {
  classifyCloneError,
  classifyGithubApiError,
  setupErrorHttpStatus,
} from '../lib/setup-errors.js'
import { summarizeResourcesLock } from '../lib/environment-resources.js'
import { mintInstallationToken } from '../services/github-app-token.js'
import { nomeDeRepositorioValido } from '../services/nome-de-repositorio.js'
import {
  repositoriosSemEscrita,
  escreveSegundoAListagem,
  AcessoNaoVerificavelError,
  CredencialDoGithubInvalidaError,
} from '../services/acesso-ao-repositorio.js'

/**
 * O que uma listagem do GitHub devolve por repositório, do pouco que a tela
 * precisa exibir.
 *
 * `permissions` entra tipado como `unknown` de propósito: o bloco só vale
 * quando a listagem é do PRÓPRIO CLIENTE (`GET /user/repos`), onde ele
 * descreve o portador do token; na listagem da instalação ele descreve o APP,
 * e lê-lo como se fosse do cliente foi um dos buracos fechados aqui. Quem
 * decide é `escreveSegundoAListagem` (services/acesso-ao-repositorio.ts), e
 * ela nunca é aplicada à lista da instalação.
 */
interface GitHubRepo {
  id: number
  name: string
  full_name: string
  description: string | null
  private: boolean
  html_url: string
  permissions?: unknown
}

// Sem `telegram` aqui, e não é esquecimento: o @username que o passo 8 mandava
// era gravado em runtimeConfig/payload e ninguém lia — nem adiantaria ler, já
// que a API do Telegram endereça por `chat_id`, não por @username. O vínculo de
// verdade tem tabela própria (telegram_links) e nasce do `/start <token>` que o
// cliente dispara no bot. Ver services/telegram-link.ts.
interface SetupSubmitBody {
  repos: string[]
  engines: string[]
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
  id: string
  projectId: string
  status: string
  error: string | null
  payload: Prisma.JsonValue
  project: { wingId: string }
}

/**
 * Posição (1-based) de cada missão PENDENTE na fila global do scheduler —
 * mesma ordem (createdAt asc) que `processSetupMissions` usa pra decidir
 * quem reivindica primeiro quando o teto de concorrência está cheio (ver
 * scheduler.ts: selectClaimableSetupMissions). "Global" porque o teto é da
 * instância inteira, não por dono: a posição do cliente reflete a fila real
 * que ele vai esperar, não uma fila fictícia só dele.
 */
function buildQueuePositionById(globalPendingFifo: Array<{ id: string }>): Map<string, number> {
  const positions = new Map<string, number>()
  globalPendingFifo.forEach((mission, index) => positions.set(mission.id, index + 1))
  return positions
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

// Estrutura simplificada que o front consome — igual para os dois caminhos
// (OAuth clássico e installation token), então StepSelectRepos nunca precisa
// saber qual dos dois trouxe a lista.
function mapGitHubRepos(repos: GitHubRepo[]): Array<{
  id: number
  name: string
  fullName: string
  description: string | null
  private: boolean
  url: string
}> {
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    url: repo.html_url,
  }))
}

/** Shape público de uma dúvida de agente — o que o painel (GET .../agent-questions) recebe. */
interface PublicAgentQuestion {
  id: string
  text: string
  context: string | null
  options: AgentQuestionOptionView[]
  status: string
  answer: string | null
  answeredAt: Date | null
  createdAt: Date
}

interface AgentQuestionOptionView {
  label: string
  value: string
}

// Nunca expõe campo interno/sensível (userId, telegramMessageId, dedupKey — ver
// AgentQuestionRecord em services/agent-question.ts): o painel só EXIBE, quem
// responde é o dono pelo Telegram. `options` sempre vira array — se o dado
// gravado não for um array (nunca deveria acontecer, mas o Json do Prisma não
// garante o shape em tempo de compilação), devolve `[]` em vez de lançar.
function toPublicQuestion(q: AgentQuestionRecord): PublicAgentQuestion {
  return {
    id: q.id,
    text: q.text,
    context: q.context,
    options: Array.isArray(q.options) ? (q.options as unknown as AgentQuestionOptionView[]) : [],
    status: q.status,
    answer: q.answer,
    answeredAt: q.answeredAt,
    createdAt: q.createdAt,
  }
}

/**
 * CANDIDATOS a aparecer na tela, vindos da instalação do GitHub App que o
 * usuário escolheu (routes/github-app-install.ts).
 *
 * "Candidatos", não "autorizados", e a diferença é o buraco que fechamos: esta
 * chamada é do APP (token assinado com a chave privada) e devolve TODOS os
 * repositórios cobertos pela instalação. Numa organização, isso inclui o que
 * aquele cliente não alcança — a colaboradora de `acme/api` via `acme/segredos`
 * na lista. Listar continua servindo para MONTAR a tela; quem AUTORIZA é a
 * prova por repositório com o token do próprio cliente
 * (services/acesso-ao-repositorio.ts), aplicada logo depois.
 *
 * `undefined` (nunca lança) sinaliza "sem instalação usável agora" — quem chama
 * cai de volta no caminho OAuth (compat), nunca quebra o wizard por causa disto.
 */
async function candidatosViaInstalacao(installationId: number): Promise<GitHubRepo[] | undefined> {
  const installationToken = await mintInstallationToken({ installationId })
  if (!installationToken) return undefined

  const response = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch-control-plane',
    },
  })
  if (!response.ok) return undefined

  const body = (await response.json()) as { repositories?: GitHubRepo[] }
  if (!Array.isArray(body.repositories)) return undefined

  return body.repositories
}

/**
 * Teto de provas por repositório para MONTAR a tela — vale só no caminho da
 * instalação, o único em que a listagem não responde a pergunta certa.
 *
 * Ali o custo é inevitável e é por repositório: `/installation/repositories`
 * também traz um bloco `permissions`, mas é o do APP naquele repositório, não
 * o do cliente — e foi ler esse bloco como se fosse dele que deixou a
 * colaboradora de `acme/api` enxergar `acme/segredos`. Como cada prova gasta
 * uma chamada da cota do PRÓPRIO cliente (a mesma do clone, do diagnóstico e
 * da coleta de contexto), o número delas tem um teto.
 *
 * Acima do teto a tela oferece menos do que a instalação cobre, e o corte fica
 * no log: numa organização com centenas de repositórios, abrir o wizard
 * gastaria centenas de chamadas do cliente antes de ele clicar em nada. O
 * caminho normal (listagem do próprio cliente) não paga nada disso e não tem
 * teto nenhum.
 */
export const TETO_DE_PROVAS_DA_TELA = 30

/**
 * Peneira os candidatos pela prova por repositório: fica só o que o CLIENTE
 * pode escrever. Propaga `AcessoNaoVerificavelError` — a tela prefere dizer
 * "não consegui confirmar agora" a devolver uma lista curta que o cliente leria
 * como "você não tem esses repositórios".
 */
async function somenteOndeOClienteEscreve(
  candidatos: GitHubRepo[],
  githubToken: string
): Promise<GitHubRepo[]> {
  const comEndereco = candidatos
    .filter((repo) => typeof repo.full_name === 'string')
    .slice(0, TETO_DE_PROVAS_DA_TELA)
  const semEscrita = new Set(
    (
      await repositoriosSemEscrita(
        comEndereco.map((repo) => repo.full_name),
        { githubToken }
      )
    ).map((nome) => nome.trim().toLowerCase())
  )
  return comEndereco.filter((repo) => !semEscrita.has(repo.full_name.trim().toLowerCase()))
}

export const setupRoutes = async (app: FastifyInstance): Promise<void> => {
  // Ambiente isolado do cliente: nasce no aceite dos termos, vive por todo o
  // wizard (clone + credenciais dentro dele) e fixa no aceite final. O baseDir
  // vem de env (infra), nunca hardcoded; o `path` é interno e NUNCA vai pro
  // frontend.
  const clientEnvironments = new ClientEnvironmentService(app.prisma)

  // GET /api/v1/github/repos - List user repositories.
  //
  // LISTAR e AUTORIZAR são coisas diferentes aqui, e confundir as duas foi o
  // que abriu três buracos seguidos. A LISTAGEM monta a OFERTA — ela responde
  // "o que a tela tem direito de mostrar". Quem AUTORIZA é a prova por
  // repositório (services/acesso-ao-repositorio.ts), com o token do PRÓPRIO
  // cliente, e ela continua obrigatória no passo final
  // (`POST /api/v1/setup/submit`), onde os repositórios são poucos e é ali que
  // a autorização de fato acontece.
  //
  // A oferta usa o MESMO critério da prova (escrita — `push`), de propósito:
  // assim a tela nunca oferece o que o passo final vai recusar.
  //
  // Duas fontes de candidatos, nesta ordem:
  // 1. Se o usuário JÁ instalou o GitHub App e escolheu quais repos (F1 Onda
  //    2, routes/github-app-install.ts), a instalação dá a lista mais curta —
  //    mas ela é do APP, não dele: numa organização cobre repositório que
  //    aquele cliente não alcança, e o `permissions` que vem ali é o do App
  //    naquele repositório. É o único caminho em que provar candidato a
  //    candidato na tela é inevitável — e por isso ele tem teto
  //    (TETO_DE_PROVAS_DA_TELA).
  // 2. Senão (ou se o installation token falhar por qualquer razão — App não
  //    configurado, instalação removida, API fora), cai no caminho OAuth
  //    clássico de sempre (conexão cifrada por usuário, NUNCA do JWT da
  //    sessão — spec §17.4). Ali a lista é ainda mais ampla de propósito pelo
  //    GitHub (`affiliation` traz colaborador e membro de organização) — mas
  //    cada item já vem com o `permissions` DO CLIENTE, então a oferta sai da
  //    própria listagem: uma chamada por página, prova extra nenhuma. Antes
  //    disto, montar a tela custava 1 + N chamadas da cota do cliente.
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

    // O token do cliente é lido ANTES de qualquer fonte: sem ele não há prova
    // possível, e uma tela montada sem prova é justamente o que oferecia
    // repositório alheio. Sem credencial, o wizard pede a reconexão em vez de
    // mostrar uma lista que não pode sustentar.
    const githubToken = await app.engineConnections.getRawGithubToken(request.user.id)
    if (!githubToken) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: GitHub not connected' })
    }

    const dbUser = await app.prisma.user.findUnique({
      where: { id: request.user.id },
      select: { githubInstallationId: true },
    })

    // Candidatos vindos da INSTALAÇÃO: a lista é do App, então cada um precisa
    // da prova com o token do cliente (com teto, ver TETO_DE_PROVAS_DA_TELA).
    let candidatosDaInstalacao: GitHubRepo[] | undefined
    if (dbUser?.githubInstallationId) {
      candidatosDaInstalacao = await candidatosViaInstalacao(dbUser.githubInstallationId)
      // installation token indisponível agora — segue pro caminho OAuth
      // abaixo em vez de devolver erro pro cliente.
      if (candidatosDaInstalacao && candidatosDaInstalacao.length > TETO_DE_PROVAS_DA_TELA) {
        app.log.warn(
          {
            userId: request.user.id,
            cobertos: candidatosDaInstalacao.length,
            teto: TETO_DE_PROVAS_DA_TELA,
          },
          '[setup] a instalação cobre mais repositórios do que a tela prova por vez; a oferta foi cortada no teto'
        )
      }
    }

    if (!candidatosDaInstalacao) {
      const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'gitorch-control-plane',
        },
      })

      if (!response.ok) {
        // Contrato de erro do wizard (mesmo padrão do POST /setup/clone): NUNCA
        // um 500 cru sem classificar. Achado real do QA (19/07) — token
        // expirado/revogado fazia a API do GitHub responder 401 "Bad
        // credentials" (um objeto, não array), e o código anterior caía direto
        // no branch genérico abaixo por engano de tipo.
        const body = await response.json().catch(() => null)
        const code = classifyGithubApiError(response.status, body)
        app.log.warn({ code, status: response.status }, '[setup] GET /user/repos do GitHub falhou')
        return reply.code(setupErrorHttpStatus(code)).send({
          error: 'Failed to fetch repositories from GitHub',
          code,
        })
      }

      const repos = (await response.json()) as GitHubRepo[]
      if (!Array.isArray(repos)) {
        return reply.code(500).send({ error: 'Failed to fetch repositories from GitHub' })
      }

      // A listagem do PRÓPRIO cliente já traz o `permissions` dele em cada
      // item: a oferta sai daí, com o mesmo critério de escrita que o passo
      // final aplica. Nenhuma chamada extra — e nenhuma suposição: item sem
      // `permissions` fica de fora.
      return reply.send(mapGitHubRepos(repos.filter(escreveSegundoAListagem)))
    }

    try {
      return reply.send(
        mapGitHubRepos(await somenteOndeOClienteEscreve(candidatosDaInstalacao, githubToken))
      )
    } catch (err) {
      // Credencial recusada pelo GitHub tem conserto — reconectar — e por isso
      // vem ANTES: no ramo geral ela sairia como indisponibilidade, e o único
      // conselho da indisponibilidade é "tente de novo em instantes", que
      // nunca ressuscita um token revogado. Este é o code que o passo da tela
      // já traduz no botão "entrar de novo no GitHub".
      if (err instanceof CredencialDoGithubInvalidaError) {
        app.log.warn(
          { userId: request.user.id, error: err.message },
          '[setup] listagem recusada: o GitHub não aceita mais a credencial do cliente'
        )
        return reply.code(setupErrorHttpStatus('GITHUB_TOKEN_EXPIRED')).send({
          error: 'Sua conexão com o GitHub não vale mais — reconecte para continuar.',
          code: 'GITHUB_TOKEN_EXPIRED',
        })
      }
      if (err instanceof AcessoNaoVerificavelError) {
        // Devolver a lista peneirada pela metade seria mentir por omissão: o
        // cliente leria "não tenho esses repositórios". Indisponibilidade se
        // diz com o nome dela.
        app.log.warn(
          { userId: request.user.id, error: err.message },
          '[setup] listagem recusada: não foi possível confirmar o acesso aos repositórios'
        )
        return reply.code(503).send({
          error:
            'Não foi possível confirmar no GitHub quais repositórios são seus agora — tente de novo em instantes.',
          code: 'REPOS_NAO_VERIFICAVEIS',
        })
      }
      throw err
    }
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

  // POST /api/v1/setup/environment/reset - "Recomeçar do zero": destrói o
  // ambiente ATUAL do cliente (provisório com um clone quebrado, ou já
  // fixado com um provisionamento que falhou) e cria um provisório novo,
  // vazio. É o botão de último recurso — /setup/retry (missão) já cobre a
  // retentativa cirúrgica (mesmo projeto, mesmo payload); este reset é para
  // quando o cliente prefere simplesmente recomeçar o wizard. `destroy()`
  // (environment.ts) já contém o guard de path-traversal e nunca apaga fora
  // da raiz de ambientes; aqui só decidimos QUAL ambiente destruir — e é
  // sempre o do dono da sessão, nunca de outro cliente.
  app.post(
    '/api/v1/setup/environment/reset',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const current = await clientEnvironments.current(request.user.id)
      if (current) {
        await clientEnvironments.destroy(current.id)
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
      // Teto de repos por plano — lido do PLANO REAL do usuário no SERVIDOR, nunca
      // do corpo da requisição. A versão anterior fazia `plan ?? body...` e
      // confiava no `plan` que o cliente mandava: bastava enviar plan:'team' pra
      // furar o limite do grátis (e o fallback `request.user.planId` era código
      // morto — o token não carrega esse campo). Fonte única de verdade:
      // User.planId + Plan.maxProjects (o mesmo par que o billing usa).
      const dbUser = await app.prisma.user.findUnique({
        where: { id: request.user.id },
        select: { planId: true },
      })
      const userPlan = dbUser?.planId ?? 'free'
      const planRow = await app.prisma.plan.findUnique({
        where: { id: userPlan },
        select: { maxProjects: true },
      })
      const maxRepos = planRow?.maxProjects ?? 1
      if (repos.length > maxRepos) {
        return reply.code(400).send({
          error: `Plan limit exceeded: plan (${userPlan.toUpperCase()}) allows at most ${maxRepos} repository/repositories`,
          code: 'REPOS_EXCEED_PLAN_LIMIT',
        })
      }
      // Token do PRÓPRIO cliente (repo privado). Ausente em composições sem o
      // plugin de motores; clone anônimo cobre repo público.
      const token = app.engineConnections
        ? await app.engineConnections.getRawGithubToken(request.user.id)
        : null
      const env = await clientEnvironments.createProvisional(request.user.id)
      try {
        const cloned = await clientEnvironments.cloneInto(env.id, repos, token ?? undefined)
        // Dispara o bootstrap de recursos AQUI (correção do bug de TIMING,
        // W1): antes, só o /setup/submit (passo 10) disparava — e o dono
        // testou até o passo 7 (conectar motores) sem nunca chegar no
        // submit, então seu ambiente NUNCA teve os recursos instalados. Agora
        // dispara logo após o clone (passo 4/5), bem mais cedo no funil.
        // Fire-and-forget (mesmo padrão do submit, abaixo): não trava esta
        // resposta HTTP (a 1ª instalação de uma versão nova pode levar
        // minutos); bootstrapResources() nunca lança sozinho (captura as
        // próprias falhas), o catch aqui é só cinto de segurança contra um
        // bug inesperado no disparo em si. O guard de reentrância dentro de
        // bootstrapResources (environment.ts) torna seguro o disparo
        // REPETIDO daqui e do submit para o MESMO ambiente.
        clientEnvironments.bootstrapResources(env.id).catch((err) => {
          app.log.error(
            { error: err instanceof Error ? err.message : String(err) },
            '[setup] disparo do bootstrap de recursos falhou inesperadamente (clone)'
          )
        })
        return reply.send({ envId: env.id, count: cloned.length })
      } catch (err) {
        // Contrato de erro ponta-a-ponta: NUNCA um 500 cru (sem classificar).
        // O code é o que o frontend usa pra escolher a dica certa; a
        // mensagem aqui é só pra log — nunca conteve o token (o provider já
        // sanitiza) nem caminho em disco.
        const code = classifyCloneError(err)
        app.log.warn(
          { code, error: err instanceof Error ? err.message : String(err) },
          '[setup] clone falhou'
        )
        return reply.code(setupErrorHttpStatus(code)).send({
          error: err instanceof Error ? err.message : 'Clone failed',
          code,
        })
      }
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

      const { repos, engines, plan, envConfig } = request.body as SetupSubmitBody

      if (!repos || repos.length === 0) {
        return reply.code(400).send({ error: 'At least one repository must be selected' })
      }

      // Resolve o DONO a partir da sessão (e-mail do usuário autenticado) e o
      // limite de projetos do plano dele.
      const owner = user.email
        ? await app.prisma.user.findUnique({
            where: { email: user.email },
            include: { plan: true },
          })
        : null

      // Sem dono resolvido não há a quem o projeto pertença — e um Project órfão
      // (user_id nulo) cai num namespace GLOBAL onde o próximo cliente sem dono
      // o encontraria pelo repo e herdaria uma ApiKey sobre ele. É a porta exata
      // do vazamento entre clientes: recusa em vez de criar no limbo.
      if (!owner) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: sessão sem dono resolvível' })
      }

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
      const maxProjects = Math.max(owner.plan?.maxProjects ?? 1, submittedPlan?.maxProjects ?? 1)
      const currentCount = await app.prisma.project.count({ where: { userId: owner.id } })
      if (currentCount + repos.length > maxProjects) {
        return reply.code(400).send({
          error: `Plan limit reached: up to ${maxProjects} project(s) allowed (${currentCount} in use)`,
        })
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
      // conectado.
      const connections = await app.engineConnections.list(owner.id)
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

      // 1.6. DE QUEM É O REPOSITÓRIO. Nenhuma checagem acima pergunta isso —
      // elas cuidam de quantidade, plano e motor. O endereço vinha cru do corpo
      // e virava `wingId` do projeto; como o produto resolve a instalação do
      // GitHub PELO REPOSITÓRIO (services/github-app-token.ts), declarar o
      // endereço de outro cliente fazia o gitorch emitir credencial da
      // instalação DELE e passar a escrever na conta de quem nunca autorizou.
      //
      // A guarda de FORMATO não cobre isto — "vitima/repo" é um endereço
      // perfeitamente válido —, mas continua valendo como primeira porta: ela
      // recusa o texto que tentaria trocar o endpoint chamado lá na frente, e
      // dá um erro honesto em vez de um "sem acesso" confuso.
      const foraDeFormato = repos.filter((repo) => !nomeDeRepositorioValido(repo))
      if (foraDeFormato.length > 0) {
        return reply.code(400).send({
          error: `Endereço de repositório inválido (esperado "dono/repositorio"): ${foraDeFormato.join(', ')}`,
          code: 'REPO_FORMATO_INVALIDO',
        })
      }

      // O token do dono é lido UMA vez e serve a dois propósitos: provar o
      // acesso agora e alimentar a coleta de contexto lá embaixo. Se a leitura
      // falhar (envelope corrompido, chave rotacionada), fica `null` — e sem
      // credencial não há como verificar, então o pedido é recusado em vez de
      // seguir no escuro.
      const githubTokenDoDono = app.engineConnections
        ? await app.engineConnections.getRawGithubToken(owner.id).catch((err: unknown) => {
            app.log.warn(
              { error: err instanceof Error ? err.message : String(err) },
              '[setup] não foi possível ler a credencial do GitHub do dono'
            )
            return null
          })
        : null

      // Sem credencial do cliente não há pergunta a fazer — e "não sei" nunca
      // vira "pode". A instalação do App NÃO substitui isto: o token dela é
      // emitido com a chave privada do App e responde pela instalação inteira,
      // não por este cliente (ver services/acesso-ao-repositorio.ts).
      if (!githubTokenDoDono) {
        app.log.warn(
          { ownerId: owner.id },
          '[setup] submit recusado: sem credencial do GitHub para provar o acesso'
        )
        return reply.code(503).send({
          error:
            'Não foi possível confirmar no GitHub que estes repositórios são seus agora — reconecte o GitHub ou tente de novo em instantes.',
          code: 'REPOS_NAO_VERIFICAVEIS',
        })
      }

      try {
        // A MESMA prova que a tela usou para montar a lista, repetida aqui: uma
        // chamada exata por repositório, com o token do PRÓPRIO cliente, onde
        // `push === true` é o que autoriza.
        const semAcesso = await repositoriosSemEscrita(repos, { githubToken: githubTokenDoDono })
        if (semAcesso.length > 0) {
          app.log.warn(
            { ownerId: owner.id, semAcesso },
            '[setup] submit recusado: repositório declarado não pertence a quem pediu'
          )
          return reply.code(403).send({
            error: `Você não tem acesso a este repositório no GitHub: ${semAcesso.join(', ')}. Escolha um da sua lista.`,
            code: 'REPO_SEM_ACESSO',
          })
        }
      } catch (err) {
        // Mesma separação da listagem: credencial recusada pelo GitHub pede
        // reconexão, não uma nova tentativa. A recusa é idêntica — o projeto
        // não nasce —, só o que se diz ao cliente muda.
        if (err instanceof CredencialDoGithubInvalidaError) {
          app.log.warn(
            { ownerId: owner.id, error: err.message },
            '[setup] submit recusado: o GitHub não aceita mais a credencial do cliente'
          )
          return reply.code(setupErrorHttpStatus('GITHUB_TOKEN_EXPIRED')).send({
            error: 'Sua conexão com o GitHub não vale mais — reconecte para continuar.',
            code: 'GITHUB_TOKEN_EXPIRED',
          })
        }
        if (err instanceof AcessoNaoVerificavelError) {
          // Não conseguir conferir NÃO é permissão. Recusa com motivo claro e
          // convite a tentar de novo — nunca cria o projeto no escuro.
          app.log.warn(
            { ownerId: owner.id, error: err.message },
            '[setup] submit recusado: não foi possível confirmar o acesso aos repositórios'
          )
          return reply.code(503).send({
            error:
              'Não foi possível confirmar no GitHub que estes repositórios são seus agora — reconecte o GitHub ou tente de novo em instantes.',
            code: 'REPOS_NAO_VERIFICAVEIS',
          })
        }
        throw err
      }

      const createdProjects = []
      // repoFullName -> Project criado/reusado nesta submissão. Alimenta a
      // coleta de contexto abaixo: precisa do id (pra persistir o board) e do
      // runtimeConfig (pra ler o board já conhecido de um submit anterior).
      const projectsByRepo = new Map<string, { id: string; runtimeConfig: Prisma.JsonValue }>()

      // 2. Create Project records and API keys
      for (const repoFullName of repos) {
        const repoName = repoFullName.split('/')[1] || repoFullName
        const wingId = repoFullName // owner/repo maps to wingId

        // O projeto já existe PARA ESTE DONO? O escopo por `userId` é o que
        // impede o vazamento entre clientes: `wingId` é o repositório
        // ("owner/repo"), e dois clientes podem cadastrar o mesmo repo (dois
        // colaboradores de "acme/api"). Buscando só por `wingId`, o segundo
        // achava o Project do PRIMEIRO e recebia uma ApiKey válida sobre o
        // projeto alheio. O banco garante o mesmo invariante
        // (@@unique([userId, wingId])); aqui é defesa em profundidade — junto
        // com o guard de tenant do Prisma, que também injeta o dono da sessão.
        let project = await app.prisma.project.findFirst({
          where: { wingId, userId: owner.id },
        })

        if (!project) {
          project = await app.prisma.project.create({
            data: {
              wingId,
              name: repoName,
              description: `Project for ${repoFullName}`,
              // O projeto nasce sempre COM dono — nunca no limbo global.
              userId: owner.id,
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
              envConfig: (envConfig ?? null) as Prisma.JsonObject | null,
              // Evento 1 completo: o QA fecha o onboarding em modo Reconhecimento
              // (projeto novo não tem PR para revisar; ele aprende o que "correto"
              // significa neste repositório antes do primeiro PR chegar).
              onboardingSequence: ['ra', 'po', 'sm', 'qa'],
            } as Prisma.JsonObject,
            status: 'pending',
          },
        })
      }

      // Aceite final concluído: fixa o ambiente do cliente (provisional → fixed),
      // tirando-o do alcance da faxina 24h — agora é um cliente de verdade.
      await clientEnvironments.fix(user.id)

      // SALVAGUARDA (correção do bug de TIMING, W1): o disparo PRINCIPAL do
      // bootstrap de recursos agora acontece cedo, no /setup/clone (passo
      // 4/5) — ver o comentário lá. Este aqui cobre o caso de um ambiente
      // que pulou o clone por algum motivo, ou onde o clone disparou mas
      // falhou silenciosamente antes de chegar aqui. Graças ao guard de
      // reentrância em bootstrapResources (environment.ts: resourcesStatus
      // 'ready'/'provisioning' retornam cedo sem rodar o script de novo), este
      // 2º disparo é um no-op seguro no caso comum (clone já cuidou disso).
      // Assíncrono de propósito — não trava esta resposta HTTP (a 1ª
      // instalação de uma versão nova pode levar minutos); o progresso real
      // fica em `environment.resourcesStatus`, que GET /setup/status expõe.
      // bootstrapResources() nunca lança (captura as próprias falhas
      // internamente); o catch aqui é só cinto de segurança contra um bug
      // inesperado no disparo em si.
      const fixedEnv = await clientEnvironments.current(user.id)
      if (fixedEnv) {
        clientEnvironments.bootstrapResources(fixedEnv.id).catch((err) => {
          app.log.error(
            { error: err instanceof Error ? err.message : String(err) },
            '[setup] disparo do bootstrap de recursos falhou inesperadamente'
          )
        })
      }

      // Coleta de contexto → memória (F4.2.3): junta board + PRs + Issues de
      // cada repo e grava no Cortex (ponte GitHub→memória). BEST-EFFORT — nunca
      // derruba o aceite final: sem Cortex/token (ex.: teste de rota isolado) ou
      // numa falha de API, o cliente fica fixado do mesmo jeito e só logamos.
      // `collectAndRememberRepoContext` já não lança; o try/catch é o cinto de
      // segurança para qualquer erro inesperado (nunca vira 500 pro cliente).
      try {
        // Mesmo token já lido na verificação de acesso — reusar evita uma
        // segunda decifragem e garante que os dois passos falem da mesma
        // credencial.
        const githubToken = githubTokenDoDono
        if (app.cortex && githubToken) {
          for (const repoFullName of repos) {
            const project = projectsByRepo.get(repoFullName)
            const boardNumber = readKnownBoardNumber(project?.runtimeConfig)
            // Sem isto a dívida de segurança NUNCA é coletada em produção: o
            // App do produto (githubToken acima) leva 403 nessas rotas, só a
            // credencial que o cliente forneceu em /setup/credencial-do-cliente
            // alcança. Ausente (cliente ainda não passou por lá) é um estado
            // válido — collect() já sabe sair sem a dívida nesse caso.
            // O .catch é próprio: sem ele, uma credencial ilegível (chave
            // rotacionada, envelope corrompido) neste repositório derruba o
            // laço inteiro e outros repositórios do mesmo submit perdem
            // board/PRs/issues também, sem ter problema nenhum — mesmo
            // padrão best-effort aplicado à leitura equivalente em
            // onboarding-board.ts.
            const clientToken = project
              ? await lerCredencialDoProjeto({ prisma: app.prisma, projectId: project.id }).catch(
                  (err) => {
                    app.log.warn(
                      `[setup] nao foi possivel ler a credencial do cliente para ${repoFullName}, seguindo sem ela: ${(err as Error).message}`
                    )
                    return null
                  }
                )
              : null
            const result = await collectAndRememberRepoContext({
              token: githubToken,
              wingId: repoFullName,
              cortex: app.cortex,
              clientToken,
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

  // POST /api/v1/setup/credencial-do-cliente — a porta de entrada da
  // credencial PRÓPRIA do cliente. O App do produto é recusado com 403 tanto
  // no quadro de conta pessoal quanto em qualquer rota de segurança
  // (dependabot, alertas) — só a credencial do próprio cliente alcança essas
  // duas coisas, e é esta rota que a recebe e guarda.
  //
  // Prova de dono: só aceita gravar sobre um projeto que já pertence ao dono
  // resolvido da SESSÃO (mesmo padrão anti-vazamento que /setup/submit usa —
  // `userId: ownerId` no filtro, nunca só o id cru do corpo). Sem isto,
  // qualquer sessão autenticada poderia plantar ou substituir a credencial de
  // um projeto alheio só sabendo o id dele.
  app.post(
    '/api/v1/setup/credencial-do-cliente',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const { projectId, token } = (request.body ?? {}) as { projectId?: string; token?: string }
      if (!projectId || !token) {
        return reply.code(400).send({ erro: 'projectId e token são obrigatórios' })
      }

      const ownerId = await resolveOwnerId(request.user)
      const project = await app.prisma.project.findFirst({
        where: { id: projectId, userId: ownerId },
        select: { id: true },
      })
      if (!project) {
        return reply.code(404).send({ erro: 'projeto não encontrado' })
      }

      let credencial
      try {
        credencial = await verificarCredencial({ token })
      } catch (err) {
        if (err instanceof VerificacaoIndisponivelError) {
          // Falha em COMUNICAR com o GitHub (instável, rate-limited) — nunca
          // culpa da credencial. Dizer o contrário mandaria o cliente trocar
          // um token que está certo.
          return reply.code(503).send({
            erro: 'Não foi possível verificar a credencial agora — o GitHub está indisponível, tente de novo em instantes',
            faltando: [],
          })
        }
        throw err
      }

      if (!credencial) {
        return reply.code(400).send({ erro: 'Credencial inválida ou expirada', faltando: [] })
      }
      if (credencial.faltando.length > 0) {
        return reply.code(400).send({
          erro: 'A credencial não tem os escopos necessários',
          faltando: credencial.faltando,
        })
      }

      // Cifra e grava só depois de confirmar que a credencial cumpre o que
      // foi prometido — nunca guarda algo que ainda não sabemos que serve.
      await guardarCredencialDoProjeto({ prisma: app.prisma, projectId, token })

      return reply.send({ login: credencial.login, faltando: [] })
    }
  )

  // POST /api/v1/setup/telegram/link — o passo 8, agora de verdade.
  //
  // Gera (ou reaproveita) o token de vínculo e devolve o deep link do bot. O
  // cliente abre, aperta Start, e o bot recebe `/start <token>` — é ali, e só
  // ali, que o `chat_id` dele passa a existir (plugins/telegram.ts escuta).
  // Antes disto o passo capturava um @username e não falava com backend nenhum:
  // o cliente informava o Telegram e nunca recebia nada.
  //
  // O vínculo é gravado sob o DONO resolvido por e-mail — o MESMO id que o
  // notificador usa para achar o chat a partir de `project.userId`. Gravar sob o
  // id cru do JWT deixaria o vínculo órfão (o mesmo pecado que o wizard já
  // corrigiu nas conexões de motor).
  app.post(
    '/api/v1/setup/telegram/link',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const ownerId = await resolveOwnerId(request.user)
      return reply.send(await startTelegramLink(app.prisma, ownerId))
    }
  )

  // GET /api/v1/setup/telegram/status — a VERDADE do vínculo, para o wizard
  // parar de girar só quando o Start acontecer de fato. Rota de POLLING: teto
  // próprio (como /setup/status), senão o limite global viraria 429 no meio da
  // espera. Devolve status + deepLink e NADA mais: o chat_id é dado pessoal e
  // não tem por que voltar para o navegador.
  app.get(
    '/api/v1/setup/telegram/status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const ownerId = await resolveOwnerId(request.user)
      return reply.send(await readTelegramLink(app.prisma, ownerId))
    }
  )

  // GET /api/v1/setup/agent-questions — o painel passa a EXIBIR as dúvidas de
  // rumo que os agentes registram (human-in-the-loop, épico W3), READ-ONLY:
  // responder continua sendo só pelo Telegram (services/telegram-bot.ts) —
  // ligar o painel para responder fica pra próxima fase (backlog). Escopo por
  // DONO resolvido por e-mail (mesmo id de toda rota acima); listForUser já
  // filtra por userId e ordena (abertas primeiro) — a garantia anti-vazamento
  // entre contas. toPublicQuestion nunca deixa passar campo interno.
  app.get(
    '/api/v1/setup/agent-questions',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const ownerId = await resolveOwnerId(request.user)
      const questions = await new AgentQuestionService(app.prisma).listForUser(ownerId)
      return reply.send({ questions: questions.map(toPublicQuestion) })
    }
  )

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

      // Fila só quando ALGUMA missão deste dono está pending — poupa a query
      // global no caso comum (running/completed/failed, sem nada esperando).
      const queuePositionById = missions.some((m) => m.status === 'pending')
        ? buildQueuePositionById(
            await app.prisma.mission.findMany({
              where: { type: SETUP_MISSION_TYPE, status: 'pending' },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
            })
          )
        : new Map<string, number>()

      return reply.send({
        status: aggregateStatus(missions),
        error: failed?.error ?? null,
        missions: missions.map((m) => ({
          projectId: m.projectId,
          wingId: m.project.wingId,
          status: m.status,
          error: m.error ?? null,
          // null quando running/completed/failed — só quem ainda espera tem
          // posição; o scheduler processa por esta MESMA ordem (FIFO por
          // createdAt, ver selectClaimableSetupMissions).
          queuePosition: m.status === 'pending' ? (queuePositionById.get(m.id) ?? null) : null,
        })),
        // Só id + status + resumo honesto das versões instaladas (W1: o dono
        // precisa VER o que está rodando no ambiente dele). O `path` é infra
        // e NUNCA vai pro frontend; `resources` nunca carrega npm/cache/
        // sha256/binary/arch/repo do lock cru — summarizeResourcesLock já
        // filtra isso, e devolve null enquanto o bootstrap não gerou o lock
        // ainda (o front mostra "preparando", nunca um bloco inventado).
        environment: environment
          ? {
              id: environment.id,
              status: environment.status,
              // Progresso do bootstrap, DESACOPLADO do ciclo de vida acima
              // (correção do bug de timing, W1 — ver ClientEnvironment.
              // resourcesStatus, schema.prisma). Contrato novo: a UI
              // (StepReady) continua decidindo só por `resources` não-nulo
              // vs nulo, então isto não muda o comportamento visual agora —
              // só evita o tipo/contrato ficar desalinhado do backend.
              resourcesStatus: environment.resourcesStatus ?? null,
              resources: summarizeResourcesLock(environment.resourcesLock),
            }
          : null,
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
