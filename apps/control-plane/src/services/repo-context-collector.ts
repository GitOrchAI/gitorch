import { ProjectV2Client } from '@gitorch/github-sync'
import type { GraphQLRequest, GraphQLResponse, GraphQLTransport } from '@gitorch/github-sync'
import { coletarDividaDeSeguranca, type DividaDeSeguranca } from './security-debt-collector.js'

export interface RepoContextCollectorOptions {
  token: string
  /** Transporte GraphQL injetável (testes). Default: fetch → api.github.com. */
  request?: GraphQLTransport
  fetchImpl?: typeof fetch
}

export interface CollectRepoContextInput {
  /** login do dono do repo (user ou organization). */
  owner: string
  /** nome do repo. */
  repo: string
  ownerType: 'user' | 'organization'
  /** node id do dono — necessário para CRIAR o board se ele não existe. */
  ownerId: string
  /** número do board GitOrch já conhecido; ausente/null → cria um novo. */
  boardNumber?: number
  /** título ao criar o board (default derivado do repo). */
  boardTitle?: string
  /** teto de PRs a coletar (default 20). */
  prLimit?: number
  /** teto de Issues a coletar (default 20). */
  issueLimit?: number
  /** Credencial do cliente — as rotas de segurança recusam a do App do
   *  produto com 403. Ausente/null: o retrato sai sem a dívida, sem falhar. */
  clientToken?: string | null
}

export interface CollectedWorkItem {
  number: number
  title: string
  /** OPEN | CLOSED | MERGED (PR) — OPEN | CLOSED (Issue), como o GitHub devolve. */
  state: string
  url: string
  updatedAt: string
  /** login do autor, ou null (conta apagada / bot sem login). */
  author: string | null
}

export interface CollectedRepoContext {
  board: { id: string; number: number; created: boolean }
  pullRequests: CollectedWorkItem[]
  issues: CollectedWorkItem[]
  /** Ausente quando não havia credencial do cliente para alcançar as rotas
   *  de segurança — não é o mesmo que "verificado, zero encontrado". */
  dividaDeSeguranca?: DividaDeSeguranca
}

const DEFAULT_LIMIT = 20

/**
 * Coleta o contexto de um repo no aceite final do wizard: o board Projects V2
 * (CRIANDO-o se ainda não existe), os PRs e as Issues mais recentes, e — só
 * quando há credencial do cliente — a dívida de segurança (o App do produto
 * é recusado com 403 nessas rotas). Devolve tudo estruturado — quem grava na
 * memória (Cortex) é o passo seguinte (F4.2.3), não este. A única escrita no
 * GitHub é criar o board quando ausente; o resto é leitura pura.
 */
export class RepoContextCollector {
  private readonly token: string
  private readonly request: GraphQLTransport
  private readonly projects: ProjectV2Client
  private readonly fetchImpl: typeof fetch

  constructor(options: RepoContextCollectorOptions) {
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.request = options.request ?? buildGithubGraphQLTransport(this.fetchImpl)
    // O MESMO transporte serve o board e a consulta de PRs/Issues — um fake nos
    // testes cobre os dois caminhos.
    this.projects = new ProjectV2Client({ token: options.token, request: this.request })
  }

  async collect(input: CollectRepoContextInput): Promise<CollectedRepoContext> {
    const board = await this.resolveBoard(input)
    const { pullRequests, issues } = await this.readPullRequestsAndIssues(input)
    // Sem credencial do cliente as rotas de segurança devolvem 403 pra tudo —
    // tentar mesmo assim só produziria "não verificado" disfarçado de dado
    // real. Não é falha: a chave nem entra no objeto devolvido.
    if (!input.clientToken) {
      return { board, pullRequests, issues }
    }
    const dividaDeSeguranca = await coletarDividaDeSeguranca({
      repository: `${input.owner}/${input.repo}`,
      token: input.clientToken,
      fetchImpl: this.fetchImpl,
    })
    return { board, pullRequests, issues, dividaDeSeguranca }
  }

  // Acha o board pelo número conhecido; se não há número, ou ele não existe
  // mais, cria um novo. Usa o resolver que NÃO quebra (findProjectId) para
  // distinguir "não existe" (→ criar) de erro real (→ propaga).
  private async resolveBoard(
    input: CollectRepoContextInput
  ): Promise<{ id: string; number: number; created: boolean }> {
    if (input.boardNumber !== undefined) {
      const existing = await this.projects.findProjectId({
        login: input.owner,
        number: input.boardNumber,
        ownerType: input.ownerType,
      })
      if (existing !== null) {
        return { id: existing, number: input.boardNumber, created: false }
      }
    }
    const created = await this.projects.createProjectV2({
      ownerId: input.ownerId,
      title: input.boardTitle ?? `GitOrch — ${input.repo}`,
    })
    return { id: created.id, number: created.number, created: true }
  }

  // Uma única query traz os PRs e as Issues mais recentes do repo. `repository`
  // null (repo inexistente / sem acesso, mas a query em si passou) → listas
  // vazias, não erro: a coleta de contexto não deve derrubar o aceite final por
  // ausência de conteúdo. `errors[]` (falha real: auth, rate limit) propaga —
  // quem chama (F4.2.3) decide o best-effort, aqui não se mascara falha.
  private async readPullRequestsAndIssues(
    input: CollectRepoContextInput
  ): Promise<{ pullRequests: CollectedWorkItem[]; issues: CollectedWorkItem[] }> {
    const prLimit = input.prLimit ?? DEFAULT_LIMIT
    const issueLimit = input.issueLimit ?? DEFAULT_LIMIT
    const response = await this.request<{
      repository: {
        pullRequests: { nodes: RawWorkItem[] }
        issues: { nodes: RawWorkItem[] }
      } | null
    }>(
      {
        query: `
          query RepoContext($owner: String!, $repo: String!, $prLimit: Int!, $issueLimit: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: $prLimit, orderBy: { field: UPDATED_AT, direction: DESC }) {
                nodes { number title state url updatedAt author { login } }
              }
              issues(first: $issueLimit, orderBy: { field: UPDATED_AT, direction: DESC }) {
                nodes { number title state url updatedAt author { login } }
              }
            }
          }
        `,
        variables: { owner: input.owner, repo: input.repo, prLimit, issueLimit },
      },
      this.token
    )

    if (response.errors && response.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL request failed: ${response.errors.map((e) => e.message).join('; ')}`
      )
    }
    const repository = response.data?.repository ?? null
    if (!repository) {
      return { pullRequests: [], issues: [] }
    }
    return {
      pullRequests: repository.pullRequests.nodes.map(toWorkItem),
      issues: repository.issues.nodes.map(toWorkItem),
    }
  }
}

interface RawWorkItem {
  number: number
  title: string
  state: string
  url: string
  updatedAt: string
  author: { login: string } | null
}

function toWorkItem(raw: RawWorkItem): CollectedWorkItem {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    url: raw.url,
    updatedAt: raw.updatedAt,
    author: raw.author?.login ?? null,
  }
}

// Transporte GraphQL padrão: mesmo endpoint/headers do defaultGraphQLTransport
// do github-sync (que é privado ao pacote) e do helper `gql` de github-backlog.
// Exportado para a ponte de contexto (repo-context-cortex) reusar o MESMO
// transporte na resolução do dono do repo + no collector, sem duplicar o fetch.
export function buildGithubGraphQLTransport(fetchImpl: typeof fetch): GraphQLTransport {
  return async <TData>(request: GraphQLRequest, token: string): Promise<GraphQLResponse<TData>> => {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify(request),
    })
    return (await response.json()) as GraphQLResponse<TData>
  }
}
