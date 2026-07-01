/**
 * CI Failure Analyzer with Log Fetching
 *
 * Fetches failed CI job logs for a Jules PR, analyzes the failure with issue + PR context,
 * and generates @jules fix instructions. Only runs if PR is open >1 business day.
 */

import { Octokit } from '@octokit/rest'
import { OpenRouterClient, createOpenRouterClientFromEnv } from './lib/openrouter-client.js'
import { isSecurityAutomationPR } from './lib/pr-eligibility.js'
import { extractRelevantLogSections } from './lib/log-extraction.js'
import { z } from 'zod'

// Types
const CIFailureAnalysisSchema = z.object({
  rootCause: z.string(),
  fixInstructions: z.string(),
  comment: z.string(),
})

export type CIFailureAnalysis = z.infer<typeof CIFailureAnalysisSchema>

/**
 * Checks if a date is more than N business days ago
 */
export function isOlderThanBusinessDays(date: Date, businessDays: number): boolean {
  const now = new Date()
  let diffDays = 0
  const checkDate = new Date(date)

  while (checkDate < now) {
    checkDate.setDate(checkDate.getDate() + 1)
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (checkDate.getDay() !== 0 && checkDate.getDay() !== 6) {
      diffDays++
    }
    if (diffDays > businessDays) return true
  }
  return false
}

/**
 * Fetches PR details and linked issue
 */
export async function fetchPRAndIssueContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ pr: Record<string, unknown>; issue: Record<string, unknown> | null }> {
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  })
  const pr = prResponse.data

  // Find linked issue from PR body
  let issue = null
  const issueRefs = [
    ...(pr.body?.match(/close[s]?\s+#(\d+)/gi) || []),
    ...(pr.body?.match(/fixe[s]?\s+#(\d+)/gi) || []),
    ...(pr.body?.match(/resolve[s]?\s+#(\d+)/gi) || []),
    ...(pr.body?.match(/github\.com\/[^\/]+\/[^\/]+\/issues\/(\d+)/gi) || []),
  ]
    .map((m) => parseInt(m.match(/\d+/)?.[0] || '0', 10))
    .filter((n) => n > 0)

  if (issueRefs.length > 0) {
    const firstIssueRef = issueRefs[0]
    if (firstIssueRef === undefined) {
      return { pr, issue }
    }
    try {
      const issueResponse = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: firstIssueRef,
      })
      issue = issueResponse.data
    } catch (error) {
      console.warn(`Could not fetch linked issue #${firstIssueRef}:`, error)
    }
  }

  return { pr, issue }
}

/**
 * Encontra o workflow run FALHO do workflow de CI principal (por nome, default 'CI' —
 * corresponde ao `name:` do ci.yml) para o head sha do PR.
 *
 * Um PR tem VÁRIOS check suites do app "GitHub Actions" no mesmo commit — um por workflow
 * (CI, auto-merge, jules-pr-conflict, e o ci-backend.yml que está cronicamente quebrado com
 * startup_failure e 0 jobs). Pegar "o primeiro check suite do GitHub Actions" é ambíguo e pode
 * pegar o workflow errado (ex.: ci-backend.yml, sem jobs, sem logs úteis) — a LLM então "chuta"
 * a causa raiz a partir do contexto da issue, produzindo diagnóstico errado (visto no PR #189).
 */
export async function findFailedCIWorkflowRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  ciWorkflowName = 'CI'
): Promise<{ id: number; html_url: string; name: string } | null> {
  try {
    const prResponse = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const headSha = prResponse.data.head.sha

    const response = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: headSha,
      per_page: 30,
    })

    const named = response.data.workflow_runs.find(
      (r) => r.name === ciWorkflowName && r.conclusion === 'failure'
    )
    if (named) return { id: named.id, html_url: named.html_url, name: named.name ?? ciWorkflowName }

    // Fallback: nenhum run com esse nome exato falhou — pega qualquer run falho que tenha
    // pelo menos 1 job (descarta runs com startup_failure/0 jobs, como o ci-backend.yml quebrado).
    for (const run of response.data.workflow_runs.filter((r) => r.conclusion === 'failure')) {
      const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
        per_page: 1,
      })
      if (jobs.data.jobs.length > 0) {
        return { id: run.id, html_url: run.html_url, name: run.name ?? 'desconhecido' }
      }
    }

    return null
  } catch (error) {
    console.warn('Could not find failed CI workflow run:', error)
    return null
  }
}

/**
 * Fetches failed job logs from a workflow run
 */
export async function fetchFailedJobLogs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<string> {
  try {
    const jobsResponse = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      per_page: 100,
    })

    const failedJobs = jobsResponse.data.jobs.filter((job) => job.conclusion === 'failure')

    if (failedJobs.length === 0) {
      return 'No failed jobs found in workflow run.'
    }

    let logsOutput = ''

    for (const job of failedJobs) {
      try {
        logsOutput += `\n\n=== JOB: ${job.name} (ID: ${job.id}) ===\n`
        logsOutput += `Status: ${job.conclusion}\n`
        logsOutput += `Steps: ${job.steps?.map((s) => `${s.name}: ${s.conclusion || s.status}`).join(', ') || 'N/A'}\n`

        // Try to get logs via the jobs API (text format)
        try {
          const logResponse = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`,
            {
              headers: {
                Authorization: `Bearer ${octokit.auth}`,
                Accept: 'application/vnd.github+json',
              },
            }
          )

          if (logResponse.ok) {
            const logText = await logResponse.text()
            // Extrai trechos com erro real (##[error] + contexto) + o final do log, em vez de
            // cortar os primeiros N chars — logs longos (boot de serviços etc.) escondem o erro
            // real bem depois do início, fazendo a LLM nunca vê-lo.
            const relevant = extractRelevantLogSections(logText, 9000)
            logsOutput += `\n--- LOGS (trechos relevantes: erros + final) ---\n${relevant}\n`
            if (logText.length > relevant.length) {
              logsOutput += `\n[Log completo tem ${logText.length} chars; mostrando trechos com erro + final]`
            }
          }
        } catch (logError) {
          logsOutput += `\nCould not fetch detailed logs: ${logError}\n`
        }
      } catch (jobError) {
        logsOutput += `\nError processing job ${job.id}: ${jobError}\n`
      }
    }

    return logsOutput
  } catch (error) {
    console.error('Error fetching failed job logs:', error)
    return `Error fetching logs: ${error}`
  }
}

/**
 * Analyzes CI failure with LLM
 */
export async function analyzeCIFailure(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  llmClient: OpenRouterClient | null = null
): Promise<CIFailureAnalysis> {
  console.log(`Analyzing CI failure for PR #${prNumber}...`)

  // Get PR and issue context
  const { pr, issue } = await fetchPRAndIssueContext(octokit, owner, repo, prNumber)

  // Encontra o run FALHO do workflow "CI" (o portão de qualidade real), não qualquer
  // check suite do GitHub Actions (evita pegar o ci-backend.yml quebrado, sem jobs).
  const ciWorkflowName = (process.env['CI_WORKFLOW_NAME'] as string | undefined) || 'CI'
  const run = await findFailedCIWorkflowRun(octokit, owner, repo, prNumber, ciWorkflowName)
  if (!run) {
    return {
      rootCause: 'Could not find failed CI workflow run for PR',
      fixInstructions: 'Manual investigation required',
      comment:
        '@jules Não foi possível encontrar o workflow run do CI. Investigação manual necessária.',
    }
  }
  const runId = run.id
  const checkSuite = { html_url: run.html_url }

  // Fetch failed job logs
  const logs = await fetchFailedJobLogs(octokit, owner, repo, runId)

  // Get PR changes summary
  const filesResponse = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })
  const changedFiles = filesResponse.data.map((f: Record<string, unknown>) => ({
    filename: f['filename'] as string,
    status: f['status'] as string,
    additions: f['additions'] as number,
    deletions: f['deletions'] as number,
    patch: (f['patch'] as string | undefined)?.substring(0, 2000),
  }))

  // Build LLM prompt
  if (llmClient) {
    try {
      const prompt = `Analise a falha de CI neste PR criado pelo Jules e forneça instruções EXATAS para correção.

**PR #${prNumber}:** ${(pr as Record<string, unknown>)['title'] as string}
**Branch:** ${((pr as Record<string, unknown>)['head'] as Record<string, unknown>)['ref'] as string}
**Workflow Run:** #${runId} (${(checkSuite as Record<string, unknown>)['html_url'] as string})

**Issue Vinculada (#${((issue as Record<string, unknown>)['number'] as number | undefined) ?? 'N/A'}):**
${issue ? `${(issue as Record<string, unknown>)['title'] as string}\n${((issue as Record<string, unknown>)['body'] as string | undefined)?.substring(0, 1500)}` : 'Nenhuma issue vinculada encontrada'}

**Arquivos Alterados no PR:**
${changedFiles.map((f) => `- \`${f['filename'] as string}\` (${f['status'] as string}): +${f['additions'] as number}/-${f['deletions'] as number}`).join('\n')}

**Logs de Falha do CI:**
${logs.substring(0, 9500)}
${logs.length > 9500 ? '\n[Logs truncados...]' : ''}

**REGRAS OBRIGATÓRIAS:**
1. O comentário DEVE começar com "@jules" (para acionar o bot)
2. Identifique a CAUSA RAIZ específica (erro de compilação, teste falhando, lint, etc.)
3. Forneça comandos EXATOS para corrigir (ex: "rode pnpm install --frozen-lockfile", "corrija o import em src/x.ts")
4. Seja direto, em Português (PT-BR)
5. NÃO inclua texto de segurança ("User Safety: safe")
6. Foque no que o Jules deve FAZER, não no que aconteceu

Responda APENAS com o comentário para o @jules.`

      const response = await llmClient.complete(prompt, { maxTokens: 6000, temperature: 0.1 })

      return {
        rootCause: 'Analyzed via LLM',
        fixInstructions: response,
        comment: response,
      }
    } catch (error) {
      console.error('LLM analysis failed:', error)
    }
  }

  // Fallback without LLM
  return generateFallbackAnalysis(pr, logs, changedFiles)
}

/**
 * Generates fallback analysis without LLM
 */
function generateFallbackAnalysis(
  pr: Record<string, unknown>,
  logs: string,
  changedFiles: Record<string, unknown>[]
): CIFailureAnalysis {
  let rootCause = 'CI failure detected'
  let fixInstructions = ''

  // Try to identify common failure patterns
  const lowerLogs = logs.toLowerCase()

  if (
    lowerLogs.includes('error ts') ||
    lowerLogs.includes('typescript error') ||
    lowerLogs.includes('type error')
  ) {
    rootCause = 'TypeScript compilation errors'
    fixInstructions =
      'Corrija os erros de tipo TypeScript. Verifique os arquivos alterados recentemente.'
  } else if (
    lowerLogs.includes('test failed') ||
    lowerLogs.includes('assertion failed') ||
    lowerLogs.includes('expect(')
  ) {
    rootCause = 'Test failures'
    fixInstructions = "Corrija os testes falhando. Rode 'pnpm test' localmente para reproduzir."
  } else if (
    lowerLogs.includes('lint') ||
    lowerLogs.includes('eslint') ||
    lowerLogs.includes('prettier')
  ) {
    rootCause = 'Linting/formatting errors'
    fixInstructions =
      "Corrija os erros de lint. Rode 'pnpm lint --fix' e 'pnpm format' se disponível."
  } else if (
    lowerLogs.includes('module not found') ||
    lowerLogs.includes('cannot find module') ||
    lowerLogs.includes('import')
  ) {
    rootCause = 'Missing dependencies or import errors'
    fixInstructions =
      "Verifique imports quebrados e dependências faltando. Rode 'pnpm install --frozen-lockfile'."
  } else if (
    lowerLogs.includes('lockfile') ||
    lowerLogs.includes('pnpm-lock') ||
    lowerLogs.includes('out of sync')
  ) {
    rootCause = 'Lockfile out of sync'
    fixInstructions =
      "Rode 'pnpm install --frozen-lockfile' para regenerar o lockfile e commite as alterações."
  } else if (
    lowerLogs.includes('permission denied') ||
    lowerLogs.includes('eacces') ||
    lowerLogs.includes('eperm')
  ) {
    rootCause = 'Permission issues'
    fixInstructions = 'Problema de permissão no CI. Verifique scripts que precisam de chmod +x.'
  } else {
    rootCause = 'Unknown CI failure'
    fixInstructions = 'Analise os logs completos do CI para identificar a causa raiz.'
  }

  let comment = `@jules O CI falhou neste PR (${(pr as Record<string, unknown>)['title'] as string}).

**Causa Raiz Provável:** ${rootCause}

**Instruções de Correção:**
${fixInstructions}

**Arquivos Alterados:**
${changedFiles.map((f) => `- \`${f['filename'] as string}\` (${f['status'] as string})`).join('\n')}

**Logs Relevantes:**
\`\`\`
${logs.substring(0, 3000)}
\`\`\`

Por favor, corrija e faça commit na mesma branch.`

  return { rootCause, fixInstructions, comment }
}

/**
 * Posts CI failure analysis comment to PR
 */
export async function postCIFailureComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comment: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: comment,
  })

  console.log(`Posted CI failure analysis comment on PR #${prNumber}`)
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2)
  const prNumber = args[0] ? parseInt(args[0], 10) : null

  if (!prNumber) {
    console.error('PR number required as argument')
    process.exit(1)
  }

  const env = process.env as Record<string, string | undefined>
  const owner = env['REPO_OWNER'] || 'loureng'
  const repo = env['REPO_NAME'] || 'gitorch'
  const githubToken = env['SECURITY_PAT'] || env['GITHUB_TOKEN']

  if (!githubToken) {
    console.error('SECURITY_PAT or GITHUB_TOKEN environment variable is required')
    process.exit(1)
  }

  const octokit = new Octokit({ auth: githubToken })
  const llmClient = env['OPENROUTER_API_KEY'] ? createOpenRouterClientFromEnv() : null

  // Só age em PR desta automação de segurança (Dependabot/Jules).
  if (!(await isSecurityAutomationPR(octokit, owner, repo, prNumber))) {
    console.log(`PR #${prNumber} fora da automação de segurança. Ignorando.`)
    process.exit(0)
  }

  // Check PR age (business days)
  const prResponse = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
  const createdAt = new Date(prResponse.data.created_at)
  const slaDays = parseInt(env['SLA_BUSINESS_DAYS'] || '1', 10)

  if (!isOlderThanBusinessDays(createdAt, slaDays)) {
    console.log(
      `PR #${prNumber} is less than ${slaDays} business day(s) old. Skipping fallback analysis.`
    )
    console.log('Jules built-in auto-fix should handle this.')
    process.exit(0)
  }

  console.log(
    `PR #${prNumber} is older than ${slaDays} business day(s). Running fallback analysis...`
  )

  const analysis = await analyzeCIFailure(octokit, owner, repo, prNumber, llmClient)
  await postCIFailureComment(octokit, owner, repo, prNumber, analysis.comment)

  console.log('CI failure analysis complete. Comment posted.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
