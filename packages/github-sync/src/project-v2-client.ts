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

export class ProjectV2Client {
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
  async listarQuadrosDoRepositorio(
    input: ListarQuadrosDoRepositorioInput
  ): Promise<QuadroListado[]> {
    const response = await this.request<{
      repository: { projectsV2: { nodes: QuadroListado[] | null } | null } | null
    }>(
      {
        query: `
          query ListarQuadrosDoRepositorio($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
              projectsV2(first: 50) { nodes { id number title closed } }
            }
          }
        `,
        variables: { owner: input.owner, repo: input.repo },
      },
      this.token
    )

    return unwrap(response).repository?.projectsV2?.nodes ?? []
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
                    ... on ProjectV2IterationField {
                      id
                      name
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
   * Os itens do quadro, com o número do pedido que cada um representa.
   *
   * Existe porque o painel fala em "pedido #36" — o número que o dono
   * reconhece — e o GitHub move itens por um id interno que ele nunca viu.
   * A tradução acontece aqui, e não na tela: expor id de quadro no painel
   * seria vazar encanamento para quem só quer arrastar um card.
   */
  async listarItensDoQuadro(projectId: string): Promise<Array<{ itemId: string; pedido: number }>> {
    const response = await this.request<{
      node: {
        items: {
          nodes: Array<{ id: string; content?: { number?: number } | null }>
        }
      }
    }>(
      {
        query: `
          query ItensDoQuadro($projectId: ID!) {
            node(id: $projectId) {
              ... on ProjectV2 {
                items(first: 100) {
                  nodes {
                    id
                    content { ... on Issue { number } ... on PullRequest { number } }
                  }
                }
              }
            }
          }
        `,
        variables: { projectId },
      },
      this.token
    )

    return (unwrap(response).node?.items?.nodes ?? [])
      .filter(
        (n): n is { id: string; content: { number: number } } =>
          typeof n?.content?.number === 'number'
      )
      .map((n) => ({ itemId: n.id, pedido: n.content.number }))
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
   * ela abre com "Dates: none" e não desenha nada. Houve época em que a
   * comunidade dizia que criar iteração por API era impossível; hoje o enum
   * `ProjectV2CustomFieldType` inclui ITERATION e `CreateProjectV2FieldInput`
   * aceita `iterationConfiguration` — conferido por introspection em 29/08
   * antes de escrever isto.
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
          ) {
            createProjectV2Field(
              input: {
                projectId: $projectId
                dataType: ITERATION
                name: $name
                iterationConfiguration: { duration: $duration, startDate: $startDate }
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
          ) {
            updateProjectV2Field(
              input: {
                fieldId: $fieldId
                iterationConfiguration: { duration: $duration, startDate: $startDate }
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
