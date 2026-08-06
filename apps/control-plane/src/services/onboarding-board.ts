import type { ProjectV2Client } from '@gitorch/github-sync'

// A mesa de trabalho do PRÓPRIO projeto (Task 9). Antes disto o board vinha de
// um env GLOBAL (GITORCH_PROJECT_BOARD), o que fazia todo projeto novo apontar
// para o board global de outro projeto do dono. Um projeto novo precisa da
// própria mesa antes de o PO acordar — board gravado no próprio projeto
// (Project.runtimeConfig). Sem board próprio, os trilhos do PO ficam
// desligados: nunca há fallback para o board global de outro projeto.

export type GithubOwnerType = 'user' | 'organization'

export interface ResolvedOwner {
  /** Node id GraphQL do dono (user ou organization) — o que createProjectV2 pede. */
  id: string
  type: GithubOwnerType
}

export interface EnsureProjectBoardDeps {
  /** 'dono/repo' do projeto, como gravado em Project.wingId. */
  repository: string
  client: Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'>
  /** Resolve o node id + tipo (user ou organization) do dono no GitHub. */
  resolveOwner: (owner: string) => Promise<ResolvedOwner>
  /** Número do board já conhecido do projeto, quando houver. */
  existingNumber?: number
  onWarn?: (message: string) => void
}

export interface ProjectBoardRef {
  owner: string
  number: number
}

/**
 * Garante que o projeto tem seu PRÓPRIO board Projects v2: cria na primeira
 * vez, reaproveita se `existingNumber` ainda existir no GitHub.
 *
 * NUNCA lança. Risco conhecido: quem chama esta função no provisionamento do
 * wizard usa o token OAuth do PRÓPRIO dono do projeto (não um installation
 * token do GitHub App) — criar board de ORGANIZAÇÃO pode exigir um escopo que
 * aquele OAuth não tem e devolver "Resource not accessible by integration".
 * Se isso acontecer em produção, o certo é avisar e seguir: sem board o PO
 * ainda entrega o roadmap na memória, o que se perde é só o quadro. Derrubar
 * o provisionamento inteiro por isso seria pior que o problema que resolve —
 * mas nunca em silêncio (`onWarn` é chamado sempre).
 */
export async function ensureProjectBoard(
  deps: EnsureProjectBoardDeps
): Promise<ProjectBoardRef | null> {
  const owner = deps.repository.split('/')[0] ?? ''
  const warn = deps.onWarn ?? (() => undefined)

  if (!owner) {
    warn(`nao foi possivel derivar o dono do board a partir de '${deps.repository}'`)
    return null
  }

  try {
    const resolved = await deps.resolveOwner(owner)

    if (deps.existingNumber !== undefined) {
      const existente = await deps.client.findProjectId({
        login: owner,
        number: deps.existingNumber,
        ownerType: resolved.type,
      })
      if (existente) return { owner, number: deps.existingNumber }
    }

    const criado = await deps.client.createProjectV2({
      ownerId: resolved.id,
      title: deps.repository,
    })
    return { owner, number: criado.number }
  } catch (err) {
    warn(`falha ao garantir o board do projeto ${deps.repository}: ${(err as Error).message}`)
    return null
  }
}

const GITHUB_API = 'https://api.github.com'

export interface ResolveGithubOwnerIdDeps {
  /** injeção para teste; default: fetch global. */
  fetchImpl?: typeof fetch
}

/**
 * Resolve o node id GraphQL + tipo do dono de um repositório no GitHub.
 * Tenta `GET /users/{owner}` primeiro (cobre conta pessoal); se não achar,
 * cai para `GET /orgs/{owner}` (organização). Precisa dos dois caminhos
 * porque o dono do board pode ser qualquer um dos dois.
 */
export async function resolveGithubOwnerId(
  owner: string,
  token: string,
  deps: ResolveGithubOwnerIdDeps = {}
): Promise<ResolvedOwner> {
  const f = deps.fetchImpl ?? fetch
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
  }

  const userRes = await f(`${GITHUB_API}/users/${owner}`, { headers })
  if (userRes.ok) {
    const data = (await userRes.json()) as { node_id: string; type?: string }
    return { id: data.node_id, type: data.type === 'Organization' ? 'organization' : 'user' }
  }

  const orgRes = await f(`${GITHUB_API}/orgs/${owner}`, { headers })
  if (orgRes.ok) {
    const data = (await orgRes.json()) as { node_id: string }
    return { id: data.node_id, type: 'organization' }
  }

  throw new Error(
    `nao foi possivel resolver o dono '${owner}' no GitHub (HTTP ${userRes.status} em /users, ${orgRes.status} em /orgs)`
  )
}

export interface ProjectComBoard {
  id: string
  wingId: string
  runtimeConfig?: unknown
}

export interface EnsureAndPersistDeps {
  project: ProjectComBoard
  prisma: { project: { update: (args: unknown) => Promise<unknown> } }
  /** Emissor do installation token do App — a identidade do produto. */
  mintInstallationToken: (args: {
    repository: string
    onWarn?: (message: string) => void
    onError?: (message: string) => void
  }) => Promise<string | null>
  createProjectV2Client: (
    token: string
  ) => Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'>
  resolveOwner: (owner: string, token: string) => Promise<ResolvedOwner>
  onWarn?: (message: string) => void
}

/** Lê o board já gravado no projeto, no formato "dono/numero". */
export function boardGravado(project: ProjectComBoard): string | undefined {
  const envConfig = (project.runtimeConfig as Record<string, unknown> | null)?.['envConfig'] as
    Record<string, unknown> | undefined
  const valor = envConfig?.['GITORCH_PROJECT_BOARD']
  return typeof valor === 'string' && valor.length > 0 ? valor : undefined
}

/**
 * Garante o quadro do projeto e PERSISTE o resultado — pode ser chamada
 * quantas vezes for preciso.
 *
 * Existe porque o quadro era tentado uma única vez, no registro do projeto. Se
 * naquele instante o App ainda não estava instalado no dono do repositório, a
 * criação falhava e o projeto ficava sem quadro para sempre: os trilhos do PO
 * ficam desligados sem quadro, então nenhuma issue jamais seria criada, mesmo
 * depois de instalar o App. Chamando isto quando o PO acorda, a esteira se
 * recupera sozinha em vez de exigir um novo registro do projeto.
 *
 * NUNCA lança: sem token (App não instalado) devolve `undefined` com aviso.
 */
export async function ensureAndPersistProjectBoard(
  deps: EnsureAndPersistDeps
): Promise<string | undefined> {
  const jaGravado = boardGravado(deps.project)
  if (jaGravado) return jaGravado

  const warn = deps.onWarn ?? (() => undefined)
  const token = await deps.mintInstallationToken({
    repository: deps.project.wingId,
    onWarn: warn,
    onError: warn,
  })
  if (!token) return undefined

  const board = await ensureProjectBoard({
    repository: deps.project.wingId,
    client: deps.createProjectV2Client(token),
    resolveOwner: (owner) => deps.resolveOwner(owner, token),
    onWarn: warn,
  })
  if (!board) return undefined

  const valor = `${board.owner}/${board.number}`
  const runtimeConfig = (deps.project.runtimeConfig as Record<string, unknown> | null) ?? {}
  const envConfig = (runtimeConfig['envConfig'] as Record<string, unknown> | undefined) ?? {}
  await deps.prisma.project.update({
    where: { id: deps.project.id },
    data: {
      runtimeConfig: {
        ...runtimeConfig,
        envConfig: { ...envConfig, GITORCH_PROJECT_BOARD: valor },
      },
    },
  })
  return valor
}
