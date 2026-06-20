import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const reports = [
  'ci/audit/CGC_GRAPH_INCONSISTENCIES.md',
  'ci/audit/CGC_CALL_GRAPH_AUDIT_REPORT.md',
  'ci/audit/readme-code-parity.json',
  'ci/audit/impact-radius.json',
  'ci/audit/gitleaks-report.json',
  'ci/audit/pheromones/secret-scan.json',
  'ci/audit/pheromones/blocked.json',
]

type SummaryEntry = {
  path: string
  status: string
}

const entries: SummaryEntry[] = []
let blocked = false

for (const report of reports) {
  if (!existsSync(report)) {
    throw new Error(`Missing required audit report: ${report}`)
  }

  const content = readFileSync(report, 'utf8')
  const status = extractStatus(content)
  entries.push({ path: report, status })

  if (status === 'blocked' || status === 'FAIL') {
    blocked = true
  }
}

const summary = {
  reports: entries,
  status: blocked ? 'BLOCKED' : 'PASS',
  timestamp: new Date().toISOString(),
}

mkdirSync('ci/audit', { recursive: true })
writeFileSync(join('ci/audit', 'audit-summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(
  join('ci/audit', 'CI_AUDIT_SUMMARY.md'),
  [
    '# CI Audit Summary',
    '',
    `Status: ${summary.status}`,
    '',
    ...entries.map((entry) => `- ${entry.path}: ${entry.status}`),
    '',
  ].join('\n')
)

if (blocked) {
  process.exit(1)
}

function extractStatus(content: string): string {
  try {
    const parsed = JSON.parse(content) as { status?: string }
    return typeof parsed.status === 'string' ? parsed.status : 'present'
  } catch {
    const markdownStatus = content.match(/Status:\s*([^\n]+)/i)
    return markdownStatus ? markdownStatus[1].trim() : 'present'
  }
}
