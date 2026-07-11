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
      throw new Error(
        `Iteration field "${input.fieldName}" not found on project ${input.projectId}.`
      )
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
