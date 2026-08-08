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
  // `linkProjectV2ToRepository` fica OPCIONAL de propósito (Partial): callers
  // antigos que injetam um client de teste sem esse método continuam
  // compilando sem tocar em nada — o passo de ligação só roda quando
  // `resolveRepositoryId` E o método existem os dois.
  client: Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'> &
    Partial<
      Pick<
        ProjectV2Client,
        'linkProjectV2ToRepository' | 'listarQuadrosDoRepositorio' | 'listarQuadrosDaConta'
      >
    >
  /** Resolve o node id + tipo (user ou organization) do dono no GitHub. */
  resolveOwner: (owner: string) => Promise<ResolvedOwner>
  /**
   * Resolve o node id GraphQL do REPOSITÓRIO — usado só para ligar o board
   * RECÉM-CRIADO a ele (linkProjectV2ToRepository). Opcional: sem ela, o board
   * é criado normalmente e fica sem o link (comportamento de antes desta
   * correção); com ela, uma falha na ligação também nunca derruba a criação.
   */
  resolveRepositoryId?: (repository: string) => Promise<string>
  /** Número do board já conhecido do projeto, quando houver. */
  existingNumber?: number
  onWarn?: (message: string) => void
}

export interface ProjectBoardRef {
  owner: string
  number: number
}

/**
 * Um quadro serve a este repositório quando o título diz isso: ou o caminho
 * completo (`dono/repo`, que é como o produto batiza os que cria), ou o nome do
 * repositório em si — inclusive escrito por extenso, que é como uma pessoa
 * costuma nomear o quadro do próprio projeto ("Jardim das Patinhas" para
 * `jardim-das-patinhas`).
 *
 * O casamento é deliberadamente conservador: na dúvida, não reconhece. Adotar o
 * quadro errado é pior que criar um novo — seria despejar o backlog de um
 * projeto dentro do quadro de outro.
 */
function quadroServeAoRepositorio(titulo: string, repository: string): boolean {
  const normalizar = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()

  const alvoCompleto = normalizar(repository)
  const nomeDoRepo = normalizar(repository.split('/')[1] ?? '')
  const t = normalizar(titulo)

  if (!t) return false
  if (t === alvoCompleto) return true
  return nomeDoRepo.length > 0 && t === nomeDoRepo
}

/**
 * Garante que o projeto tem seu PRÓPRIO board Projects v2, percorrendo a
 * descoberta antes de criar qualquer coisa:
 *
 *   1. já existe quadro ANUNCIADO a este repositório?      -> guarda o número
 *   2. a conta tem um quadro deste repositório, mas solto?  -> liga
 *   3. nada disso                                           -> cria e liga
 *
 * O que motivou a ordem: um repositório de cliente já mantinha dois quadros
 * próprios e o produto ignorava os dois, tentando criar um terceiro por cima. O
 * trabalho do cliente é o primeiro lugar onde se procura, não o último.
 *
 * NUNCA lança. Risco conhecido: quem chama esta função no provisionamento do
 * wizard usa o token OAuth do PRÓPRIO dono do projeto (não um installation
 * token do GitHub App) — criar board de ORGANIZAÇÃO pode exigir um escopo que
 * aquele OAuth não tem e devolver "Resource not accessible by integration".
 * Se isso acontecer em produção, o certo é avisar e seguir: sem board o PO
 * ainda entrega o roadmap na memória, o que se perde é só o quadro. Derrubar
 * o provisionamento inteiro por isso seria pior que o problema que resolve —
 * mas nunca em silêncio (`onWarn` é chamado sempre).
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

    // 1) Já anunciado a este repositório? Então não há o que criar nem ligar.
    if (deps.client.listarQuadrosDoRepositorio) {
      const [dono, nome] = deps.repository.split('/')
      const ligados = await deps.client.listarQuadrosDoRepositorio({
        owner: dono ?? '',
        repo: nome ?? '',
      })
      const servindo = ligados.find((q) => quadroServeAoRepositorio(q.title, deps.repository))
      const escolhido = servindo ?? ligados[0]
      if (escolhido) return { owner, number: escolhido.number }
    }

    // 2) A conta já tem um quadro deste repositório, só que solto? Então liga,
    //    em vez de abrir outro por cima do que o cliente mantém.
    if (deps.client.listarQuadrosDaConta) {
      const daConta = await deps.client.listarQuadrosDaConta({
        login: owner,
        ownerType: resolved.type,
      })
      const candidato = daConta.find((q) => quadroServeAoRepositorio(q.title, deps.repository))
      if (candidato) {
        if (deps.resolveRepositoryId && deps.client.linkProjectV2ToRepository) {
          try {
            const repositoryId = await deps.resolveRepositoryId(deps.repository)
            await deps.client.linkProjectV2ToRepository({
              projectId: candidato.id,
              repositoryId,
            })
          } catch (err) {
            // O quadro existe e serve; não conseguir anunciá-lo ao repositório
            // tira o atalho da aba /projects, não o quadro.
            warn(
              `quadro #${candidato.number} de ${deps.repository} encontrado, mas falhou ao ligar ao repositório: ${(err as Error).message}`
            )
          }
        }
        return { owner, number: candidato.number }
      }
    }

    // 3) Nada existe: cria.
    const criado = await deps.client.createProjectV2({
      ownerId: resolved.id,
      title: deps.repository,
    })

    // Achado em produção (medido via API do próprio GitHub): createProjectV2
    // pendura o board no DONO — organization.projectsV2 o via — mas ele nunca
    // era anunciado ao REPOSITÓRIO (repository.projectsV2.totalCount ficava em
    // 0, o board nunca aparecia na aba /projects do repositório). Ligar aqui,
    // logo após criar; falha em ligar NUNCA derruba a criação do board (o
    // roadmap ainda funciona sem o link — só a aba /projects que fica sem o
    // atalho).
    if (deps.resolveRepositoryId && deps.client.linkProjectV2ToRepository) {
      try {
        const repositoryId = await deps.resolveRepositoryId(deps.repository)
        await deps.client.linkProjectV2ToRepository({ projectId: criado.id, repositoryId })
      } catch (err) {
        warn(
          `board ${deps.repository} criado mas falhou ao ligar ao repositório: ${(err as Error).message}`
        )
      }
    }

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

/**
 * Resolve o node id GraphQL de um repositório ('dono/repo') via
 * `GET /repos/{owner}/{repo}` — é o `repositoryId` que
 * `linkProjectV2ToRepository` pede para anunciar o board ao repositório.
 */
export async function resolveGithubRepositoryId(
  repository: string,
  token: string,
  deps: ResolveGithubOwnerIdDeps = {}
): Promise<string> {
  const f = deps.fetchImpl ?? fetch
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
  }

  const res = await f(`${GITHUB_API}/repos/${repository}`, { headers })
  if (!res.ok) {
    throw new Error(
      `nao foi possivel resolver o repositorio '${repository}' no GitHub (HTTP ${res.status})`
    )
  }
  const data = (await res.json()) as { node_id: string }
  return data.node_id
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
  ) => Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2' | 'linkProjectV2ToRepository'>
  resolveOwner: (owner: string, token: string) => Promise<ResolvedOwner>
  /** Resolve o node id GraphQL do repositório — liga o board recém-criado a ele (best-effort). */
  resolveRepositoryId?: (repository: string, token: string) => Promise<string>
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
    ...(deps.resolveRepositoryId
      ? {
          resolveRepositoryId: (repository: string) => deps.resolveRepositoryId!(repository, token),
        }
      : {}),
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
