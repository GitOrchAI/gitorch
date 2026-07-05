import { ProjectV2Client } from '@gitorch/github-sync'
import { runPoRails } from './role-rails.js'
import { applyBacklog } from './backlog-executor.js'
import { createGithubBacklog } from './github-backlog.js'
import type { StepExecutor } from './role-rails.js'

// Missão do PO nos TRILHOS (produção): acha a wish aberta, roda o roteiro de 4
// passos (a LLM só preenche formulários) e o executor aplica a árvore
// Wish→Fase→Épico→Feature→Task no board. Retorna um resultado compatível com o
// fluxo do scheduler (output textual vira memória do projeto).

export interface PoRailsMissionOptions {
  repository: string
  /** ex.: "loureng/9" — dono e número do Projects v2 (env na F3.5; banco na F4). */
  board: string
  githubToken: string
  execute: StepExecutor
  /** Contexto do projeto montado pelo sistema (codegraph, memórias). */
  contextBlocks: string[]
  /** Label de delegação (padrão 'jules'). */
  delegateLabel?: string
  fetchImpl?: typeof fetch
}

export interface PoRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
}

interface WishIssue {
  number: number
  node_id: string
  title: string
  body?: string
}

export async function runPoMissionViaRails(
  options: PoRailsMissionOptions
): Promise<PoRailsMissionResult> {
  const f = options.fetchImpl ?? fetch

  // 1) A wish mais recente ABERTA com label wishlist (o gatilho do PO).
  const wishResp = await f(
    `https://api.github.com/repos/${options.repository}/issues?labels=wishlist&state=open&sort=created&direction=desc&per_page=1`,
    { headers: { authorization: `token ${options.githubToken}`, 'user-agent': 'gitorch' } }
  )
  const wishes = (await wishResp.json()) as WishIssue[]
  const wish = Array.isArray(wishes) ? wishes[0] : undefined
  if (!wish) {
    return { exitCode: 0, output: 'PO: no open wishlist issue; nothing to plan.', stderr: '' }
  }

  // 2) Roteiro do PO (4 formulários; a LLM nunca toca no GitHub).
  const plan = await runPoRails(options.execute, {
    wish: { number: wish.number, nodeId: wish.node_id },
    wishText: `${wish.title} — ${wish.body ?? ''}`,
    contextBlocks: options.contextBlocks,
  })

  // 3) Executor determinístico aplica no GitHub.
  const [owner, numberRaw] = options.board.split('/')
  const boardNumber = Number(numberRaw)
  if (!owner || !Number.isFinite(boardNumber)) {
    throw new Error(`Invalid board reference "${options.board}" (expected "<owner>/<number>")`)
  }
  // Com fetchImpl (testes), o client GraphQL usa o mesmo transporte injetado.
  const transport = options.fetchImpl
    ? async <TData>(
        request: { query: string; variables: Record<string, unknown> },
        token: string
      ) => {
        const resp = await f('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': 'gitorch',
          },
          body: JSON.stringify(request),
        })
        return (await resp.json()) as { data?: TData; errors?: Array<{ message: string }> }
      }
    : undefined
  const client = new ProjectV2Client({
    token: options.githubToken,
    ...(transport ? { request: transport } : {}),
  })
  // Board de usuário primeiro (piloto); org é o destino do produto (F4).
  const projectId = await client
    .getProjectId({ login: owner, number: boardNumber, ownerType: 'user' })
    .catch(() =>
      client.getProjectId({ login: owner, number: boardNumber, ownerType: 'organization' })
    )

  const github = createGithubBacklog({
    token: options.githubToken,
    repository: options.repository,
    projectId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const result = await applyBacklog({
    github,
    plan,
    delegateLabel: options.delegateLabel ?? 'jules',
  })

  // 4) Resumo textual: vira memória do projeto (e evidência humana).
  const lines = [
    `PO rails applied wish #${wish.number} ("${wish.title}").`,
    `Sprint goal: ${plan.sprint?.sprintGoal ?? '(none)'}`,
    `Tree: ${plan.phases.length} phase(s), ${plan.epics.length} epic(s), ${plan.items.length} item(s).`,
    `Executor: created=${result.createdCount} reused=${result.skippedCount}.`,
    ...result.issues.map(({ marker, ref }) => `${marker} -> #${ref.number}`),
  ]
  return { exitCode: 0, output: lines.join('\n'), stderr: '' }
}
