/**
 * Gerador de prompt Jules para alertas de Code Scanning (CodeQL).
 *
 * Lê um alerta de code scanning via GitHub API, monta um prompt rico (regra, severidade,
 * CWE, arquivo+linhas, mensagem, trecho de código) e usa a LLM (rota free) para uma seção
 * "Como resolver" no estilo jules-awesome-list. Saída: JSON {title, body, labels} entre
 * marcadores === GENERATED PROMPT === / === END PROMPT === (mesmo contrato do dependabot).
 *
 * Uso: tsx generate-codeql-prompt.ts <alertNumber>
 * Env: SECURITY_PAT (GITHUB_TOKEN), REPO_OWNER, REPO_NAME, OPENROUTER_API_KEY (opcional).
 */

import { Octokit } from '@octokit/rest'
import { createOpenRouterClientFromEnv } from './lib/openrouter-client.js'
import { z } from 'zod'

const CodeScanningAlertSchema = z.object({
  number: z.number(),
  state: z.string(),
  html_url: z.string().nullish(),
  rule: z.object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    severity: z.string().nullish(),
    security_severity_level: z.string().nullish(),
    description: z.string().nullish(),
    help: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  }),
  tool: z.object({ name: z.string().nullish() }).nullish(),
  most_recent_instance: z
    .object({
      ref: z.string().nullish(),
      message: z.object({ text: z.string().nullish() }).nullish(),
      location: z
        .object({
          path: z.string().nullish(),
          start_line: z.number().nullish(),
          end_line: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
})

type CodeScanningAlert = z.infer<typeof CodeScanningAlertSchema>

async function fetchSnippet(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  start: number,
  end: number
): Promise<string> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref: 'main' })
    const data = res.data as { content?: string; encoding?: string }
    if (!data.content) return ''
    const text = Buffer.from(data.content, 'base64').toString('utf8')
    const lines = text.split('\n')
    const from = Math.max(0, start - 3)
    const to = Math.min(lines.length, end + 3)
    return lines
      .slice(from, to)
      .map((l, i) => `${from + i + 1}\t${l}`)
      .join('\n')
  } catch {
    return ''
  }
}

function severity(alert: CodeScanningAlert): string {
  return (alert.rule.security_severity_level || alert.rule.severity || 'warning').toUpperCase()
}

async function main(): Promise<void> {
  const alertNumber = parseInt(process.argv[2] ?? '', 10)
  if (Number.isNaN(alertNumber)) {
    console.error('Uso: tsx generate-codeql-prompt.ts <alertNumber>')
    process.exit(1)
  }

  const env = process.env as Record<string, string | undefined>
  const token = env['SECURITY_PAT'] || env['GITHUB_TOKEN']
  const owner = env['REPO_OWNER']
  const repo = env['REPO_NAME']
  if (!token || !owner || !repo)
    throw new Error('SECURITY_PAT/REPO_OWNER/REPO_NAME não configurados')

  const octokit = new Octokit({ auth: token })

  console.error(`Fetching Code Scanning alert #${alertNumber}...`)
  const raw = await octokit.request(
    'GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}',
    { owner, repo, alert_number: alertNumber }
  )
  const alert = CodeScanningAlertSchema.parse(raw.data)

  const loc = alert.most_recent_instance?.location
  const path = loc?.path ?? 'desconhecido'
  const startLine = loc?.start_line ?? 0
  const endLine = loc?.end_line ?? startLine
  const cwes = (alert.rule.tags ?? [])
    .filter((t) => t.startsWith('external/cwe/'))
    .map((t) => t.replace('external/cwe/', '').toUpperCase())

  const snippet =
    path !== 'desconhecido' && startLine > 0
      ? await fetchSnippet(octokit, owner, repo, path, startLine, endLine)
      : ''

  // Seção "Como resolver" via LLM rota free (com fallback determinístico).
  let remediation = ''
  try {
    if (env['OPENROUTER_API_KEY']) {
      const llm = createOpenRouterClientFromEnv()
      const sys =
        'Você é um engenheiro de segurança. Dado um achado do CodeQL, escreva instruções curtas, ' +
        'específicas e acionáveis para o agente Jules CORRIGIR o código (estilo jules-awesome-list). ' +
        'Diga exatamente o que mudar no arquivo indicado e como, sem preâmbulo. Responda em português.'
      const usr = [
        `Regra CodeQL: ${alert.rule.id} — ${alert.rule.description}`,
        `Severidade: ${severity(alert)} | CWE: ${cwes.join(', ') || 'n/a'}`,
        `Arquivo: ${path} (linhas ${startLine}-${endLine})`,
        `Mensagem: ${alert.most_recent_instance?.message?.text ?? ''}`,
        `Ajuda da regra: ${(alert.rule.help ?? '').slice(0, 1200)}`,
        snippet ? `Trecho:\n${snippet}` : '',
      ].join('\n')
      remediation = await llm.completeWithSystem(sys, usr, { maxTokens: 2500, temperature: 0.1 })
    }
  } catch (err) {
    console.error(
      'LLM falhou, usando fallback determinístico:',
      err instanceof Error ? err.message : err
    )
  }
  if (!remediation) {
    remediation = `Corrija o achado **${alert.rule.id}** em \`${path}\` (linhas ${startLine}-${endLine}) seguindo a recomendação da regra CodeQL. Aplique a correção mínima e segura, sem alterar comportamento não relacionado.`
  }

  const title = `[Segurança] CodeQL: ${alert.rule.description ?? alert.rule.id} (${severity(alert)})`
  const body = [
    '## 🛡️ Issue de Segurança: Code Scanning (CodeQL)',
    '',
    '<!-- codeql-alert-number: ' + alert.number + ' -->',
    '',
    '| Campo | Valor |',
    '|-------|-------|',
    `| **Regra** | \`${alert.rule.id}\` |`,
    `| **Descrição** | ${alert.rule.description ?? 'n/a'} |`,
    `| **Severidade** | ${severity(alert)} |`,
    `| **CWE** | ${cwes.join(', ') || 'n/a'} |`,
    `| **Ferramenta** | ${alert.tool?.name ?? 'CodeQL'} |`,
    `| **Arquivo** | \`${path}\` (linhas ${startLine}-${endLine}) |`,
    `| **Alerta** | [#${alert.number}](${alert.html_url ?? ''}) |`,
    '',
    '### Mensagem do CodeQL',
    alert.most_recent_instance?.message?.text ?? 'n/a',
    '',
    snippet ? '### Trecho do código\n```ts\n' + snippet + '\n```\n' : '',
    '### Como resolver',
    remediation,
    '',
    '> Prazo P0 (1 dia útil). Faça a correção e abra o PR resolvendo esta issue.',
  ].join('\n')

  const labels = [
    'jules',
    'code-scanning',
    'security',
    (severity(alert) || 'warning').toLowerCase(),
  ]

  console.log('=== GENERATED PROMPT ===')
  console.log(JSON.stringify({ title, body, labels }))
  console.log('=== END PROMPT ===')
}

main().catch((err) => {
  console.error(`Alert #${process.argv[2]} not found or invalid`)
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
