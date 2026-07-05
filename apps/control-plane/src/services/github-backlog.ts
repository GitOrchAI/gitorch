import { ProjectV2Client } from '@gitorch/github-sync'
import type { BacklogGitHub, IssueRef } from './backlog-executor.js'

// Adapter GitHub REAL do backlog-executor: implementa a superfície BacklogGitHub
// com REST (issues/labels/busca) + ProjectV2Client (árvore, board, sprint).
// É a ÚNICA fronteira do plano do PO com o GitHub — toda ação auditável aqui.

/** Erro de execução no GitHub: NÃO é falha de motor — nunca aciona failover. */
export class GithubExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubExecutionError'
  }
}

export interface GithubBacklogOptions {
  token: string
  /** ex.: "loureng/patinhas-3d-crafts" */
  repository: string
  /** node id do Project v2 (board) */
  projectId: string
  /** nome do campo de iteração no board (padrão "Sprint") */
  sprintFieldName?: string
  fetchImpl?: typeof fetch
}

export function createGithubBacklog(options: GithubBacklogOptions): BacklogGitHub {
  const f = options.fetchImpl ?? fetch
  const client = new ProjectV2Client({
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const sprintField = options.sprintFieldName ?? 'Sprint'

  const rest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      throw new GithubExecutionError(
        `GitHub REST ${method} ${path} failed (${response.status}): ${JSON.stringify(json).slice(0, 200)}`
      )
    }
    return json
  }

  // Helper GraphQL ÚNICO do adapter (o client cobre as mutations tipadas; este
  // cobre consultas ad-hoc). Sempre valida errors[] — nada de undefined mudo.
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

  // Idempotência com UMA busca por wish (a Search API tem limite de ~30 req/min;
  // uma chamada por nó estouraria em planos grandes): busca todos os corpos com
  // o prefixo do marker da wish e monta o mapa marker→issue em memória.
  const markerMaps = new Map<string, Map<string, IssueRef>>()
  const markerPrefix = (marker: string): string => {
    // "gitorch:node:<wish>:tipo:i" → "gitorch:node:<wish>"
    return marker.split(':').slice(0, 3).join(':')
  }
  const loadMarkers = async (prefix: string): Promise<Map<string, IssueRef>> => {
    const cached = markerMaps.get(prefix)
    if (cached) return cached
    const map = new Map<string, IssueRef>()
    const q = encodeURIComponent(`repo:${options.repository} in:body "${prefix}" state:open`)
    const result = (await rest('GET', `/search/issues?q=${q}&per_page=100`)) as {
      items?: Array<{ number: number; node_id: string; body?: string }>
    }
    for (const item of result.items ?? []) {
      const found = item.body?.match(/<!--\s*(gitorch:node:[^\s>]+)\s*-->/)
      if (found?.[1]) map.set(found[1], { number: item.number, nodeId: item.node_id })
    }
    markerMaps.set(prefix, map)
    return map
  }

  // Cache da iteração ativa (resolvida uma vez por execução do plano).
  let sprintCache: { fieldId: string; iterationId: string } | null | undefined

  const resolveSprint = async (): Promise<{ fieldId: string; iterationId: string } | null> => {
    if (sprintCache !== undefined) return sprintCache
    try {
      const field = await client.getIterationField({
        projectId: options.projectId,
        fieldName: sprintField,
      })
      const first = field.iterations[0]
      sprintCache = first ? { fieldId: field.fieldId, iterationId: first.id } : null
    } catch (error) {
      // Só a AUSÊNCIA do campo Sprint é tolerada (board sem iteração configurada).
      // Qualquer outra falha (FORBIDDEN, rede) é real e deve subir — engolir aqui
      // perderia o Sprint Planning inteiro em silêncio.
      if (!String(error).includes('not found')) {
        throw error instanceof GithubExecutionError
          ? error
          : new GithubExecutionError(`resolveSprint failed: ${String(error).slice(0, 200)}`)
      }
      sprintCache = null
    }
    return sprintCache
  }

  return {
    async findIssueByMarker(marker: string): Promise<IssueRef | null> {
      const map = await loadMarkers(markerPrefix(marker))
      return map.get(marker) ?? null
    },

    async createIssue(input): Promise<IssueRef> {
      const issue = (await rest('POST', `/repos/${options.repository}/issues`, {
        title: input.title,
        body: input.body,
        ...(input.labels ? { labels: input.labels } : {}),
      })) as { number: number; node_id: string }
      return { number: issue.number, nodeId: issue.node_id }
    },

    async addSubIssue(parentNodeId, childNodeId): Promise<void> {
      await client.addSubIssue({ issueId: parentNodeId, subIssueId: childNodeId })
    },

    async addToBoard(nodeId): Promise<string> {
      try {
        return await client.addItemById({ projectId: options.projectId, contentId: nodeId })
      } catch (error) {
        // Idempotência: "Content already exists in this project" não é falha —
        // resolve o id do item existente (ex.: workflow de auto-add do board).
        if (!String(error).includes('already exists')) throw error
        const data = await gql<{
          node?: { projectItems?: { nodes?: Array<{ id: string; project?: { id?: string } }> } }
        }>(
          `query($id: ID!) { node(id: $id) { ... on Issue {
            projectItems(first: 20) { nodes { id project { id } } } } } }`,
          { id: nodeId }
        )
        const item = data.node?.projectItems?.nodes?.find(
          (n) => n.project?.id === options.projectId
        )
        if (!item) throw error
        return item.id
      }
    },

    async setSprint(boardItemId): Promise<void> {
      const sprint = await resolveSprint()
      if (!sprint) return
      await client.setIterationField({
        projectId: options.projectId,
        itemId: boardItemId,
        fieldId: sprint.fieldId,
        iterationId: sprint.iterationId,
      })
    },

    async postSprintGoal(goal: string): Promise<void> {
      // O Sprint Goal fica VISÍVEL no board (status update do Projects v2) — o
      // board é a interface do cliente; memória interna não basta.
      await client.createStatusUpdate({
        projectId: options.projectId,
        body: `Sprint Goal: ${goal}`,
        startDate: new Date().toISOString().slice(0, 10),
        status: 'ON_TRACK',
      })
    },

    async addLabels(nodeId, labels): Promise<void> {
      const data = await gql<{
        node?: { number?: number; repository?: { nameWithOwner?: string } }
      }>(
        `query($id: ID!) { node(id: $id) { ... on Issue { number repository { nameWithOwner } } } }`,
        { id: nodeId }
      )
      const number = data.node?.number
      const repo = data.node?.repository?.nameWithOwner ?? options.repository
      if (!number) {
        throw new GithubExecutionError(`addLabels: could not resolve issue number for ${nodeId}`)
      }
      await rest('POST', `/repos/${repo}/issues/${number}/labels`, { labels })
    },
  }
}
