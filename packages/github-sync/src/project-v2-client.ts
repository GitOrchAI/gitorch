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

export class ProjectV2Client {
  private readonly token: string
  private readonly request: GraphQLTransport

  constructor(options: ProjectV2ClientOptions) {
    if (options.token.length === 0) {
      throw new Error('GitHub token must not be empty.')
    }

    this.token = options.token
    this.request = options.request ?? defaultGraphQLTransport
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
}

async function defaultGraphQLTransport<TData>(
  request: GraphQLRequest,
  token: string
): Promise<GraphQLResponse<TData>> {
  const response = await fetch('https://api.github.com/graphql', {
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
