import { ProjectV2Client } from '@gitorch/github-sync'
import { GithubExecutionError } from './github-errors.js'

// Status do card no board (Projects v2) — o board é a interface do cliente.
// As COLUNAS são configuração POR PROJETO (runtimeConfig.board.columns), nunca
// hardcoded no fluxo: o cliente personaliza o board dele (no futuro pelo
// frontend) e o backend acompanha pelo NOME da coluna. Coluna/campo ausente no
// board é tolerado com resultado explícito — mover card nunca derruba missão.

export interface BoardColumns {
  todo: string
  inProgress: string
  review: string
  done: string
  blocked: string
}

export type BoardColumnKey = keyof BoardColumns

/** Default alinhado às opções nativas do Projects v2 (Todo/In Progress/Done). */
export const DEFAULT_BOARD_COLUMNS: BoardColumns = {
  todo: 'Todo',
  inProgress: 'In Progress',
  review: 'In Review',
  done: 'Done',
  blocked: 'Blocked',
}

/** Lê o mapeamento de colunas do runtimeConfig do projeto, com defaults. */
export function resolveBoardColumns(runtimeConfig: unknown): BoardColumns {
  const board = (runtimeConfig as { board?: { columns?: Partial<BoardColumns> } } | null)?.board
  return { ...DEFAULT_BOARD_COLUMNS, ...(board?.columns ?? {}) }
}

export type SetStatusOutcome = 'set' | 'field-missing' | 'column-missing'

export interface BoardStatusOptions {
  token: string
  projectId: string
  /** Nome do campo single-select de status (padrão "Status"). */
  statusFieldName?: string
  columns?: BoardColumns
  fetchImpl?: typeof fetch
}

interface StatusField {
  fieldId: string
  options: Array<{ id: string; name: string }>
}

export interface BoardStatusClient {
  setStatus(itemId: string, column: BoardColumnKey): Promise<SetStatusOutcome>
  columns: BoardColumns
}

export function createBoardStatus(options: BoardStatusOptions): BoardStatusClient {
  const f = options.fetchImpl ?? fetch
  const fieldName = options.statusFieldName ?? 'Status'
  const columns = options.columns ?? DEFAULT_BOARD_COLUMNS
  const client = new ProjectV2Client({
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const resp = await f('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify({ query, variables }),
    })
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      throw new GithubExecutionError(`GitHub GraphQL failed: ${json.errors[0]?.message}`)
    }
    if (!json.data) throw new GithubExecutionError('GitHub GraphQL returned no data')
    return json.data
  }

  // O campo é resolvido UMA vez por execução (cache), pelo NOME configurado.
  let fieldCache: StatusField | null | undefined
  const resolveField = async (): Promise<StatusField | null> => {
    if (fieldCache !== undefined) return fieldCache
    const data = await gql<{
      node?: {
        fields?: {
          nodes?: Array<{
            id?: string
            name?: string
            options?: Array<{ id: string; name: string }>
          }>
        }
      }
    }>(
      `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
        fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`,
      { id: options.projectId }
    )
    const field = data.node?.fields?.nodes?.find((n) => n.name === fieldName && n.id && n.options)
    fieldCache = field ? { fieldId: field.id!, options: field.options! } : null
    return fieldCache
  }

  return {
    columns,
    async setStatus(itemId: string, column: BoardColumnKey): Promise<SetStatusOutcome> {
      const field = await resolveField()
      if (!field) return 'field-missing'
      const option = field.options.find((o) => o.name === columns[column])
      if (!option) return 'column-missing'
      await client.updateSingleSelectField({
        projectId: options.projectId,
        itemId,
        fieldId: field.fieldId,
        optionId: option.id,
      })
      return 'set'
    },
  }
}

export interface CardMoverOptions {
  repository: string
  /** "owner/number" do Projects v2 (mesmo formato do GITORCH_PROJECT_BOARD). */
  board: string
  token: string
  statusFieldName?: string
  columns?: BoardColumns
  fetchImpl?: typeof fetch
}

export type CardMover = (issueNumber: number, column: BoardColumnKey) => Promise<string>

/**
 * Movedor de card por NÚMERO de issue (para QA/SM, que não têm o item do
 * board em mãos): resolve issue→nodeId→item do board→status. Todas as etapas
 * toleram board sem o campo/coluna com resultado textual honesto.
 */
export function createCardMover(options: CardMoverOptions): CardMover {
  const f = options.fetchImpl ?? fetch
  const client = new ProjectV2Client({
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  let projectIdPromise: Promise<string> | undefined
  const resolveProjectId = (): Promise<string> => {
    if (!projectIdPromise) {
      const [owner, numberRaw] = options.board.split('/')
      const boardNumber = Number(numberRaw)
      if (!owner || !Number.isFinite(boardNumber)) {
        throw new GithubExecutionError(`Invalid board reference "${options.board}"`)
      }
      projectIdPromise = client
        .getProjectId({ login: owner, number: boardNumber, ownerType: 'user' })
        .catch(() =>
          client.getProjectId({ login: owner, number: boardNumber, ownerType: 'organization' })
        )
    }
    return projectIdPromise
  }

  let statusPromise: Promise<BoardStatusClient> | undefined
  const resolveStatus = (): Promise<BoardStatusClient> => {
    if (!statusPromise) {
      statusPromise = resolveProjectId().then((projectId) =>
        createBoardStatus({
          token: options.token,
          projectId,
          ...(options.statusFieldName ? { statusFieldName: options.statusFieldName } : {}),
          ...(options.columns ? { columns: options.columns } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
      )
    }
    return statusPromise
  }

  return async (issueNumber: number, column: BoardColumnKey): Promise<string> => {
    const issueResp = await f(
      `https://api.github.com/repos/${options.repository}/issues/${issueNumber}`,
      {
        headers: {
          authorization: `token ${options.token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
        },
      }
    )
    if (!issueResp.ok) {
      throw new GithubExecutionError(`card-mover: issue #${issueNumber} lookup failed`)
    }
    const issue = (await issueResp.json()) as { node_id?: string }
    if (!issue.node_id) {
      throw new GithubExecutionError(`card-mover: issue #${issueNumber} has no node id`)
    }

    const projectId = await resolveProjectId()
    // Garante o item no board (idempotente: já existir não é falha).
    let itemId: string
    try {
      itemId = await client.addItemById({ projectId, contentId: issue.node_id })
    } catch (error) {
      if (!String(error).includes('already exists')) throw error
      const data = await (async () => {
        const resp = await f('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
            'user-agent': 'gitorch',
          },
          body: JSON.stringify({
            query: `query($id: ID!) { node(id: $id) { ... on Issue {
              projectItems(first: 20) { nodes { id project { id } } } } } }`,
            variables: { id: issue.node_id },
          }),
        })
        return (await resp.json()) as {
          data?: {
            node?: { projectItems?: { nodes?: Array<{ id: string; project?: { id?: string } }> } }
          }
        }
      })()
      const item = data.data?.node?.projectItems?.nodes?.find((n) => n.project?.id === projectId)
      if (!item) throw error
      itemId = item.id
    }

    const status = await resolveStatus()
    const outcome = await status.setStatus(itemId, column)
    return `card #${issueNumber} -> ${status.columns[column]} (${outcome})`
  }
}
