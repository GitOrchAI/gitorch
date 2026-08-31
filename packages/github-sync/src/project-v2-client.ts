export interface GraphQLRequest {
  query: string
  variables: Record<string, unknown>
}

export interface GraphQLResponse<TData> {
  data?: TData
  errors?: Array<{ message: string }>
}

export type GraphQLTransport = <TData>(
  request: GraphQLRequest,
  token: string
) => Promise<GraphQLResponse<TData>>

export interface ProjectV2ClientOptions {
  token: string
  request?: GraphQLTransport
  /** fetch alternativo para o transporte padrão (testes/injeção). */
  fetchImpl?: typeof fetch
}

export interface AddProjectItemInput {
  projectId: string
  contentId: string
}

export interface UpdateSingleSelectFieldInput {
  projectId: string
  itemId: string
  fieldId: string
  optionId: string
}

export interface ArchiveProjectItemInput {
  projectId: string
  itemId: string
}

export interface CreateProjectStatusUpdateInput {
  projectId: string
  body: string
  startDate: string
  targetDate?: string
  status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'COMPLETE'
}

export interface GetProjectIdInput {
  login: string
  number: number
  ownerType: 'user' | 'organization'
}

export interface Iteration {
  id: string
  title: string
  startDate: string
  duration: number
}

export interface IterationField {
  fieldId: string
  iterations: Iteration[]
}

export interface GetIterationFieldInput {
  projectId: string
  fieldName: string
}

export interface ConfigurarIteracaoInput {
  projectId: string
  /** Nome do campo. O padrão do GitOrch é "Sprint". */
  fieldName: string
  /** Duração de cada sprint em dias. Padrão do produto: 3 (decisão do dono). */
  duracaoEmDias: number
  /** Primeiro dia da primeira sprint (YYYY-MM-DD). */
  inicio: string
}

export interface CampoDeIteracaoCriado {
  fieldId: string
  name: string
}

export interface SetIterationFieldInput {
  projectId: string
  itemId: string
  fieldId: string
  iterationId: string
}

export interface GetNumberFieldInput {
  projectId: string
  /** Nome do campo numérico. O padrão do GitOrch é "Peso". */
  fieldName: string
}

export interface CriarCampoNumericoInput {
  projectId: string
  fieldName: string
}

export interface CampoNumerico {
  fieldId: string
}

export interface CampoNumericoCriado {
  fieldId: string
  name: string
}

export interface SetNumberFieldInput {
  projectId: string
  itemId: string
  fieldId: string
  /** O valor. `ProjectV2FieldValue.number` é Float na API (introspection 31/08/2026). */
  number: number
}

/**
 * Um item do quadro do cliente, do jeito que o produto precisa dele.
 *
 * `iteracaoId` é null quando o item não está em sprint nenhuma — que era a
 * situação dos 118 itens do quadro do dono em 31/08, com o painel anunciando
 * "Sprint 1" na tela. Ler isso junto com a lista evita uma segunda volta ao
 * GitHub só para descobrir quem já está no ciclo.
 */
export interface ItemDoQuadro {
  itemId: string
  pedido: number
  iteracaoId: string | null
}

/**
 * O formato cru da resposta de `items` — usado só para tipar a paginação.
 *
 * `node` e `items` são anuláveis porque o GitHub responde 200 com `node: null`
 * quando o id do quadro não resolve. O laço já se defendia com `?.`; era o
 * tipo que prometia mais do que a API entrega.
 */
interface RespostaDeItensDoQuadro {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<{
        id: string
        content?: { number?: number } | null
        fieldValueByName?: { iterationId?: string | null } | null
      } | null> | null
    } | null
  } | null
}

export interface AddSubIssueInput {
  issueId: string
  subIssueId: string
}

export interface CreateProjectV2Input {
  /** Node id do dono (user ou organization) de onde o board pendura. */
  ownerId: string
  title: string
}

export interface CreatedProjectV2 {
  id: string
  number: number
}

export interface LinkProjectV2ToRepositoryInput {
  /** Node id do board (devolvido por createProjectV2/findProjectId). */
  projectId: string
  /** Node id GraphQL do repositório a anunciar o board. */
  repositoryId: string
}

/** Um board como ele aparece numa listagem — o bastante para decidir se serve. */
export interface QuadroListado {
  id: string
  number: number
  title: string
  /**
   * Quadro fechado (arquivado). Precisa vir na listagem: sem isso o produto
   * adota um quadro morto e passa a escrever sprint nele. Acontece de verdade
   * — a organização do gitorch tem dois quadros fechados convivendo com o
   * ativo (medido em 29/08).
   */
  closed: boolean
  /**
   * Quantos itens o quadro tem no total — a evidência de USO, e o desempate
   * mais forte quando o repositório tem mais de um quadro ligado.
   *
   * Opcional porque nem toda listagem paga por ele (`listarQuadrosDaConta` não
   * pede). Ausente é "não perguntei", nunca "está vazio": quem decide trata os
   * dois iguais só porque a diferença ali não muda o resultado — zero e
   * desconhecido perdem do mesmo jeito para um quadro com itens de verdade.
   */
  itensCount?: number
  /** Quantos campos o quadro tem: quanto alguém já investiu nele. */
  camposCount?: number
}

export interface ListarQuadrosDoRepositorioInput {
  owner: string
  repo: string
}

export interface ListarQuadrosDaContaInput {
  login: string
  ownerType: 'user' | 'organization'
}

/** Um quadro alcançado a partir das issues do repositório. */
export interface QuadroDescoberto extends QuadroListado {
  /** Quantas issues deste repositório já estão dentro dele. */
  issuesDesteRepo: number
}

export interface DescobrirQuadrosPorIssuesInput {
  owner: string
  repo: string
  /** Teto de páginas de 100 issues. Padrão 10 (mil issues). */
  maxPaginas?: number
}

export interface DetalharQuadroInput {
  projectId: string
  /** 'dono/repo' de quem está perguntando — tudo fora disso conta como outro. */
  repositorio: string
  /** Teto de páginas de 100 itens. Padrão 20 (dois mil itens). */
  maxPaginas?: number
}

export interface QuadroDetalhado {
  /** Quantos campos o quadro tem: a medida de quanto alguém já investiu nele. */
  camposCount: number
  /** Repositórios de dentro do quadro que NÃO são o que perguntou. */
  outrosRepositorios: string[]
}

/**
 * Forma da página de issues na descoberta. Nomeada de propósito: o cursor de
 * uma página alimenta a chamada da próxima, e sem um tipo declarado o
 * compilador entra em referência circular ao tentar inferi-lo.
 */
/** O quadro como a listagem chega da API, antes de virar `QuadroListado`. */
interface QuadroListadoBruto {
  id: string
  number: number
  title: string
  closed: boolean
  items?: { totalCount: number } | null
  fields?: { totalCount: number } | null
}

/** Forma da página de itens de um quadro; nomeada pelo mesmo motivo. */
interface PaginaDeItens {
  node: {
    fields: { totalCount: number } | null
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<{
        content: { repository: { nameWithOwner: string } | null } | null
      } | null> | null
    } | null
  } | null
}

interface PaginaDeIssues {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<{
        number: number
        projectItems: {
          nodes: Array<{
            project: { id: string; number: number; title: string; closed: boolean } | null
          } | null> | null
        } | null
      } | null> | null
    } | null
  } | null
}

/**
 * O campo de iteração pedido NÃO existe no quadro.
 *
 * Precisa ser um tipo próprio, e não um Error qualquer: quem chama trata a
 * AUSÊNCIA criando o campo. Se uma falha de rede, um 502 do GraphQL ou um
 * token que perdeu a autorização de quadros chegasse como o mesmo Error, o
 * produto leria "não existe" e CRIARIA um segundo campo Sprint por cima de um
 * que já está rodando — os itens ligados ao campo antigo ficariam órfãos.
 * Distinguir por texto da mensagem não serve: a mensagem do GitHub muda.
 */
export class CampoDeIteracaoAusenteError extends Error {
  constructor(
    readonly fieldName: string,
    readonly projectId: string
  ) {
    super(`Iteration field "${fieldName}" not found on project ${projectId}.`)
    this.name = 'CampoDeIteracaoAusenteError'
  }
}

/**
 * O campo NUMÉRICO não existe no quadro. Mesmo contrato do irmão de iteração:
 * ausência se resolve CRIANDO, e só ausência — um 502 do GraphQL ou um token
 * sem autorização de quadro chegando como o mesmo Error faria o produto tentar
 * criar "Peso" por cima de um que já roda, a cada tique.
 */
export class CampoNumericoAusenteError extends Error {
  constructor(
    readonly fieldName: string,
    readonly projectId: string
  ) {
    super(`Number field "${fieldName}" not found on project ${projectId}.`)
    this.name = 'CampoNumericoAusenteError'
  }
}

/**
 * O quadro já tem um campo com esse nome, e ele NÃO é de iteração.
 *
 * Caso real, achado em produção no quadro "Jardim das Patinhas" (30/08/2026):
 * existia um campo de TEXTO chamado "Sprint". A leitura de iteração não o
 * enxergava (corretamente — não é um campo de ciclo), o produto concluía "não
 * existe" e tentava criar; o GitHub recusava com "Name has already been taken".
 * Isso se repetia a cada tique, para sempre, sem ninguém entender por quê.
 *
 * Erro PRÓPRIO porque quem chama precisa reagir de forma diferente: ausência se
 * resolve criando, conflito de nome só o dono resolve — renomeando ou apagando
 * o campo antigo. Tratar os dois como a mesma coisa é o que produzia o laço.
 */
export class NomeDeCampoEmConflitoError extends Error {
  constructor(
    readonly fieldName: string,
    readonly projectId: string,
    readonly tipoExistente: string
  ) {
    super(
      `O quadro já tem um campo chamado "${fieldName}", mas ele é do tipo ` +
        `${tipoExistente}, não um campo de ciclo. Renomeie ou remova esse campo ` +
        `para o GitOrch poder criar a sprint.`
    )
    this.name = 'NomeDeCampoEmConflitoError'
  }
}

export class ProjectV2Client {
  /**
   * Teto de páginas na leitura do quadro. Existe para não girar para sempre
   * num quadro absurdo — 20 páginas são 2000 itens, muito acima de qualquer
   * quadro real. Quando ele morde, quem chamou é AVISADO (`onTruncado`); um
   * teto silencioso seria o mesmo defeito que a paginação veio consertar.
   */
  private static readonly MAX_PAGINAS_DO_QUADRO = 20

  private readonly token: string
  private readonly request: GraphQLTransport

  constructor(options: ProjectV2ClientOptions) {
    if (options.token.length === 0) {
      throw new Error('GitHub token must not be empty.')
    }

    this.token = options.token
    const f = options.fetchImpl
    this.request =
      options.request ??
      (f
        ? <TData>(request: GraphQLRequest, token: string) =>
            defaultGraphQLTransport<TData>(request, token, f)
        : defaultGraphQLTransport)
  }

  async addItemById(input: AddProjectItemInput): Promise<string> {
    const response = await this.request<{ addProjectV2ItemById: { item: { id: string } } }>(
      {
        query: `
          mutation AddProjectV2ItemById($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).addProjectV2ItemById.item.id
  }

  async updateSingleSelectField(input: UpdateSingleSelectFieldInput): Promise<string> {
    const response = await this.request<{
      updateProjectV2ItemFieldValue: { projectV2Item: { id: string } }
    }>(
      {
        query: `
          mutation UpdateProjectV2SingleSelectField(
            $projectId: ID!
            $itemId: ID!
            $fieldId: ID!
            $optionId: String!
          ) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $projectId
                itemId: $itemId
                fieldId: $fieldId
                value: { singleSelectOptionId: $optionId }
              }
            ) {
              projectV2Item { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).updateProjectV2ItemFieldValue.projectV2Item.id
  }

  async archiveItem(input: ArchiveProjectItemInput): Promise<string> {
    const response = await this.request<{ archiveProjectV2Item: { item: { id: string } } }>(
      {
        query: `
          mutation ArchiveProjectV2Item($projectId: ID!, $itemId: ID!) {
            archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
              item { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).archiveProjectV2Item.item.id
  }

  async createStatusUpdate(input: CreateProjectStatusUpdateInput): Promise<string> {
    const response = await this.request<{
      createProjectV2StatusUpdate: { statusUpdate: { id: string } }
    }>(
      {
        query: `
          mutation CreateProjectV2StatusUpdate(
            $projectId: ID!
            $body: String!
            $startDate: Date!
            $targetDate: Date
            $status: ProjectV2StatusUpdateStatus!
          ) {
            createProjectV2StatusUpdate(
              input: {
                projectId: $projectId
                body: $body
                startDate: $startDate
                targetDate: $targetDate
                status: $status
              }
            ) {
              statusUpdate { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).createProjectV2StatusUpdate.statusUpdate.id
  }

  // Resolve o node id de um Project v2 a partir do login do dono + número, ou
  // null se o board não existe. É o resolver que NÃO quebra quando ausente: a
  // coleta de contexto (F4.2) o usa para decidir CRIAR o board (createProjectV2)
  // em vez de tratar "não existe" como erro. user e organization têm consultas
  // distintas (a org é o destino final; a conta pessoal é a origem dos forks).
  async findProjectId(input: GetProjectIdInput): Promise<string | null> {
    const owner = input.ownerType === 'organization' ? 'organization' : 'user'
    const response = await this.request<
      Record<string, { projectV2: { id: string } | null } | null>
    >(
      {
        query: `
          query GetProjectId($login: String!, $number: Int!) {
            ${owner}(login: $login) {
              projectV2(number: $number) { id }
            }
          }
        `,
        variables: { login: input.login, number: input.number },
      },
      this.token
    )

    return unwrap(response)[owner]?.projectV2?.id ?? null
  }

  // Igual ao findProjectId, mas LANÇA quando o board não existe: os fluxos do PO
  // e do SM operam um board que TEM que existir, então "não encontrado" ali é
  // um erro de verdade (não um sinal para criar). Contrato estrito de sempre —
  // só passou a delegar a consulta ao findProjectId (uma fonte só).
  async getProjectId(input: GetProjectIdInput): Promise<string> {
    const id = await this.findProjectId(input)
    if (id === null) {
      const owner = input.ownerType === 'organization' ? 'organization' : 'user'
      throw new Error(`Project v2 #${input.number} not found for ${owner} "${input.login}".`)
    }
    return id
  }

  // Quais boards JÁ estão anunciados a este repositório. É a primeira pergunta
  // da descoberta: se a resposta não for vazia, não há o que criar nem ligar —
  // basta guardar o que já existe.
  //
  // Traz itens e campos JUNTO, e não numa segunda volta por quadro: o
  // repositório do dono tinha QUATRO quadros ligados, e sem esses dois números
  // a decisão via quatro candidatos idênticos e devolvia "escolher" — o que
  // parava a sprint e fazia o produto criar mais um quadro para tentar sair da
  // dúvida. `first: 1` é só para poder pedir `totalCount`; nenhum item é lido.
  async listarQuadrosDoRepositorio(
    input: ListarQuadrosDoRepositorioInput
  ): Promise<QuadroListado[]> {
    const response = await this.request<{
      repository: { projectsV2: { nodes: QuadroListadoBruto[] | null } | null } | null
    }>(
      {
        query: `
          query ListarQuadrosDoRepositorio($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
              projectsV2(first: 50) {
                nodes {
                  id
                  number
                  title
                  closed
                  items(first: 1) { totalCount }
                  fields(first: 1) { totalCount }
                }
              }
            }
          }
        `,
        variables: { owner: input.owner, repo: input.repo },
      },
      this.token
    )

    const nodes = unwrap(response).repository?.projectsV2?.nodes ?? []
    return nodes.map((n) => ({
      id: n.id,
      number: n.number,
      title: n.title,
      closed: n.closed,
      itensCount: n.items?.totalCount ?? 0,
      camposCount: n.fields?.totalCount ?? 0,
    }))
  }

  // Quais boards a CONTA tem, ligados a este repositório ou não. É a segunda
  // pergunta: o cliente pode já manter um quadro do projeto sem nunca tê-lo
  // anunciado ao repositório, e criar outro por cima seria duplicar o trabalho
  // dele.
  //
  // Conta que volta nula resolve em lista vazia de propósito: a credencial do
  // App responde assim para quadro de conta pessoal — sucesso, dono nulo, ainda
  // que existam quadros. Distinguir "não tem" de "não enxergo" é papel de quem
  // chama, com o aviso na mão; aqui só não se inventa que a lista tem algo.
  async listarQuadrosDaConta(input: ListarQuadrosDaContaInput): Promise<QuadroListado[]> {
    const campo = input.ownerType === 'organization' ? 'organization' : 'user'
    const response = await this.request<
      Record<string, { projectsV2: { nodes: QuadroListado[] | null } | null } | null>
    >(
      {
        query: `
          query ListarQuadrosDaConta($login: String!) {
            ${campo}(login: $login) {
              projectsV2(first: 50) { nodes { id number title closed } }
            }
          }
        `,
        variables: { login: input.login },
      },
      this.token
    )

    return unwrap(response)[campo]?.projectsV2?.nodes ?? []
  }

  // Descobre o quadro deste repositório pela EVIDÊNCIA de que ele já é usado:
  // as issues do próprio repositório que já estão dentro de algum quadro.
  //
  // Por que não pelo título: casar nome é frágil e perigoso. Numa revisão, a
  // comparação por semelhança acabou adotando o quadro de um repositório e
  // ligando-o a outro sem relação nenhuma, porque os nomes normalizavam igual.
  // Uma issue dentro de um quadro é fato, não parecença.
  //
  // Pagina até achar, com teto: o quadro que interessa pode estar preso a
  // issues antigas (num repositório de milhares, as do quadro curado à mão
  // eram velhas e as 100 mais recentes só achavam o quadro novo). Varrer tudo
  // sem limite, por outro lado, roda a cada acordar do agente e estouraria a
  // cota — daí o teto.
  async descobrirQuadrosPorIssues(
    input: DescobrirQuadrosPorIssuesInput
  ): Promise<QuadroDescoberto[]> {
    const teto = input.maxPaginas ?? 10
    const achados = new Map<string, QuadroDescoberto>()
    let cursor: string | null = null

    for (let pagina = 0; pagina < teto; pagina++) {
      const response: GraphQLResponse<PaginaDeIssues> = await this.request<PaginaDeIssues>(
        {
          query: `
            query DescobrirQuadrosPorIssues($owner: String!, $repo: String!, $cursor: String) {
              repository(owner: $owner, name: $repo) {
                issues(first: 100, after: $cursor, states: [OPEN, CLOSED],
                       orderBy: { field: UPDATED_AT, direction: DESC }) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    number
                    projectItems(first: 10) {
                      nodes { project { id number title closed } }
                    }
                  }
                }
              }
            }
          `,
          variables: { owner: input.owner, repo: input.repo, cursor },
        },
        this.token
      )

      const issues = unwrap(response).repository?.issues
      for (const issue of issues?.nodes ?? []) {
        for (const item of issue?.projectItems?.nodes ?? []) {
          const p = item?.project
          if (!p) continue
          const ja = achados.get(p.id)
          if (ja) ja.issuesDesteRepo += 1
          else
            achados.set(p.id, {
              id: p.id,
              number: p.number,
              title: p.title,
              closed: p.closed,
              issuesDesteRepo: 1,
            })
        }
      }

      // NÃO para no primeiro quadro encontrado. Achar um não é achar todos, e
      // sem todos não há desempate: medido num repositório real, o quadro novo
      // e pobre aparecia na primeira página e o quadro curado à mão só na
      // terceira — parar cedo elegeria justamente o pior dos dois.
      if (!issues?.pageInfo?.hasNextPage) break
      cursor = issues.pageInfo.endCursor
    }

    return [...achados.values()]
  }

  // Duas perguntas que decidem se um quadro pode ser adotado, e qual vence
  // quando há mais de um: quanto alguém já investiu nele (número de campos) e
  // se ele guarda trabalho de outros repositórios (aí é compartilhado, e
  // despejar backlog dentro seria invadir).
  //
  // Os itens são PAGINADOS, e isso não é zelo excessivo: quadro cuidado à mão
  // passa de cem itens sem esforço — o do caso que motivou esta função tem
  // cento e quarenta e seis. Olhar só a primeira página faria um quadro
  // compartilhado passar por exclusivo sempre que o item alheio estivesse lá
  // no fim, e a esteira despejaria o backlog deste projeto na casa de outro.
  async detalharQuadro(input: DetalharQuadroInput): Promise<QuadroDetalhado> {
    const teto = input.maxPaginas ?? 20
    const outros = new Set<string>()
    let camposCount = 0
    let cursor: string | null = null

    for (let pagina = 0; pagina < teto; pagina++) {
      const response: GraphQLResponse<PaginaDeItens> = await this.request<PaginaDeItens>(
        {
          query: `
            query DetalharQuadro($id: ID!, $cursor: String) {
              node(id: $id) {
                ... on ProjectV2 {
                  fields(first: 1) { totalCount }
                  items(first: 100, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      content {
                        ... on Issue { repository { nameWithOwner } }
                        ... on PullRequest { repository { nameWithOwner } }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: { id: input.projectId, cursor },
        },
        this.token
      )

      const node = unwrap(response).node
      camposCount = node?.fields?.totalCount ?? camposCount
      for (const item of node?.items?.nodes ?? []) {
        const nome = item?.content?.repository?.nameWithOwner
        // Rascunho não pertence a repositório nenhum e não indica invasão.
        if (nome && nome !== input.repositorio) outros.add(nome)
      }

      const proxima: string | null = node?.items?.pageInfo?.hasNextPage
        ? (node.items.pageInfo.endCursor ?? null)
        : null
      // Sem cursor não há como avançar: repetir a mesma página só gastaria cota.
      if (!proxima) break
      cursor = proxima
    }

    return { camposCount, outrosRepositorios: [...outros] }
  }

  // Cria um Project v2 (board) pendurado no dono (user/org) e devolve seu id +
  // número. É o "não cria" que faltava: a coleta de contexto cria o board na
  // primeira vez (quando findProjectId volta null) para então ler/gravar nele.
  async createProjectV2(input: CreateProjectV2Input): Promise<CreatedProjectV2> {
    const response = await this.request<{
      createProjectV2: { projectV2: { id: string; number: number } }
    }>(
      {
        query: `
          mutation CreateProjectV2($ownerId: ID!, $title: String!) {
            createProjectV2(input: { ownerId: $ownerId, title: $title }) {
              projectV2 { id number }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    const project = unwrap(response).createProjectV2.projectV2
    return { id: project.id, number: project.number }
  }

  // Anuncia o board ao repositório. `createProjectV2` sozinho pendura o board
  // no DONO (user/org) — sem esta mutation ele existe (aparece em
  // organization.projectsV2) mas fica órfão de repositório
  // (repository.projectsV2.totalCount = 0, nunca aparece na aba /projects do
  // repositório). Achado ao vivo em produção via API do próprio GitHub.
  async linkProjectV2ToRepository(input: LinkProjectV2ToRepositoryInput): Promise<string> {
    const response = await this.request<{
      linkProjectV2ToRepository: { repository: { id: string } }
    }>(
      {
        query: `
          mutation LinkProjectV2ToRepository($projectId: ID!, $repositoryId: ID!) {
            linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
              repository { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).linkProjectV2ToRepository.repository.id
  }

  // Lê o campo de iteração (Sprint) pelo nome e devolve suas iterations. O SM usa
  // para achar a sprint corrente ao planejar; o PO para setar a sprint do item.
  async getIterationField(input: GetIterationFieldInput): Promise<IterationField> {
    const response = await this.request<{
      node: {
        fields: {
          nodes: Array<{
            __typename?: string
            id: string
            name: string
            configuration?: { iterations: Iteration[] }
          }>
        }
      }
    }>(
      {
        query: `
          query GetIterationField($projectId: ID!) {
            node(id: $projectId) {
              ... on ProjectV2 {
                fields(first: 50) {
                  nodes {
                    __typename
                    # O nome de QUALQUER campo, não só dos de iteração: sem isto
                    # um campo de texto chamado "Sprint" fica invisível aqui, o
                    # produto conclui "não existe" e tenta criar — e o GitHub
                    # recusa por nome duplicado, a cada tique, para sempre.
                    ... on ProjectV2FieldCommon { name }
                    ... on ProjectV2IterationField {
                      id
                      configuration {
                        iterations { id title startDate duration }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { projectId: input.projectId },
      },
      this.token
    )

    const nodes = unwrap(response).node?.fields?.nodes ?? []
    const field = nodes.find((node) => node.name === input.fieldName && node.configuration)
    if (!field || !field.configuration) {
      // O nome está livre, ou já pertence a um campo de outro tipo? São
      // situações diferentes: a primeira se resolve criando, a segunda só o
      // dono resolve. Confundi-las produzia uma tentativa de criação recusada
      // por minuto, indefinidamente.
      const homonimo = nodes.find((node) => node.name === input.fieldName)
      if (homonimo) {
        throw new NomeDeCampoEmConflitoError(
          input.fieldName,
          input.projectId,
          homonimo.__typename ?? 'campo comum'
        )
      }
      throw new CampoDeIteracaoAusenteError(input.fieldName, input.projectId)
    }
    return { fieldId: field.id, iterations: field.configuration.iterations }
  }

  // Define a Sprint (iteração) de um item do board. Mesma mutation do single
  // select, mas com o valor `iterationId` (confirmado no schema real).
  async setIterationField(input: SetIterationFieldInput): Promise<string> {
    const response = await this.request<{
      updateProjectV2ItemFieldValue: { projectV2Item: { id: string } }
    }>(
      {
        query: `
          mutation SetProjectV2Iteration(
            $projectId: ID!
            $itemId: ID!
            $fieldId: ID!
            $iterationId: String!
          ) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $projectId
                itemId: $itemId
                fieldId: $fieldId
                value: { iterationId: $iterationId }
              }
            ) {
              projectV2Item { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).updateProjectV2ItemFieldValue.projectV2Item.id
  }

  /**
   * Acha um campo NUMBER do quadro pelo nome (o do GitOrch é "Peso").
   *
   * Lê `dataType` de TODO campo, não só dos numéricos, pela mesma razão que
   * `getIterationField`: um campo de TEXTO chamado "Peso" ficaria invisível
   * numa leitura filtrada, o produto concluiria "não existe", tentaria criar e
   * o GitHub recusaria com "Name has already been taken" — a cada tique, para
   * sempre. Confirmado ao vivo em 31/08/2026 contra a API de produção.
   */
  async getNumberField(input: GetNumberFieldInput): Promise<CampoNumerico> {
    const response = await this.request<{
      node: { fields: { nodes: Array<{ id?: string; name?: string; dataType?: string }> } }
    }>(
      {
        query: `
          query GetNumberField($projectId: ID!) {
            node(id: $projectId) {
              ... on ProjectV2 {
                fields(first: 50) {
                  nodes {
                    __typename
                    ... on ProjectV2FieldCommon { id name dataType }
                  }
                }
              }
            }
          }
        `,
        variables: { projectId: input.projectId },
      },
      this.token
    )

    const nodes = unwrap(response).node?.fields?.nodes ?? []
    const homonimo = nodes.find((node) => node.name === input.fieldName)
    if (!homonimo) throw new CampoNumericoAusenteError(input.fieldName, input.projectId)
    if (homonimo.dataType !== 'NUMBER' || !homonimo.id) {
      throw new NomeDeCampoEmConflitoError(
        input.fieldName,
        input.projectId,
        homonimo.dataType ?? 'campo comum'
      )
    }
    return { fieldId: homonimo.id }
  }

  /**
   * Cria o campo NUMBER no quadro.
   *
   * Diferente do campo de iteração, NUMBER não leva configuração nenhuma:
   * `CreateProjectV2FieldInput` pede só `{ projectId, dataType, name }`
   * (introspection contra a API de produção em 31/08/2026, e a mutation foi
   * executada de verdade num quadro descartável antes deste código existir —
   * `criarCampoDeIteracao` já custou caro por ter sido escrita contra um fake).
   */
  async criarCampoNumerico(input: CriarCampoNumericoInput): Promise<CampoNumericoCriado> {
    const response = await this.request<{
      createProjectV2Field: { projectV2Field: { id: string; name: string } }
    }>(
      {
        query: `
          mutation CriarCampoNumerico($projectId: ID!, $name: String!) {
            createProjectV2Field(
              input: { projectId: $projectId, dataType: NUMBER, name: $name }
            ) {
              projectV2Field {
                ... on ProjectV2Field { id name }
              }
            }
          }
        `,
        variables: { projectId: input.projectId, name: input.fieldName },
      },
      this.token
    )
    const campo = unwrap(response).createProjectV2Field.projectV2Field
    return { fieldId: campo.id, name: campo.name }
  }

  /**
   * Grava um número num campo NUMBER do card. Mesma mutation do single select
   * e da iteração, com o valor `number` (Float no schema real).
   */
  async setNumberField(input: SetNumberFieldInput): Promise<string> {
    const response = await this.request<{
      updateProjectV2ItemFieldValue: { projectV2Item: { id: string } }
    }>(
      {
        query: `
          mutation SetProjectV2Number(
            $projectId: ID!
            $itemId: ID!
            $fieldId: ID!
            $number: Float!
          ) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $projectId
                itemId: $itemId
                fieldId: $fieldId
                value: { number: $number }
              }
            ) {
              projectV2Item { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).updateProjectV2ItemFieldValue.projectV2Item.id
  }

  /**
   * Os itens do quadro, com o número do pedido que cada um representa.
   *
   * Existe porque o painel fala em "pedido #36" — o número que o dono
   * reconhece — e o GitHub move itens por um id interno que ele nunca viu.
   * A tradução acontece aqui, e não na tela: expor id de quadro no painel
   * seria vazar encanamento para quem só quer arrastar um card.
   */
  async listarItensDoQuadro(
    projectId: string,
    opcoes?: {
      /** Nome do campo de iteração a ler junto (ex.: 'Sprint'). */
      campoDeSprint?: string
      /** Chamado quando o teto de páginas cortou a leitura. */
      onTruncado?: (lidos: number) => void
    }
  ): Promise<ItemDoQuadro[]> {
    const itens: ItemDoQuadro[] = []
    let cursor: string | null = null

    // PAGINA DE VERDADE, e isso não é zelo: medido em 31/08 no quadro do dono,
    // `items(first: 100)` sem cursor trazia 100 de 118. Os 18 restantes não
    // davam erro — sumiam. E não eram sobras: eram as issues #305 a #344,
    // incluindo #308, #329 e #340, exatamente as que o dev assíncrono estava
    // trabalhando naquele instante. O trabalho vivo do produto morava na
    // página que ninguém lia.
    for (let pagina = 0; pagina < ProjectV2Client.MAX_PAGINAS_DO_QUADRO; pagina++) {
      // A anotação na variável não é enfeite nem substitui o genérico: sem o
      // `<T>` o transporte devolve `GraphQLResponse<unknown>`; sem a anotação o
      // compilador entra em referência circular, porque `cursor` sai daqui e
      // volta como variável desta mesma chamada. Precisa dos dois.
      const response: GraphQLResponse<RespostaDeItensDoQuadro> =
        await this.request<RespostaDeItensDoQuadro>(
          {
            query: `
            query ItensDoQuadro(
              $projectId: ID!
              $cursor: String
              $campo: String!
              $querSprint: Boolean!
            ) {
              node(id: $projectId) {
                ... on ProjectV2 {
                  items(first: 100, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      id
                      content { ... on Issue { number } ... on PullRequest { number } }
                      fieldValueByName(name: $campo) @include(if: $querSprint) {
                        ... on ProjectV2ItemFieldIterationValue { iterationId }
                      }
                    }
                  }
                }
              }
            }
          `,
            // UMA query serve aos dois usos, e quem decide é a diretiva.
            //
            // A versão anterior mandava um ESPAÇO como nome do campo e contava
            // com o GitHub responder `fieldValueByName: null` sem erro. Foi
            // observado ao vivo uma vez, mas é comportamento de servidor: não
            // há teste que o prove, e este arquivo já tem a cicatriz de
            // `criarCampoDeIteracao`, verde contra um fake permissivo enquanto
            // a API real recusava a chamada.
            //
            // `@include(if:)` é built-in da especificação do GraphQL: com
            // `false` o seletor não é executado, `$campo` nunca chega a ser
            // usado como argumento, e nada depende de como o servidor trata um
            // nome inexistente. A variável continua sendo enviada porque a
            // validação de variáveis é estática — acontece antes da diretiva
            // valer — e `String!` não aceita null.
            variables: {
              projectId,
              cursor,
              campo: opcoes?.campoDeSprint ?? '',
              querSprint: (opcoes?.campoDeSprint ?? '').length > 0,
            },
          },
          this.token
        )

      const items = unwrap(response).node?.items
      for (const n of items?.nodes ?? []) {
        if (typeof n?.content?.number !== 'number') continue
        itens.push({
          itemId: n.id,
          pedido: n.content.number,
          iteracaoId: n.fieldValueByName?.iterationId ?? null,
        })
      }

      if (!items?.pageInfo?.hasNextPage) return itens
      cursor = items.pageInfo.endCursor
    }

    // Chegou ao teto com página seguinte pendente. A lista está incompleta e
    // quem chamou PRECISA saber — silêncio aqui recria o defeito que este
    // método acabou de consertar, só que mais tarde e maior.
    opcoes?.onTruncado?.(itens.length)
    return itens
  }

  /**
   * Move um item para depois de outro no quadro — a ORDEM que o cliente vê.
   *
   * É por aqui que o ajuste feito no painel chega ao GitHub: o dono arrasta o
   * pedido no nosso painel, e o quadro dele reflete.
   *
   * `depoisDe` ausente = vai para o TOPO. É como o GitHub expressa "primeiro",
   * e não um caso de erro.
   *
   * IDEMPOTENTE, e isso foi medido, não presumido (30/08, quadro do dono com
   * 118 itens): mandar a MESMA ordem duas vezes deixa 118 itens nas duas
   * vezes. A mutation move, nunca insere — repetir não duplica.
   */
  async moverItemDoQuadro(input: {
    projectId: string
    itemId: string
    /** O item que fica ANTES dele. Ausente = topo. */
    depoisDe?: string
  }): Promise<void> {
    await this.request<{ updateProjectV2ItemPosition: { items: { totalCount: number } } }>(
      {
        query: `
          mutation MoverItemDoQuadro($projectId: ID!, $itemId: ID!, $afterId: ID) {
            updateProjectV2ItemPosition(
              input: { projectId: $projectId, itemId: $itemId, afterId: $afterId }
            ) {
              items(first: 1) { totalCount }
            }
          }
        `,
        variables: {
          projectId: input.projectId,
          itemId: input.itemId,
          // `null` explícito, e não a chave ausente: é assim que o GitHub
          // entende "põe no topo".
          afterId: input.depoisDe ?? null,
        },
      },
      this.token
    )
  }

  /**
   * Cria o campo de iteração (Sprint) no quadro.
   *
   * É o que dá eixo de tempo à visão Roadmap do GitHub: sem campo de iteração
   * ela abre com "Dates: none" e não desenha nada.
   *
   * `iterations` é OBRIGATÓRIO, e isto custou caro para descobrir. A versão
   * anterior mandava só `{ duration, startDate }` e o comentário dizia ter
   * conferido por introspection — mas a chamada real nunca tinha sido feita, e
   * o GitHub recusa com "Argument 'iterations' on InputObject
   * 'ProjectV2IterationFieldConfigurationInput' is required". O teste passava
   * verde porque era contra um fake que aceitava qualquer coisa. Introspection
   * refeita em 30/08 contra a API de produção: os TRÊS campos são NON_NULL —
   * `startDate: Date!`, `duration: Int!` e `iterations: [ProjectV2Iteration!]!`
   * (cada um com `startDate`, `duration` e `title`, todos obrigatórios).
   *
   * Criamos o primeiro ciclo junto: um campo de iteração sem nenhuma iteração
   * é o mesmo estado quebrado do quadro do Jardim (existe, duração 0, e não
   * funciona) — e o painel não teria sprint corrente para mostrar.
   */
  async criarCampoDeIteracao(input: ConfigurarIteracaoInput): Promise<CampoDeIteracaoCriado> {
    const response = await this.request<{
      createProjectV2Field: { projectV2Field: { id: string; name: string } }
    }>(
      {
        query: `
          mutation CriarCampoDeIteracao(
            $projectId: ID!
            $name: String!
            $duration: Int!
            $startDate: Date!
            $iterations: [ProjectV2Iteration!]!
          ) {
            createProjectV2Field(
              input: {
                projectId: $projectId
                dataType: ITERATION
                name: $name
                iterationConfiguration: {
                  duration: $duration
                  startDate: $startDate
                  iterations: $iterations
                }
              }
            ) {
              projectV2Field {
                ... on ProjectV2IterationField { id name }
              }
            }
          }
        `,
        variables: {
          projectId: input.projectId,
          name: input.fieldName,
          duration: input.duracaoEmDias,
          startDate: input.inicio,
          // O primeiro ciclo. O título segue o que o GitHub usa por padrão
          // ("Sprint 1"), para o quadro não nascer com um nome estranho ao
          // que o cliente veria se tivesse criado o campo pela interface.
          iterations: [
            { startDate: input.inicio, duration: input.duracaoEmDias, title: 'Sprint 1' },
          ],
        },
      },
      this.token
    )
    const campo = unwrap(response).createProjectV2Field.projectV2Field
    return { fieldId: campo.id, name: campo.name }
  }

  /**
   * Configura um campo de iteração que JÁ EXISTE mas está vazio.
   *
   * Caso real: o quadro "GitOrch — Jardim das Patinhas" tem o campo Sprint
   * criado, com duração 0 e nenhuma iteração — existe e não funciona. Recriar
   * o campo perderia o vínculo dos itens que já apontam para ele; por isso a
   * operação é de atualização.
   *
   * `iterations` é obrigatório aqui pela MESMA razão que em
   * `criarCampoDeIteracao`: os dois usam
   * `ProjectV2IterationFieldConfigurationInput`, cujos três campos são
   * NON_NULL. Este defeito estava nas duas mutations e passou verde nas duas,
   * porque os testes eram contra um fake.
   */
  async configurarCampoDeIteracao(
    input: ConfigurarIteracaoInput & { fieldId: string }
  ): Promise<string> {
    const response = await this.request<{
      updateProjectV2Field: { projectV2Field: { id: string } }
    }>(
      {
        query: `
          mutation ConfigurarCampoDeIteracao(
            $fieldId: ID!
            $duration: Int!
            $startDate: Date!
            $iterations: [ProjectV2Iteration!]!
          ) {
            updateProjectV2Field(
              input: {
                fieldId: $fieldId
                iterationConfiguration: {
                  duration: $duration
                  startDate: $startDate
                  iterations: $iterations
                }
              }
            ) {
              projectV2Field {
                ... on ProjectV2IterationField { id }
              }
            }
          }
        `,
        variables: {
          fieldId: input.fieldId,
          duration: input.duracaoEmDias,
          startDate: input.inicio,
          iterations: [
            { startDate: input.inicio, duration: input.duracaoEmDias, title: 'Sprint 1' },
          ],
        },
      },
      this.token
    )
    return unwrap(response).updateProjectV2Field.projectV2Field.id
  }

  // Liga uma issue-filha à issue-pai: é o mecanismo NATIVO do GitHub para a
  // hierarquia Épico→Feature→Task (sub-issues). "Blocked by" (dependência) ainda
  // não tem mutation no GraphQL — fica como convenção no corpo ("Blocked by #N").
  async addSubIssue(input: AddSubIssueInput): Promise<string> {
    const response = await this.request<{ addSubIssue: { issue: { id: string } } }>(
      {
        query: `
          mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
            addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
              issue { id }
            }
          }
        `,
        variables: { ...input },
      },
      this.token
    )

    return unwrap(response).addSubIssue.issue.id
  }

  /**
   * Os filhos de uma issue — o outro lado de `addSubIssue`.
   *
   * Existe para que fase, épico e feature possam FECHAR quando o trabalho
   * pendurado neles acaba. Antes disto o produto só sabia pendurar filho e
   * nunca perguntava se eles tinham terminado, então o esqueleto do plano
   * ficava aberto para sempre: medido em 27/08 no gitorch, 45 issues de pura
   * estrutura contra 20 tarefas de verdade.
   *
   * Uma página de cem basta e sobra: uma feature com mais de cem tarefas seria
   * um problema de planejamento muito antes de ser um de paginação. Se um dia
   * for, o `pageInfo` está aqui para quem precisar continuar.
   */
  async listSubIssues(issueNodeId: string): Promise<Array<{ number: number; closed: boolean }>> {
    const response = await this.request<{
      node: { subIssues?: { nodes: Array<{ number: number; closed: boolean }> } } | null
    }>(
      {
        query: `
          query SubIssues($issueId: ID!) {
            node(id: $issueId) {
              ... on Issue {
                subIssues(first: 100) {
                  nodes { number closed }
                }
              }
            }
          }
        `,
        variables: { issueId: issueNodeId },
      },
      this.token
    )
    return unwrap(response).node?.subIssues?.nodes ?? []
  }
}

async function defaultGraphQLTransport<TData>(
  request: GraphQLRequest,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<GraphQLResponse<TData>> {
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify(request),
  })

  return (await response.json()) as GraphQLResponse<TData>
}

function unwrap<TData>(response: GraphQLResponse<TData>): TData {
  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL request failed: ${response.errors.map((error) => error.message).join('; ')}`
    )
  }

  if (!response.data) {
    throw new Error('GitHub GraphQL response did not include data.')
  }

  return response.data
}
