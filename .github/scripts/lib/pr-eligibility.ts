/**
 * Verificador de "PR desta automação de segurança".
 *
 * Mesma lógica usada pelo auto-merge: um PR pertence à automação se for do Dependabot, OU tiver
 * label/marcador do Jules, OU resolver uma issue com label 'dependabot'/'jules'. Importante:
 * PRs do Jules saem como autor do usuário e NÃO recebem a label 'jules' (ela fica na issue),
 * por isso não dá para gatear só pela label do PR.
 */

import type { Octokit } from '@octokit/rest'

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
}

/** Extrai números de issues ligadas pelo corpo do PR (Fixes #N, links de issue). */
export function linkedIssueNumbers(body: string): number[] {
  const nums = new Set<number>()
  const re = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (m[1]) nums.add(parseInt(m[1], 10))
  }
  const urlRe = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/gi
  while ((m = urlRe.exec(body)) !== null) {
    if (m[1]) nums.add(parseInt(m[1], 10))
  }
  return [...nums]
}

/** Retorna true se o PR pertence à automação de segurança (Dependabot/Jules). */
export async function isSecurityAutomationPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  const pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data
  if (pr.user?.login === 'dependabot[bot]') return true

  const labels = labelNames(pr.labels)
  if (labels.includes('jules')) return true

  const body = pr.body ?? ''
  if (body.includes('PR created automatically by Jules')) return true

  for (const n of linkedIssueNumbers(body)) {
    try {
      const issue = await octokit.rest.issues.get({ owner, repo, issue_number: n })
      const il = labelNames(issue.data.labels)
      if (il.includes('dependabot') || il.includes('jules')) return true
    } catch {
      // issue inacessível — ignora
    }
  }
  return false
}

/**
 * Retorna true se o PR foi criado pelo Jules (tem uma sessão real escutando comentários).
 *
 * Diferença crítica de `isSecurityAutomationPR`: um PR do Dependabot PURO (rotina, sem passar
 * pelo Jules — ex.: bump de versão de devDependency) É elegível pra automação de segurança
 * (auto-merge etc.), mas NÃO tem sessão do Jules ativa. Comentar `@jules` nesse PR não faz
 * nada — ninguém está escutando. Só um PR que o próprio Jules abriu tem sessão pra reagir a
 * menções. Visto ao vivo: PR #213 (bump de @types/node) travado com CI vermelho, `@jules` seria
 * um comentário no vazio.
 */
export function hasActiveJulesSession(pr: { body?: string | null }): boolean {
  return (pr.body ?? '').includes('PR created automatically by Jules')
}
