import type { ProjectV2Client } from '@gitorch/github-sync'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { fetchComTeto } from './fetch-com-teto.js'
import { decidirQuadro } from './resolver-quadro.js'

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
        | 'linkProjectV2ToRepository'
        | 'listarQuadrosDoRepositorio'
        | 'listarQuadrosDaConta'
        | 'descobrirQuadrosPorIssues'
        | 'detalharQuadro'
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
  /**
   * Credencial do PRÓPRIO cliente, quando guardada — a única capaz de criar
   * quadro em CONTA PESSOAL (medido na API real: a credencial do produto
   * devolve "does not have permission to create projects on ownerId ..." ali;
   * em organização funciona). Só entra em jogo se a criação com a credencial
   * do produto falhar.
   */
  clientToken?: string | null
  /** Monta, a partir da credencial do cliente, o mesmo formato de client que
   *  `deps.client` usa — permite repetir a criação sob a identidade certa. */
  criarClienteAlternativo?: (token: string) => EnsureProjectBoardDeps['client']
  onWarn?: (message: string) => void
}

export interface ProjectBoardRef {
  owner: string
  number: number
}

/**
 * Entre vários candidatos, vence o que tem MAIS CAMPOS.
 *
 * Decisão do dono, e a razão é o respeito ao trabalho de quem já cuidava do
 * quadro: campos são a medida de quanto alguém investiu ali. Preferir o mais
 * recente daria o resultado oposto — o mais novo costuma ser justamente o que o
 * próprio produto criou, e o mais pobre.
 *
 * Com `exigirExclusivo`, descarta quadro que guarda trabalho de outros
 * repositórios: ali é casa dos outros, e despejar o backlog deste projeto
 * dentro seria invadir.
 */
async function escolherMaisRico<T extends { id: string; number: number }>(
  candidatos: readonly T[],
  deps: EnsureProjectBoardDeps,
  opcoes: { exigirExclusivo?: boolean } = {}
): Promise<T | undefined> {
  if (candidatos.length === 0) return undefined

  if (!deps.client.detalharQuadro) {
    // Sem como olhar dentro do quadro, não dá para afirmar que ele é só deste
    // repositório — e adotar sem essa certeza é justamente o risco que a
    // exclusividade existe para evitar. Aqui, "não sei" resolve em não adotar;
    // quem chamou segue para criar um quadro próprio, que é sempre seguro.
    if (opcoes.exigirExclusivo) return undefined
    return candidatos[0]
  }

  // Empate de campos: vence o PRIMEIRO da lista, porque a comparação é estrita.
  // Determinístico de propósito — a mesma entrada sempre elege o mesmo quadro.
  let melhor: { item: T; campos: number } | undefined
  for (const c of candidatos) {
    const detalhe = await deps.client.detalharQuadro({
      projectId: c.id,
      repositorio: deps.repository,
    })
    if (opcoes.exigirExclusivo && detalhe.outrosRepositorios.length > 0) continue
    if (!melhor || detalhe.camposCount > melhor.campos) {
      melhor = { item: c, campos: detalhe.camposCount }
    }
  }
  return melhor?.item
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

    const [dono, nome] = deps.repository.split('/')

    // A busca inteira, para UMA credencial. Vira função porque precisa rodar
    // mais de uma vez: ver o comentário do passo 2.5.
    //
    // Devolve `'ambiguo'` quando há vários quadros ligados e nenhum se destaca.
    // Isso NÃO é "não achei": é "achei demais", e cair no passo 3 daí criaria
    // mais um quadro justamente onde já há quadros de sobra.
    const procurar = async (
      client: EnsureProjectBoardDeps['client']
    ): Promise<ProjectBoardRef | 'ambiguo' | null> => {
      // 1) Já anunciado a este repositório? Então não há o que criar nem ligar.
      if (client.listarQuadrosDoRepositorio) {
        const ligados = await client.listarQuadrosDoRepositorio({
          owner: dono ?? '',
          repo: nome ?? '',
        })
        if (ligados.length > 0) {
          // A MESMA decisão que a sprint usa (`resolver-quadro.ts`), e não uma
          // regra paralela: arquivado sai antes de tudo (aqui um quadro FECHADO
          // era adotado, e escrever sprint nele é escrever no vazio), e o
          // desempate é por uso — itens antes de campos.
          const decisao = decidirQuadro({
            candidatos: ligados.map((q) => ({ ...q, linkado: true })),
          })
          if (decisao.acao === 'usar') return { owner, number: decisao.quadro.number }
          if (decisao.acao === 'escolher') {
            warn(
              `${deps.repository} tem ${decisao.candidatos.length} quadros ligados e nenhum se destaca ` +
                `(${decisao.motivo}); não crio outro para sair da dúvida — escolha um no GitHub.`
            )
            return 'ambiguo'
          }
        }
      }

      // 2) As issues deste repositório já vivem em algum quadro? Esse é o quadro
      //    dele — por evidência, não por parecença de nome. Só falta anunciá-lo.
      if (client.descobrirQuadrosPorIssues) {
        const achados = await client.descobrirQuadrosPorIssues({
          owner: dono ?? '',
          repo: nome ?? '',
        })
        const vivos = achados.filter((q) => !q.closed)
        const candidato = await escolherMaisRico(
          vivos,
          { ...deps, client },
          {
            exigirExclusivo: true,
          }
        )

        if (candidato) {
          if (deps.resolveRepositoryId && client.linkProjectV2ToRepository) {
            try {
              const repositoryId = await deps.resolveRepositoryId(deps.repository)
              await client.linkProjectV2ToRepository({
                projectId: candidato.id,
                repositoryId,
              })
            } catch (err) {
              // O quadro existe e é o certo; não conseguir anunciá-lo ao
              // repositório tira o atalho da aba /projects, não o quadro.
              warn(
                `quadro #${candidato.number} de ${deps.repository} encontrado, mas falhou ao ligar ao repositório: ${(err as Error).message}`
              )
            }
          }
          return { owner, number: candidato.number }
        }
      }
      return null
    }

    const achado = await procurar(deps.client)
    if (achado === 'ambiguo') return null
    if (achado) return achado

    // 2.5) PROCURAR DE NOVO, com a credencial que vai CRIAR.
    //
    // Provado ao vivo em 31/08/2026 contra a API do GitHub: com o installation
    // token do App, `repository.projectsV2` de loureng/patinhas-3d-crafts
    // devolve `[]` — HTTP 200, sem `errors`. Com o token do dono, devolve
    // QUATRO quadros. A busca acima roda com a credencial do App; quem cria em
    // CONTA PESSOAL é a do cliente, porque a do App nem permissão tem. Buscar
    // com a cega e criar com a que enxerga é o laço: "não enxergo" vira "não
    // existe", nasce mais um quadro, e na volta seguinte tudo se repete. Foi
    // assim que #11 e #12 apareceram com 42 segundos de diferença.
    const clienteAlternativo =
      deps.clientToken && deps.criarClienteAlternativo
        ? deps.criarClienteAlternativo(deps.clientToken)
        : null
    if (clienteAlternativo) {
      const comACredencialQueCria = await procurar(clienteAlternativo)
      if (comACredencialQueCria === 'ambiguo') return null
      if (comACredencialQueCria) return comACredencialQueCria
    }

    // 3) Nada existe: cria.
    const criarELigarQuadro = async (
      client: EnsureProjectBoardDeps['client']
    ): Promise<ProjectBoardRef> => {
      const criado = await client.createProjectV2({
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
      if (deps.resolveRepositoryId && client.linkProjectV2ToRepository) {
        try {
          const repositoryId = await deps.resolveRepositoryId(deps.repository)
          await client.linkProjectV2ToRepository({ projectId: criado.id, repositoryId })
        } catch (err) {
          warn(
            `board ${deps.repository} criado mas falhou ao ligar ao repositório: ${(err as Error).message}`
          )
        }
      }

      return { owner, number: criado.number }
    }

    try {
      return await criarELigarQuadro(deps.client)
    } catch (err) {
      // Medido na API real: a credencial do PRODUTO (o App) não tem permissão
      // para criar quadro em CONTA PESSOAL — só em organização. Havendo a
      // credencial do PRÓPRIO cliente, a segunda tentativa nasce sob a
      // identidade dele. Sem ela, o erro sobe para o catch de fora, que já
      // resolve em aviso acionável — nunca em silêncio.
      if (!clienteAlternativo) throw err
      return await criarELigarQuadro(clienteAlternativo)
    }
  } catch (err) {
    warn(`falha ao garantir o board do projeto ${deps.repository}: ${(err as Error).message}`)
    return null
  }
}

const GITHUB_API = 'https://api.github.com'

// `owner`/`repository` chegam de um valor que o CLIENTE escolhe no funil de
// entrada (Project.wingId), não de um literal do produto. As duas funções
// abaixo montam a URL por concatenação e a chamada carrega uma credencial
// (token do App ou do próprio cliente) no cabeçalho Authorization — se o
// valor pudesse escapar do formato que o GitHub realmente aceita
// (atravessando diretório, embutindo outro host, ganhando uma query string),
// a URL montada sairia para um destino diferente do GitHub e levaria a
// credencial junto (mesma falha que o CodeQL já apontou como crítica em
// outro coletor deste repositório). Validar aqui, antes de montar qualquer
// URL, é a única defesa que não depende de quem chama estas funções hoje ou
// vier a chamar amanhã.
const SEGMENTO_VALIDO = /^[A-Za-z0-9._-]+$/

function segmentoValido(segmento: string): boolean {
  if (!SEGMENTO_VALIDO.test(segmento)) return false
  // O charset acima aceita '.', mas '..' isolado é o caso que abre travessia
  // de diretório em outras APIs — recusar aqui é mais barato do que confiar
  // que nunca vai importar.
  if (segmento.includes('..')) return false
  return true
}

function repositorioValido(repository: string): boolean {
  const partes = repository.split('/')
  if (partes.length !== 2) return false
  const [dono, nome] = partes
  return !!dono && !!nome && segmentoValido(dono) && segmentoValido(nome)
}

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
  if (!segmentoValido(owner)) {
    // Recusa ANTES de montar a URL ou tocar a rede — quem chama esta função
    // (`ensureProjectBoard`) já embrulha tudo em try/catch e nunca deixa
    // exceção subir (vira aviso + board null), então lançar aqui é seguro.
    throw new Error(
      `dono '${owner}' fora do formato aceito pelo GitHub — requisição recusada antes de montar a URL`
    )
  }

  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do PO,
  // criação do board próprio) sob `tickEmAndamento` — mesma classe de
  // defeito do Crítico.
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(deps.fetchImpl ?? fetchSemPermissao())
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
  if (!repositorioValido(repository)) {
    // Mesma defesa de `resolveGithubOwnerId` acima, mas a superfície aqui é
    // maior: `repository` monta a URL inteira (`/repos/{repository}`), não
    // só um segmento. Quem chama esta função (`ensureProjectBoard`, direto ou
    // via `resolveRepositoryId`) já embrulha em try/catch próprio — lançar
    // aqui não derruba nada.
    throw new Error(
      `repositorio '${repository}' fora do formato dono/repo aceito pelo GitHub — requisição recusada antes de montar a URL`
    )
  }

  // IMPORTANTE (leva D): mesma classe de defeito do Crítico.
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(deps.fetchImpl ?? fetchSemPermissao())
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
  /**
   * Lê a credencial do PRÓPRIO cliente, quando guardada — reforço opcional
   * para conta pessoal (repassada a `ensureProjectBoard` para a segunda
   * tentativa). É uma FUNÇÃO, não o valor já resolvido, de propósito: a
   * leitura passa por banco + decifragem, e as duas podem lançar (chave
   * rotacionada, dado corrompido, banco fora do ar). Chamada por dentro desta
   * função, com a mesma garantia de nunca lançar que o resto dela — perder
   * essa leitura nunca pode custar o wake inteiro do PO por um reforço que é
   * opcional por definição.
   */
  lerClientToken?: () => Promise<string | null>
  /** Monta o client no mesmo formato de `createProjectV2Client`, sob a
   *  credencial do cliente. */
  criarClienteAlternativo?: (token: string) => EnsureProjectBoardDeps['client']
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

  // Reforço opcional: se a leitura falhar por qualquer motivo, segue como se
  // não houvesse credencial — nunca deixa a exceção subir e derrubar o wake
  // inteiro do PO por causa de um recurso que só existe para cobrir conta
  // pessoal.
  const clientToken = deps.lerClientToken
    ? await deps.lerClientToken().catch((err) => {
        warn(
          `nao foi possivel ler a credencial do cliente para ${deps.project.wingId}, seguindo sem ela: ${(err as Error).message}`
        )
        return null
      })
    : null

  const board = await ensureProjectBoard({
    repository: deps.project.wingId,
    client: deps.createProjectV2Client(token),
    resolveOwner: (owner) => deps.resolveOwner(owner, token),
    ...(deps.resolveRepositoryId
      ? {
          resolveRepositoryId: (repository: string) => deps.resolveRepositoryId!(repository, token),
        }
      : {}),
    clientToken,
    ...(deps.criarClienteAlternativo
      ? { criarClienteAlternativo: deps.criarClienteAlternativo }
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
