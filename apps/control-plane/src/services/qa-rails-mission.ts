import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  ISSUE_DOD_FIELDS,
  type QaVerdictForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import { GithubExecutionError } from './github-backlog.js'

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
      throw new GithubExecutionError(`GitHub ${method} ${path} failed (${resp.status})`)
    }
    return resp.json().catch(() => ({}))
  }

  // 1) PRs abertas do Jules (o gatilho do QA).
  const prs = (await gh(
    'GET',
    `/repos/${options.repository}/pulls?state=open&sort=created&direction=desc&per_page=20`
  )) as Array<{ number: number; user?: { login?: string }; draft?: boolean }>
  const target = Array.isArray(prs)
    ? prs.find((p) => !p.draft && isJulesAuthor(p.user?.login))
    : undefined
  if (!target) {
    return { exitCode: 0, output: 'QA: no open Jules PR to review.', stderr: '', noOp: true }
  }

  // 2) Snapshot curado pelo SISTEMA: PR + issue vinculada + critérios + diff + CI.
  const pr = (await gh('GET', `/repos/${options.repository}/pulls/${target.number}`)) as {
    body?: string
    head?: { sha?: string }
  }
  const linkedIssue = (pr.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
  let criteria = '(no linked issue / Verification Criteria not found)'
  if (linkedIssue) {
    const issue = (await gh('GET', `/repos/${options.repository}/issues/${linkedIssue}`)) as {
      body?: string
    }
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

  // 4) Executor determinístico posta o veredito.
  if (effectiveVerdict === 'approve') {
    await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
      event: 'APPROVE',
      body: `${JULES_MARKER}\nGitOrch QA: criteria met, CI green.\n\n${verdict.comment.summary}`,
    })
  } else {
    await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
      event: 'REQUEST_CHANGES',
      body: `${JULES_MARKER}\nGitOrch QA: changes requested (see comment).`,
    })
    await gh('POST', `/repos/${options.repository}/issues/${target.number}/comments`, {
      body: buildJulesReworkComment(verdict.comment),
    })
  }

  return {
    exitCode: 0,
    output: `QA judged PR #${target.number}: ${effectiveVerdict} (CI ${ciState}).`,
    stderr: '',
  }
}
