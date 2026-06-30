/**
 * Handler de "apology" do Jules.
 *
 * Quando o Jules comenta que não conseguiu completar a tarefa, este script:
 *   1. Lê as activities da sessão via Jules API (entende o motivo da falha).
 *   2. Lê o corpo da issue ligada (entende a intenção original).
 *   3. LLM (rota free) cruza os dois e escreve uma orientação acionável.
 *   4. Envia a orientação para a sessão via Jules API (sendMessage).
 *
 * Uso: tsx analyze-jules-failure.ts <sessionId> <issueNumber>
 *
 * Env: JULES_API_KEY, OPENROUTER_API_KEY, SECURITY_PAT (GITHUB_TOKEN), REPO_OWNER, REPO_NAME.
 */

import { Octokit } from '@octokit/rest'
import { createOpenRouterClientFromEnv } from './lib/openrouter-client.js'
import { JulesClient } from './lib/jules-client.js'

async function main(): Promise<void> {
  const sessionId = process.argv[2]
  const issueNumber = parseInt(process.argv[3] ?? '', 10)

  if (!sessionId || Number.isNaN(issueNumber)) {
    console.error('Uso: tsx analyze-jules-failure.ts <sessionId> <issueNumber>')
    process.exit(1)
  }

  const env = process.env as Record<string, string | undefined>
  const julesKey = env['JULES_API_KEY']
  const token = env['SECURITY_PAT'] || env['GITHUB_TOKEN']
  const owner = env['REPO_OWNER']
  const repo = env['REPO_NAME']

  if (!julesKey) throw new Error('JULES_API_KEY não configurado')
  if (!token || !owner || !repo)
    throw new Error('SECURITY_PAT/REPO_OWNER/REPO_NAME não configurados')

  const jules = new JulesClient(julesKey)
  const octokit = new Octokit({ auth: token })

  // 1. Activities da sessão (motivo da falha).
  console.log(`Lendo activities da sessão Jules ${sessionId}...`)
  const activities = await jules.getActivities(sessionId, 30)
  const activitiesJson = JSON.stringify(activities, null, 2).slice(0, 12000)

  // 2. Corpo da issue ligada (intenção original).
  console.log(`Lendo issue #${issueNumber}...`)
  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber })
  const issueBody = (issue.data.body ?? '').slice(0, 8000)
  const issueTitle = issue.data.title

  // 3. LLM (rota free) gera a orientação.
  const systemPrompt = [
    'Você é um engenheiro sênior orientando o agente Jules a desbloquear uma tarefa que ele',
    'não conseguiu completar. Escreva instruções curtas, específicas e acionáveis (estilo',
    'jules-awesome-list): diga exatamente o que investigar/mudar e como. Foque na causa da falha',
    'descrita nas activities. Se o conserto exige decisão de risco (ex.: major version que quebra),',
    'oriente o caminho mais seguro. Responda em português, direto, sem preâmbulo.',
  ].join(' ')

  const userPrompt = [
    `## Tarefa original (issue #${issueNumber}: ${issueTitle})`,
    issueBody,
    '',
    '## Activities da sessão do Jules (onde ele falhou)',
    '```json',
    activitiesJson,
    '```',
    '',
    'Escreva a mensagem de orientação para o Jules prosseguir e resolver.',
  ].join('\n')

  console.log('Gerando orientação (rota free)...')
  const llm = createOpenRouterClientFromEnv()
  const guidance = await llm.completeWithSystem(systemPrompt, userPrompt, {
    maxTokens: 4000,
    temperature: 0.1,
  })

  console.log('=== GUIDANCE ===')
  console.log(guidance)
  console.log('=== END GUIDANCE ===')

  // 4. Envia para a sessão do Jules.
  console.log(`Enviando orientação para a sessão ${sessionId} via sendMessage...`)
  await jules.sendMessage(sessionId, guidance)
  console.log('Orientação enviada com sucesso.')
}

main().catch((err) => {
  console.error('Falha no handler de apology:', err instanceof Error ? err.message : err)
  process.exit(1)
})
