/**
 * SLA Tracker with Business Day Calculation
 *
 * Tracks time from Dependabot alert creation to resolution (PR merged).
 * Creates breach alert issues for alerts exceeding SLA (1 business day default).
 * Runs every 4 hours via scheduled workflow.
 */

import { Octokit } from '@octokit/rest'
import { z } from 'zod'

// Types
const SLAAlertSchema = z.object({
  alertNumber: z.number(),
  ghsaId: z.string().optional(),
  cveId: z.string().optional(),
  packageName: z.string(),
  severity: z.string(),
  createdAt: z.string(),
  businessDaysOpen: z.number(),
  linkedIssueNumber: z.number().optional(),
  linkedIssueUrl: z.string().optional(),
  linkedPrNumber: z.number().optional(),
  linkedPrUrl: z.string().optional(),
  status: z.enum(['open', 'in-progress', 'breached', 'resolved']),
})

export type SLAAlert = z.infer<typeof SLAAlertSchema>

/**
 * Calculates business days between two dates (excludes weekends)
 */
export function calculateBusinessDays(startDate: Date, endDate: Date = new Date()): number {
  let businessDays = 0
  const current = new Date(startDate)
  current.setHours(0, 0, 0, 0)

  const end = new Date(endDate)
  end.setHours(0, 0, 0, 0)

  while (current <= end) {
    const day = current.getDay() // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      businessDays++
    }
    current.setDate(current.getDate() + 1)
  }

  return businessDays
}

/**
 * Checks if a date is a business day
 */
export function isBusinessDay(date: Date): boolean {
  const day = date.getDay()
  return day !== 0 && day !== 6
}

/**
 * Fetches all open Dependabot alerts
 */
export async function fetchOpenDependabotAlerts(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<
  Array<{
    number: number
    ghsa_id?: string
    cve_id?: string
    package_name: string
    severity: string
    created_at: string
  }>
> {
  const alerts: Array<{
    number: number
    ghsa_id?: string
    cve_id?: string
    package_name: string
    severity: string
    created_at: string
  }> = []

  for await (const response of octokit.paginate.iterator(
    octokit.rest.dependabot.listAlertsForRepo,
    { owner, repo, state: 'open', per_page: 100 }
  )) {
    for (const alert of response.data) {
      const pkgName = alert.dependency?.package?.name || 'unknown'
      const alertObj: {
        number: number
        ghsa_id?: string
        cve_id?: string
        package_name: string
        severity: string
        created_at: string
      } = {
        number: alert.number,
        package_name: pkgName,
        severity: alert.security_advisory?.severity || 'unknown',
        created_at: alert.created_at,
      }
      if (alert.security_advisory?.ghsa_id) {
        alertObj.ghsa_id = alert.security_advisory.ghsa_id
      }
      if (alert.security_advisory?.cve_id) {
        alertObj.cve_id = alert.security_advisory.cve_id
      }
      alerts.push(alertObj)
    }
  }

  return alerts
}

/**
 * Finds linked issue for an alert (by GHSA ID, CVE, or alert number marker)
 */
export async function findLinkedIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  alert: { ghsa_id?: string; cve_id?: string; number: number }
): Promise<{ number: number; url: string; state: string } | null> {
  const searchTerms: string[] = []

  if (alert.ghsa_id) searchTerms.push(alert.ghsa_id)
  if (alert.cve_id) searchTerms.push(alert.cve_id)
  searchTerms.push(`dependabot-alert-number: ${alert.number}`)

  // Search issues with 'jules' label (our automation creates these)
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    labels: 'jules',
    per_page: 100,
  })

  for (const issue of issues) {
    const body = issue.body || ''
    for (const term of searchTerms) {
      if (body.includes(term)) {
        return {
          number: issue.number,
          url: issue.html_url,
          state: issue.state,
        }
      }
    }
  }

  return null
}

/**
 * Finds linked PR for an issue (by issue number in PR body)
 */
export async function findLinkedPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ number: number; url: string; state: string; merged: boolean } | null> {
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'all',
    per_page: 100,
  })

  for (const pr of prs) {
    const body = pr.body || ''

    // Check for closing keywords
    const closingRefs = body.match(
      /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi
    )
    if (closingRefs) {
      for (const ref of closingRefs) {
        const match = ref.match(/#(\d+)/)
        const matchNum = match?.[1]
        if (matchNum && parseInt(matchNum, 10) === issueNumber) {
          return {
            number: pr.number,
            url: pr.html_url,
            state: pr.state,
            merged: pr.merged_at !== null,
          }
        }
      }
    }

    // Check for issue URLs
    const urlRefs = body.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/(\d+)/gi)
    if (urlRefs) {
      for (const ref of urlRefs) {
        const match = ref.match(/issues\/(\d+)/)
        const matchNum = match?.[1]
        if (matchNum && parseInt(matchNum, 10) === issueNumber) {
          return {
            number: pr.number,
            url: pr.html_url,
            state: pr.state,
            merged: pr.merged_at !== null,
          }
        }
      }
    }
  }

  return null
}

/**
 * Creates SLA breach alert issue
 */
export async function createSLABreachIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  alert: SLAAlert,
  slaDays: number
): Promise<number> {
  const title = `🚨 SLA BREACH: Dependabot Alert #${alert.alertNumber} exceeds ${slaDays} business day(s)`

  const body = `## SLA Breach Alert

**Alerta Dependabot:** #${alert.alertNumber}
**Pacote:** \`${alert.packageName}\`
**Severidade:** ${alert.severity.toUpperCase()}
**GHSA ID:** ${alert.ghsaId || 'N/A'}
**CVE ID:** ${alert.cveId || 'N/A'}
**Criado em:** ${alert.createdAt}
**Dias úteis em aberto:** ${alert.businessDaysOpen} (SLA: ${slaDays} dia(s) útil(eis))

---

### Status Atual
- **Issue vinculada:** ${alert.linkedIssueNumber ? `#${alert.linkedIssueNumber} (${alert.linkedIssueUrl})` : 'Não encontrada'}
- **PR vinculado:** ${alert.linkedPrNumber ? `#${alert.linkedPrNumber} (${alert.linkedPrUrl})` : 'Não encontrado'}
- **Estado:** ${alert.status}

---

### Ação Necessária
Esta vulnerabilidade está aberta há **mais de ${slaDays} dia(s) útil(eis)** sem resolução.

**Próximos passos recomendados:**
1. Verificar se a issue \`jules\` foi criada e se o Jules está trabalhando
2. Se o Jules falhou, re-engajar via label \`jules\`
3. Se houver conflitos de merge, resolver manualmente
4. Se CI falhou há mais de 1 dia, o fallback automático já deveria ter acionado

---

*Alerta gerado automaticamente pelo SLA Tracker do GitOrch.*
<!-- sla-breach: dependabot-${alert.alertNumber} -->`

  const response = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: ['sla-breach', 'P0', 'security', 'dependabot', alert.severity],
  })

  return response.data.number
}

/**
 * Main SLA tracking function
 */
export async function runSLATracker(
  octokit: Octokit,
  owner: string,
  repo: string,
  slaDays: number = 1
): Promise<void> {
  console.log(`Running SLA tracker for ${owner}/${repo} (SLA: ${slaDays} business day(s))...`)

  // Fetch all open Dependabot alerts
  const alerts = await fetchOpenDependabotAlerts(octokit, owner, repo)
  console.log(`Found ${alerts.length} open Dependabot alerts`)

  // Check existing SLA breach issues to avoid duplicates
  const existingBreaches = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    labels: 'sla-breach',
    per_page: 100,
  })

  const existingBreachKeys = new Set<string>()
  for (const issue of existingBreaches) {
    const match = issue.body?.match(/<!-- sla-breach: dependabot-(\d+) -->/)
    if (match?.[1]) existingBreachKeys.add(match[1])
  }

  let breachesFound = 0

  for (const alert of alerts) {
    const createdAt = new Date(alert.created_at)
    const businessDaysOpen = calculateBusinessDays(createdAt)

    // Find linked issue
    const linkedIssue = await findLinkedIssue(octokit, owner, repo, alert)

    // Find linked PR
    let linkedPr = null
    if (linkedIssue) {
      linkedPr = await findLinkedPR(octokit, owner, repo, linkedIssue.number)
    }

    // Determine status
    let status: SLAAlert['status'] = 'open'
    if (linkedIssue && linkedIssue.state === 'open') {
      status = 'in-progress'
    }
    if (linkedPr && linkedPr.merged) {
      status = 'resolved'
    }
    if (businessDaysOpen > slaDays && status !== 'resolved') {
      status = 'breached'
    }

    const slaAlert: SLAAlert = {
      alertNumber: alert.number,
      ghsaId: alert.ghsa_id,
      cveId: alert.cve_id,
      packageName: alert.package_name,
      severity: alert.severity,
      createdAt: alert.created_at,
      businessDaysOpen,
      linkedIssueNumber: linkedIssue?.number,
      linkedIssueUrl: linkedIssue?.url,
      linkedPrNumber: linkedPr?.number,
      linkedPrUrl: linkedPr?.url,
      status,
    }

    console.log(
      `Alert #${alert.number} (${alert.package_name}): ${businessDaysOpen} business days, status: ${status}`
    )

    // Create breach issue if needed
    if (status === 'breached') {
      const breachKey = String(alert.number)

      if (!existingBreachKeys.has(breachKey)) {
        console.log(`Creating SLA breach issue for alert #${alert.number}...`)
        await createSLABreachIssue(octokit, owner, repo, slaAlert, slaDays)
        breachesFound++
        existingBreachKeys.add(breachKey)
      } else {
        console.log(`SLA breach issue already exists for alert #${alert.number}`)
      }
    }
  }

  console.log(`SLA tracking complete. ${breachesFound} new breach(es) reported.`)
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2)
  const slaDays = args[0] ? parseInt(args[0], 10) : 1

  const env = process.env as Record<string, string | undefined>
  const owner = env['REPO_OWNER'] || 'loureng'
  const repo = env['REPO_NAME'] || 'gitorch'
  const githubToken = env['SECURITY_PAT'] || env['GITHUB_TOKEN']

  if (!githubToken) {
    console.error('SECURITY_PAT or GITHUB_TOKEN environment variable is required')
    process.exit(1)
  }

  const octokit = new Octokit({ auth: githubToken })

  try {
    await runSLATracker(octokit, owner, repo, slaDays)
  } catch (error) {
    console.error('SLA tracker failed:', error)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
