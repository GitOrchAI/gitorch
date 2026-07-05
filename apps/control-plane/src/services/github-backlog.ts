import { ProjectV2Client } from '@gitorch/github-sync'
import type { BacklogGitHub, IssueRef } from './backlog-executor.js'
import { GithubExecutionError } from './github-errors.js'
import { createBoardStatus, type BoardColumns } from './board-status.js'

// Adapter GitHub REAL do backlog-executor: implementa a superfície BacklogGitHub
// com REST (issues/labels/busca) + ProjectV2Client (árvore, board, sprint).
// É a ÚNICA fronteira do plano do PO com o GitHub — toda ação auditável aqui.

export { GithubExecutionError } from './github-errors.js'

export interface GithubBacklogOptions {
  token: string
  /** ex.: "loureng/patinhas-3d-crafts" */
  repository: string
  /** node id do Project v2 (board) */
  projectId: string
  /** nome do campo de iteração no board (padrão "Sprint") */
  sprintFieldName?: string
  /** nome do campo de status no board (padrão "Status") */
  statusFieldName?: string
  /** mapeamento de colunas do projeto (config por projeto; default nativo). */
  statusColumns?: BoardColumns
  /** duração de cada sprint em dias (config por projeto; padrão 7). */
  sprintDays?: number
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

  const boardStatus = createBoardStatus({
    token: options.token,
    projectId: options.projectId,
    ...(options.statusFieldName ? { statusFieldName: options.statusFieldName } : {}),
    ...(options.statusColumns ? { columns: options.statusColumns } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  // Cache do campo de iteração (resolvido uma vez por execução do plano).
  let sprintCache: { fieldId: string; iterations: Array<{ id: string }> } | null | undefined

  const resolveSprint = async (): Promise<{
    fieldId: string
    iterations: Array<{ id: string }>
  } | null> => {
    if (sprintCache !== undefined) return sprintCache
    try {
      const field = await client.getIterationField({
        projectId: options.projectId,
        fieldName: sprintField,
      })
      sprintCache =
        field.iterations.length > 0
          ? { fieldId: field.fieldId, iterations: field.iterations }
          : null
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

  // Milestones "Sprint N" com data de entrega: o ROADMAP visível ao cliente.
  // Cache por número; criação idempotente por título.
  const sprintDays = options.sprintDays ?? 7
  const milestoneCache = new Map<number, number | null>()
  const ensureMilestone = async (sprintNumber: number): Promise<number | null> => {
    const cached = milestoneCache.get(sprintNumber)
    if (cached !== undefined) return cached
    const title = `Sprint ${sprintNumber}`
    const existing = (await rest(
      'GET',
      `/repos/${options.repository}/milestones?state=all&per_page=100`
    )) as Array<{ number: number; title: string }>
    const found = Array.isArray(existing) ? existing.find((m) => m.title === title) : undefined
    if (found) {
      milestoneCache.set(sprintNumber, found.number)
      return found.number
    }
    const dueOn = new Date(Date.now() + sprintNumber * sprintDays * 24 * 60 * 60 * 1000)
    const created = (await rest('POST', `/repos/${options.repository}/milestones`, {
      title,
      due_on: dueOn.toISOString(),
      description: `GitOrch roadmap: sprint ${sprintNumber} (${sprintDays}-day sprints)`,
    })) as { number?: number }
    const number = created.number ?? null
    milestoneCache.set(sprintNumber, number)
    return number
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

    async setSprint(boardItemId, sprintNumber): Promise<void> {
      const sprint = await resolveSprint()
      if (!sprint) return
      // Sprint N → N-ésima iteração configurada no board; além do horizonte
      // de iterações existentes, fica sem iteração (o milestone datado cobre).
      const iteration = sprint.iterations[sprintNumber - 1]
      if (!iteration) return
      await client.setIterationField({
        projectId: options.projectId,
        itemId: boardItemId,
        fieldId: sprint.fieldId,
        iterationId: iteration.id,
      })
    },

    async setMilestone(issueNumber, sprintNumber): Promise<void> {
      const milestone = await ensureMilestone(sprintNumber)
      if (milestone === null) return
      await rest('PATCH', `/repos/${options.repository}/issues/${issueNumber}`, {
        milestone,
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

    async setStatus(boardItemId, column): Promise<void> {
      // Coluna/campo ausente no board do cliente não é falha do plano — o
      // status é acessório; a árvore/labels são o essencial.
      const outcome = await boardStatus.setStatus(boardItemId, column)
      if (outcome !== 'set') {
        // eslint-disable-next-line no-console
        console.warn(`[backlog] status não aplicado (${outcome}) para item ${boardItemId}`)
      }
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
