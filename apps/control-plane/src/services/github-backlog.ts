import { ProjectV2Client } from '@gitorch/github-sync'
import type { BacklogGitHub, IssueRef } from './backlog-executor.js'

// Adapter GitHub REAL do backlog-executor: implementa a superfície BacklogGitHub
// com REST (issues/labels/busca) + ProjectV2Client (árvore, board, sprint).
// É a ÚNICA fronteira do plano do PO com o GitHub — toda ação auditável aqui.

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
  const client = new ProjectV2Client({ token: options.token })
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
      throw new Error(
        `GitHub REST ${method} ${path} failed (${response.status}): ${JSON.stringify(json).slice(0, 200)}`
      )
    }
    return json
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
    } catch {
      // Campo Sprint ausente no board: o plano segue sem iteração (não é fatal).
      sprintCache = null
    }
    return sprintCache
  }

  return {
    async findIssueByMarker(marker: string): Promise<IssueRef | null> {
      // Só issues ABERTAS contam para idempotência: um nó fechado (plano
      // abandonado/limpo) não deve ser reusado numa nova aplicação do plano.
      const q = encodeURIComponent(`repo:${options.repository} in:body "${marker}" state:open`)
      const result = (await rest('GET', `/search/issues?q=${q}&per_page=1`)) as {
        items?: Array<{ number: number; node_id: string }>
      }
      const hit = result.items?.[0]
      return hit ? { number: hit.number, nodeId: hit.node_id } : null
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
        // Idempotência: o GitHub responde "Content already exists in this
        // project" quando a issue já está no board (ex.: workflow de auto-add
        // ou re-execução). Resolve o id do item existente em vez de falhar.
        if (!String(error).includes('already exists')) throw error
        const query = `query($id: ID!) { node(id: $id) { ... on Issue {
          projectItems(first: 20) { nodes { id project { id } } } } } }`
        const resp = await f('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            authorization: `token ${options.token}`,
            'content-type': 'application/json',
            'user-agent': 'gitorch',
          },
          body: JSON.stringify({ query, variables: { id: nodeId } }),
        })
        const data = (await resp.json()) as {
          data?: {
            node?: { projectItems?: { nodes?: Array<{ id: string; project?: { id?: string } }> } }
          }
        }
        const item = data.data?.node?.projectItems?.nodes?.find(
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

    async addLabels(nodeId, labels): Promise<void> {
      // A API de labels é por número; resolve via GraphQL node -> number/repo.
      const query = `query($id: ID!) { node(id: $id) { ... on Issue { number repository { nameWithOwner } } } }`
      const resp = await f('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `token ${options.token}`,
          'content-type': 'application/json',
          'user-agent': 'gitorch',
        },
        body: JSON.stringify({ query, variables: { id: nodeId } }),
      })
      const data = (await resp.json()) as {
        data?: { node?: { number?: number; repository?: { nameWithOwner?: string } } }
      }
      const number = data.data?.node?.number
      const repo = data.data?.node?.repository?.nameWithOwner ?? options.repository
      if (!number) throw new Error(`addLabels: could not resolve issue number for ${nodeId}`)
      await rest('POST', `/repos/${repo}/issues/${number}/labels`, { labels })
    },
  }
}
