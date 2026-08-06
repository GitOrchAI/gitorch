import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  ISSUE_DOD_FIELDS,
  formatQaReconDeliverable,
  type QaVerdictForm,
  type QaReconForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import { GithubExecutionError } from './github-errors.js'
import { aplicarLabelDoAgente } from './agent-label.js'
import type { CardMover } from './board-status.js'

// Missão do QA nos TRILHOS (F3.6): acha a PR do Jules que precisa de julgamento,
// monta o snapshot (diff + Verification Criteria da issue + estado do CI), o
// motor preenche UM formulário de veredito, e o SISTEMA posta a review e — se
// for rework — o comentário mencionando @jules. A LLM nunca toca no GitHub.

const JULES_MARKER = '<!-- gitorch:qa -->'

export interface QaRailsMissionOptions {
  repository: string
  githubToken: string
  execute: (prompt: string) => Promise<string>
  contextBlocks?: string[]
  /** Move o card da issue vinculada no board conforme o veredito (opcional). */
  moveCard?: CardMover
  /** Label de delegação que marca trabalho de dev assíncrono (padrão 'jules'). */
  delegateLabel?: string
  /**
   * 'recon' = Fase 1 do QA (a fase de Reconhecimento do papel): projeto novo,
   * sem PR para julgar ainda. Em vez do no-op clássico, roda o roteiro de
   * reconhecimento e devolve o baseline de qualidade do repositório. Sem este
   * modo, o padrão é o caminho clássico (julgamento de PR; sem PR = no-op).
   */
  mode?: 'judge' | 'recon'
  fetchImpl?: typeof fetch
}

export interface QaRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
}

/** Comentário de rework estruturado (8 campos) mencionando @jules. */
export function buildJulesReworkComment(comment: QaVerdictForm['comment']): string {
  const map: Record<string, string> = {
    Título: comment.titulo,
    Description: comment.description,
    Notes: comment.notes,
    'Implementation Guide': comment.implementationGuide,
    'Verification Criteria': comment.verificationCriteria,
    Summary: comment.summary,
    'Analysis Result': comment.analysisResult,
    'Related Files': comment.relatedFiles,
  }
  const sections = ISSUE_DOD_FIELDS.map((h) => `## ${h}\n\n${map[h] ?? ''}`)
  return [
    `${JULES_MARKER}`,
    '@jules the PR needs changes before it can be approved:',
    '',
    ...sections,
  ].join('\n\n')
}

function isJulesAuthor(login: string | undefined): boolean {
  return (login ?? '').toLowerCase().includes('jules')
}

export async function runQaMissionViaRails(
  options: QaRailsMissionOptions
): Promise<QaRailsMissionResult> {
  const f = options.fetchImpl ?? fetch
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
      // O corpo da resposta é o diagnóstico (ex.: 422 "Can not approve your
      // own pull request") — sem ele, o erro é um número mudo.
      const detail = await resp.text().catch(() => '')
      throw new GithubExecutionError(
        `GitHub ${method} ${path} failed (${resp.status}): ${detail.slice(0, 200)}`
      )
    }
    return resp.json().catch(() => ({}))
  }

  // 1) PRs abertas de dev assíncrono delegado (o gatilho do QA). O AUTOR não é
  // sinal confiável — visto em produção: o Jules abre o PR pela conta do dono
  // da instalação. O sinal nativo do GitOrch é o PR fechar uma issue com a
  // label de delegação; o login com "jules" fica só como atalho.
  const delegateLabel = options.delegateLabel ?? 'jules'
  const prs = (await gh(
    'GET',
    `/repos/${options.repository}/pulls?state=open&sort=created&direction=desc&per_page=20`
  )) as Array<{
    number: number
    user?: { login?: string }
    draft?: boolean
    body?: string
    head?: { sha?: string }
  }>
  let target: (typeof prs)[number] | undefined
  for (const p of Array.isArray(prs) ? prs : []) {
    if (p.draft) continue
    let delegated = isJulesAuthor(p.user?.login)
    if (!delegated) {
      const linked = (p.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
      if (!linked) continue
      const issue = (await gh('GET', `/repos/${options.repository}/issues/${linked}`)) as {
        labels?: Array<{ name?: string }>
      }
      delegated = (issue.labels ?? []).some((l) => l.name === delegateLabel)
    }
    if (!delegated) continue
    // Não re-julgar o MESMO estado a cada wake: se já há review nossa neste
    // head, o dev ainda não retrabalhou — julgar de novo só faria spam.
    const reviews = (await gh(
      'GET',
      `/repos/${options.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ body?: string; commit_id?: string }>
    const alreadyJudged =
      Array.isArray(reviews) &&
      reviews.some(
        (r) => (r.body ?? '').includes(JULES_MARKER) && (!p.head?.sha || r.commit_id === p.head.sha)
      )
    if (alreadyJudged) continue
    target = p
    break
  }
  if (!target) {
    // Fase 1 — Reconhecimento: projeto novo, sem PR aberta ainda. Sem este
    // modo, a esteira de onboarding terminaria num no-op ("QA: no delegated
    // PR awaiting judgment.") sem aprender nada do repositório. Aqui o QA
    // aprende o repositório (CI, suítes, cobertura, caminhos críticos) ANTES
    // do primeiro PR chegar.
    if (options.mode === 'recon') {
      const prompt = buildStepPrompt('qa', 'qa-recon', RAILS_SCHEMAS.qaRecon, [
        ...(options.contextBlocks ?? []),
        'No delegated PR is open yet — this project was just onboarded to GitOrch.',
        'Your job now is RECONNAISSANCE, not judgment: learn this repository before ' +
          'the first PR arrives. Use the codegraph/context above to identify the CI ' +
          'tool in use, the test suites/frameworks that exist, what test coverage is ' +
          'expected of new code, and the critical paths that must never break.',
      ])
      const recon = (await runFormStep({
        schema: RAILS_SCHEMAS.qaRecon,
        prompt,
        execute: options.execute,
      })) as QaReconForm
      return {
        exitCode: 0,
        output: formatQaReconDeliverable(recon),
        stderr: '',
      }
    }
    return {
      exitCode: 0,
      output: 'QA: no delegated PR awaiting judgment.',
      stderr: '',
      noOp: true,
    }
  }

  // 2) Snapshot curado pelo SISTEMA: PR + issue vinculada + critérios + diff + CI.
  const pr = (await gh('GET', `/repos/${options.repository}/pulls/${target.number}`)) as {
    body?: string
    head?: { sha?: string }
  }
  const linkedIssue = (pr.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
  let criteria = '(no linked issue / Verification Criteria not found)'
  let linkedIssueLabels: string[] = []
  if (linkedIssue) {
    const issue = (await gh('GET', `/repos/${options.repository}/issues/${linkedIssue}`)) as {
      body?: string
      labels?: Array<{ name?: string }>
    }
    linkedIssueLabels = (issue.labels ?? [])
      .map((l) => l.name)
      .filter((name): name is string => Boolean(name))
    const found = (issue.body ?? '').match(
      /##\s*Verification Criteria\s*\n+([\s\S]*?)(?:\n##\s|$)/i
    )
    if (found?.[1]) criteria = found[1].trim()
  }
  const files = (await gh(
    'GET',
    `/repos/${options.repository}/pulls/${target.number}/files?per_page=50`
  )) as Array<{ filename: string; patch?: string }>
  const diff = (Array.isArray(files) ? files : [])
    .map((x) => `--- ${x.filename}\n${(x.patch ?? '').slice(0, 2000)}`)
    .join('\n')
    .slice(0, 20000)
  let ciState = 'unknown'
  if (pr.head?.sha) {
    const checks = (await gh(
      'GET',
      `/repos/${options.repository}/commits/${pr.head.sha}/check-runs`
    )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
    const runs = checks.check_runs ?? []
    if (runs.length === 0) ciState = 'no checks'
    else if (runs.some((r) => r.status !== 'completed')) ciState = 'pending'
    else if (runs.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral'))
      ciState = 'green'
    else ciState = 'red'
  }

  // 3) Roteiro do QA: um formulário de veredito.
  const prompt = buildStepPrompt('qa', 'qa-verdict', RAILS_SCHEMAS.qaVerdict, [
    ...(options.contextBlocks ?? []),
    `PR #${target.number} by ${target.user?.login}.`,
    `Verification Criteria (from linked issue #${linkedIssue ?? '?'}):\n${criteria}`,
    `CI status: ${ciState}. (You MUST NOT approve when CI is not green.)`,
    `Diff (truncated):\n${diff}`,
  ])
  const verdict = (await runFormStep({
    schema: RAILS_SCHEMAS.qaVerdict,
    prompt,
    execute: options.execute,
  })) as QaVerdictForm

  // 3b) Trava de segurança determinística: nunca aprovar com CI não-verde,
  // mesmo se a LLM disser approve (a Lei: o sistema é o guarda final).
  const effectiveVerdict =
    verdict.verdict === 'approve' && ciState !== 'green' && ciState !== 'no checks'
      ? 'request_changes'
      : verdict.verdict

  // 4) Executor determinístico posta o veredito. O GitHub PROÍBE
  // aprovar/pedir-mudanças no PRÓPRIO PR (422) — e o Jules abre o PR pela
  // conta do dono da instalação, que é a mesma do token. Nesse caso o
  // veredito sai como review COMMENT (permitido), com o resultado explícito
  // no texto; o marker continua valendo para o skip de re-julgamento.
  const viewer = (await gh('GET', '/user')) as { login?: string }
  const selfPr = (viewer.login ?? '').toLowerCase() === (target.user?.login ?? '').toLowerCase()
  const reviewEvent = selfPr
    ? 'COMMENT'
    : effectiveVerdict === 'approve'
      ? 'APPROVE'
      : 'REQUEST_CHANGES'

  if (effectiveVerdict === 'approve') {
    await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
      event: reviewEvent,
      body: `${JULES_MARKER}\nGitOrch QA verdict: APPROVE — criteria met, CI green.${selfPr ? ' (posted as comment: token owner is the PR author)' : ''}\n\n${verdict.comment.summary}`,
    })
  } else {
    await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
      event: reviewEvent,
      body: `${JULES_MARKER}\nGitOrch QA verdict: REQUEST CHANGES (see comment).${selfPr ? ' (posted as comment: token owner is the PR author)' : ''}`,
    })
    await gh('POST', `/repos/${options.repository}/issues/${target.number}/comments`, {
      body: buildJulesReworkComment(verdict.comment),
    })
  }

  // 4b) O QA acabou de julgar: marca a issue VINCULADA (não a PR) como sua,
  // tirando quem estava com ela antes (ex.: gitorch:agent:jules, o dev
  // assíncrono que abriu o PR). Best-effort: aplicarLabelDoAgente nunca lança
  // — o veredito já foi postado acima, isso é só sinalização.
  if (linkedIssue) {
    await aplicarLabelDoAgente({
      repository: options.repository,
      issueNumber: Number(linkedIssue),
      agente: 'qa',
      lerLabels: async () => linkedIssueLabels,
      adicionarLabel: async (l) => {
        await gh('POST', `/repos/${options.repository}/issues/${linkedIssue}/labels`, {
          labels: [l],
        })
      },
      removerLabel: async (l) => {
        await gh(
          'DELETE',
          `/repos/${options.repository}/issues/${linkedIssue}/labels/${encodeURIComponent(l)}`
        )
      },
    })
  }

  // 5) O board acompanha o veredito: aprovado = pronto pelo padrão do GitOrch
  // (critérios atendidos + CI verde) → "done"; rework → volta a "inProgress".
  // Best-effort: board sem coluna/campo nunca derruba o julgamento já postado.
  let cardNote = ''
  if (options.moveCard && linkedIssue) {
    try {
      const moved = await options.moveCard(
        Number(linkedIssue),
        effectiveVerdict === 'approve' ? 'done' : 'inProgress'
      )
      cardNote = ` ${moved}.`
    } catch (err) {
      cardNote = ` card move failed: ${String(err).slice(0, 120)}.`
    }
  }

  return {
    exitCode: 0,
    output: `QA judged PR #${target.number}: ${effectiveVerdict} (CI ${ciState}).${cardNote}`,
    stderr: '',
  }
}
