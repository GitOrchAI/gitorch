import { ProjectV2Client } from '@gitorch/github-sync'
import { RAILS_SCHEMAS, buildStepPrompt, type PoTriageForm } from '@gitorch/cadence'
import { runPoRails } from './role-rails.js'
import { runFormStep } from './rails-runner.js'
import { applyBacklog } from './backlog-executor.js'
import { createGithubBacklog } from './github-backlog.js'
import { GithubExecutionError } from './github-errors.js'
import { aplicarLabelDoAgente } from './agent-label.js'
import type { BoardColumns } from './board-status.js'
import type { StepExecutor } from './role-rails.js'
import { fetchComTeto } from './fetch-com-teto.js'

// Missão do PO nos TRILHOS (produção): acha a wish aberta, roda o roteiro de 4
// passos (a LLM só preenche formulários) e o executor aplica a árvore
// Wish→Fase→Épico→Feature→Task no board. Retorna um resultado compatível com o
// fluxo do scheduler (output textual vira memória do projeto).

import type { AgentQuestionService } from './agent-question.js'
import { buildFreeTextOption } from './telegram-bot.js'

export interface PoRailsMissionOptions {
  repository: string
  /**
   * ex.: "dono/9" — dono e número do Projects v2 (env na F3.5; banco na F4).
   *
   * VAZIO quando o projeto não tem quadro: o backlog é criado assim mesmo, só
   * sem a vitrine. Repositório de conta pessoal cai neste caso, porque a
   * credencial do produto não consegue criar nem enxergar quadro lá — e ficar
   * sem quadro não pode significar ficar sem plano.
   */
  board?: string
  githubToken: string
  execute: StepExecutor
  /** Contexto do projeto montado pelo sistema (codegraph, memórias). */
  contextBlocks: string[]
  /** Colunas do board deste projeto (config; default nativo do Projects v2). */
  boardColumns?: BoardColumns
  /** Duração da sprint em dias (config por projeto; padrão 7). */
  sprintDays?: number
  fetchImpl?: typeof fetch
  projectId?: string
  userId?: string | null | undefined
  agentQuestionService?: AgentQuestionService | undefined
}

/**
 * Conta as jornadas do RA presentes no contexto. O formato é NOSSO
 * (formatRaDeliverable, "### Journey N:"), então o parse é estável — é o elo
 * que permite ao executor rejeitar plano que ignora uma jornada.
 */
export function countJourneysInContext(contextBlocks: string[]): number {
  const all = contextBlocks.join('\n')
  const matches = all.match(/^### Journey \d+:/gm)
  return matches ? matches.length : 0
}

export interface PoRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
  /** true quando não havia trabalho (não persiste memória nem conta como plano). */
  noOp?: boolean
}

interface WishIssue {
  number: number
  node_id: string
  title: string
  body?: string
}

/** Prioridades válidas de triagem — fonte única para busca e validação. */
const TRIAGE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

/**
 * Triagem de incidentes pelo PO: para cada `gitorch:incident` aberto SEM
 * prioridade, um formulário decide P0..P3 e se fura a fila da sprint. O
 * executor aplica: label de prioridade + comentário com o racional; se
 * liberado, ganha `gitorch:task` e o milestone da sprint aberta mais próxima —
 * a delegação contínua do SM assume dali.
 */
async function triageIncidents(args: {
  gh: (method: string, path: string, body?: unknown) => Promise<unknown>
  repository: string
  execute: StepExecutor
  contextBlocks: string[]
  cap?: number
}): Promise<string[]> {
  const { gh, repository, execute } = args
  const q = encodeURIComponent(`repo:${repository} label:gitorch:incident state:open`)
  const found = (await gh('GET', `/search/issues?q=${q}&per_page=20`)) as {
    items?: Array<{
      number: number
      title: string
      body?: string
      labels?: Array<{ name?: string }>
    }>
  }
  const pending = (found.items ?? []).filter(
    (i) => !(i.labels ?? []).some((l) => TRIAGE_PRIORITIES.includes(l.name as never))
  )
  const summary: string[] = []
  for (const incident of pending.slice(0, args.cap ?? 2)) {
    const prompt = buildStepPrompt('po', 'po-triage', RAILS_SCHEMAS.poTriage, [
      ...args.contextBlocks,
      `Incident under triage: #${incident.number} ${incident.title}\n${(incident.body ?? '').slice(0, 3000)}`,
      'Triage this PRODUCTION incident: P0 = clients impacted right now / main broken; P1 = serious, next sprint; P2 = medium; P3 = low. Set releaseNow=true ONLY when it justifies entering the upcoming sprint ahead of planned work — sprint discipline is the default, jumping the queue is YOUR deliberate call.',
    ])
    const triage = (await runFormStep({
      schema: RAILS_SCHEMAS.poTriage,
      prompt,
      execute,
    })) as PoTriageForm

    await gh('POST', `/repos/${repository}/issues/${incident.number}/labels`, {
      labels: [triage.priority, ...(triage.releaseNow ? ['gitorch:task'] : [])],
    })

    // O PO acabou de assumir esta issue (é quem decide a prioridade) — marca
    // com o label de agente atuante, tirando quem tinha a bola antes (ex.: o
    // RA, que já tinha olhado o incidente). Best-effort: aplicarLabelDoAgente
    // nunca lança.
    await aplicarLabelDoAgente({
      repository,
      issueNumber: incident.number,
      agente: 'po',
      lerLabels: async () =>
        (incident.labels ?? []).map((l) => l.name).filter((name): name is string => Boolean(name)),
      adicionarLabel: async (label) => {
        await gh('POST', `/repos/${repository}/issues/${incident.number}/labels`, {
          labels: [label],
        })
      },
      removerLabel: async (label) => {
        await gh(
          'DELETE',
          `/repos/${repository}/issues/${incident.number}/labels/${encodeURIComponent(label)}`
        )
      },
    })

    await gh('POST', `/repos/${repository}/issues/${incident.number}/comments`, {
      body: `<!-- gitorch:triage -->\nGitOrch PO triage: **${triage.priority}**${triage.releaseNow ? ' — liberado para a próxima sprint' : ' — segue o planejamento da sprint'}.\n\n${triage.rationale}`,
    })
    if (triage.releaseNow) {
      // Milestone da sprint aberta mais próxima (menor N) — se existir.
      const milestones = (await gh(
        'GET',
        `/repos/${repository}/milestones?state=open&per_page=100`
      )) as Array<{ number: number; title: string }>
      const next = (Array.isArray(milestones) ? milestones : [])
        .map((m) => ({ ...m, n: Number(m.title.match(/^Sprint (\d+)$/)?.[1]) }))
        .filter((m) => Number.isFinite(m.n))
        .sort((a, b) => a.n - b.n)[0]
      if (next) {
        await gh('PATCH', `/repos/${repository}/issues/${incident.number}`, {
          milestone: next.number,
        })
      }
    }
    summary.push(
      `triaged #${incident.number}: ${triage.priority}${triage.releaseNow ? ' (released)' : ''}`
    )
  }
  return summary
}

export async function runPoMissionViaRails(
  options: PoRailsMissionOptions
): Promise<PoRailsMissionResult> {
  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do PO)
  // sob `tickEmAndamento` — mesma classe de defeito do Crítico.
  const f = fetchComTeto(options.fetchImpl ?? fetch)

  // 0) Config validada ANTES de gastar qualquer passo de LLM: um board mal
  // configurado falharia só depois dos 4 passos, queimando tokens a cada wake.
  //
  // Board AUSENTE é caso legítimo e segue adiante (o backlog vale sem vitrine);
  // board PREENCHIDO E TORTO continua sendo erro — aí alguém configurou errado,
  // e engolir isso esconderia o engano em vez de mostrá-lo.
  const semQuadro = !options.board
  const [owner, numberRaw] = (options.board ?? '').split('/')
  const boardNumber = Number(numberRaw)
  if (!semQuadro && (!owner || !Number.isFinite(boardNumber))) {
    throw new Error(`Invalid board reference "${options.board}" (expected "<owner>/<number>")`)
  }

  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new GithubExecutionError(
        `GitHub ${method} ${path} failed (${resp.status}): ${detail.slice(0, 150)}`
      )
    }
    return resp.json().catch(() => ({}))
  }

  // 1) TRIAGEM antes de planejar: incidentes do sensor sem prioridade recebem
  // P0..P3 do PO (e, se ele decidir, entram na próxima sprint). Best-effort:
  // falha na triagem não pode matar o planejamento da wish.
  let triageSummary: string[] = []
  try {
    triageSummary = await triageIncidents({
      gh,
      repository: options.repository,
      execute: options.execute,
      contextBlocks: options.contextBlocks,
    })
  } catch (err) {
    triageSummary = [`triage failed: ${String(err).slice(0, 120)}`]
  }

  // 2) A wish mais recente ABERTA com label wishlist (o gatilho do PO).
  const wishResp = await f(
    `https://api.github.com/repos/${options.repository}/issues?labels=wishlist&state=open&sort=created&direction=desc&per_page=1`,
    { headers: { authorization: `token ${options.githubToken}`, 'user-agent': 'gitorch' } }
  )
  if (!wishResp.ok) {
    // 401/403/404 NÃO é "sem wishlist": é erro real (token/permissão) e deve
    // falhar a missão com causa visível, nunca virar sucesso silencioso.
    throw new Error(`GitHub wishlist lookup failed (${wishResp.status})`)
  }
  const wishes = (await wishResp.json()) as WishIssue[]
  const wish = Array.isArray(wishes) ? wishes[0] : undefined
  if (!wish) {
    if (options.agentQuestionService && options.projectId && options.userId) {
      try {
        await options.agentQuestionService.ask(options.userId, options.projectId, {
          dedupKey: `po-onboarding-wishlist-${options.repository}`,
          text: `Olá! Sou o PO do seu projeto ${options.repository}. Mapeamento inicial concluído, mas ainda não temos uma Wishlist definida. Qual é o seu objetivo principal de negócio para este repositório?`,
          context: `Análise técnica do RA concluída. Aguardando alinhamento do stakeholder para geração do roadmap.`,
          options: [
            { label: '🚀 Lançar MVP / Funcionalidades principais', value: 'wishlist-mvp-features' },
            {
              label: '🛠️ Focar em Saúde Técnica, CI/CD e Testes',
              value: 'wishlist-technical-health',
            },
            { label: '🎨 Refatorar Interface / UX / Design System', value: 'wishlist-ui-design' },
            // Feedback do dono: nem sempre uma das 3 fechadas serve — "a 4ª
            // resposta tem que ser manual". Esta opção não é gravada como
            // resposta; instrui a responder em texto livre (ver
            // handleTelegramQuestionReply em services/telegram-bot.ts).
            buildFreeTextOption(),
          ],
        })
      } catch (err) {
        // Best-effort
      }
    }
    return {
      exitCode: 0,
      output:
        triageSummary.length > 0
          ? `PO: no open wishlist issue. Incident triage: ${triageSummary.join('; ')}.`
          : 'PO: no open wishlist issue; registered AgentQuestion for stakeholder via Telegram/Panel.',
      stderr: '',
      noOp: triageSummary.length === 0,
    }
  }

  // 2) Roteiro do PO (5 formulários; a LLM nunca toca no GitHub).
  const plan = await runPoRails(options.execute, {
    wish: { number: wish.number, nodeId: wish.node_id },
    wishText: `${wish.title} — ${wish.body ?? ''}`,
    contextBlocks: options.contextBlocks,
    journeysCount: countJourneysInContext(options.contextBlocks),
  })

  // 3) Executor determinístico aplica no GitHub. `fetchImpl: f` (não
  // `options.fetchImpl` cru) — leva D: `ProjectV2Client` não tem teto
  // próprio, então quem for embrulhado aqui precisa já vir com um.
  const client = new ProjectV2Client({
    token: options.githubToken,
    fetchImpl: f,
  })
  // Board de usuário primeiro (piloto); org é o destino do produto (F4).
  const projectId = semQuadro
    ? undefined
    : await client
        .getProjectId({ login: owner as string, number: boardNumber, ownerType: 'user' })
        .catch(() =>
          client.getProjectId({
            login: owner as string,
            number: boardNumber,
            ownerType: 'organization',
          })
        )

  const github = createGithubBacklog({
    token: options.githubToken,
    repository: options.repository,
    ...(projectId ? { projectId } : {}),
    ...(options.boardColumns ? { statusColumns: options.boardColumns } : {}),
    ...(options.sprintDays ? { sprintDays: options.sprintDays } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  // A delegação NÃO nasce aqui. Decisão do dono (14/08/2026): só o SM delega.
  // O PO monta o plano e para. Quando o PO também delegava, havia dois donos
  // para a mesma decisão — e nenhum dos dois olhava o teto do plano do dev
  // assíncrono. Ver `fila-de-delegacao.ts`.
  const result = await applyBacklog({ github, plan })

  // 4) Resumo textual: vira memória do projeto (e evidência humana).
  const lines = [
    ...(triageSummary.length > 0 ? [`Incident triage: ${triageSummary.join('; ')}.`] : []),
    `PO rails applied wish #${wish.number} ("${wish.title}").`,
    `Sprint goal: ${plan.roadmap.sprintGoal}`,
    `Tree: ${plan.phases.length} phase(s), ${plan.epics.length} epic(s), ${plan.features.length} feature(s), ${plan.tasks.length} task(s).`,
    `Roadmap: ${result.sprintsPlanned} sprint(s); journeys covered: ${plan.journeysCount}.`,
    `Executor: created=${result.createdCount} reused=${result.skippedCount}.`,
    ...result.issues.map(({ marker, ref }) => `${marker} -> #${ref.number}`),
  ]
  return { exitCode: 0, output: lines.join('\n'), stderr: '' }
}
