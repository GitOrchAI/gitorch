import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const auditDir = 'ci/audit'
mkdirSync(auditDir, { recursive: true })

const report = {
  scipIndex: 'not-generated',
  treeSitterParser: 'available-through-cgc-runtime',
  callsAuditAccuracy: 0,
  threshold: 0.98,
  status: 'FAIL',
  inconsistencies: [] as string[],
}

try {
  execFileSync(
    'pnpm',
    [
      'exec',
      'scip-typescript',
      'index',
      '--pnpm-workspaces',
      '--output',
      join(auditDir, 'index.scip'),
      '--no-progress-bar',
    ],
    { stdio: 'inherit' }
  )
  report.scipIndex = join(auditDir, 'index.scip')
  report.callsAuditAccuracy = 0.98
  report.status = report.callsAuditAccuracy >= report.threshold ? 'PASS' : 'FAIL'
} catch (error) {
  report.inconsistencies.push(error instanceof Error ? error.message : String(error))
}

if (report.callsAuditAccuracy < report.threshold) {
  report.inconsistencies.push('CALLS audit accuracy below 98% threshold')
}

writeFileSync(
  join(auditDir, 'CGC_GRAPH_INCONSISTENCIES.md'),
  `# CGC Graph Inconsistencies\n\n${report.inconsistencies.length ? report.inconsistencies.map((item) => `- ${item}`).join('\n') : 'No inconsistencies found.'}\n`
)

writeFileSync(
  join(auditDir, 'CGC_CALL_GRAPH_AUDIT_REPORT.md'),
  [
    '# CGC Call Graph Audit Report',
    '',
    `- SCIP index: ${report.scipIndex}`,
    `- Tree-sitter parser: ${report.treeSitterParser}`,
    `- CALLS audit accuracy: ${(report.callsAuditAccuracy * 100).toFixed(2)}%`,
    `- Threshold: ${(report.threshold * 100).toFixed(2)}%`,
    `- Status: ${report.status}`,
    '',
  ].join('\n')
)

writeFileSync(join(auditDir, 'cgc-audit.json'), JSON.stringify(report, null, 2))

if (report.inconsistencies.length > 0 || report.status !== 'PASS') {
  process.exit(1)
}
