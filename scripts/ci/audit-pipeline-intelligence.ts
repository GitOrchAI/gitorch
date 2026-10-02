import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkflowYaml } from '../../packages/pipeline-core/src/adapters/github/parser.js'
import { profileWorkload } from '../../packages/pipeline-intelligence/src/profiler/index.js'
import { assessPipelineRisks } from '../../packages/pipeline-intelligence/src/risk-engine/engine.js'

export interface AuditReport {
  score: number
  coveredCapabilities: string[]
  missingCapabilities: string[]
  findings: Array<{
    id: string
    severity: string
    title?: string
    description?: string
  }>
  recommendedStages: string[]
  timestamp: string
  compliant: boolean
}

export function runPipelineAudit(repoRoot = process.cwd()): AuditReport {
  const filePaths = [
    'package.json',
    'pnpm-workspace.yaml',
    'vitest.config.ts',
    'apps/control-plane/prisma/schema.prisma',
  ]

  const files = filePaths.map((p) => {
    try {
      return { path: p, content: readFileSync(join(repoRoot, p), 'utf8') }
    } catch {
      return { path: p, content: '' }
    }
  })

  const profile = profileWorkload(files)

  const ciPath = join(repoRoot, '.github/workflows/ci.yml')
  const ciContent = readFileSync(ciPath, 'utf8')
  const ir = parseWorkflowYaml(ciContent, 'ci.yml')

  const assessment = assessPipelineRisks(ir, profile)
  const compliant = assessment.score >= 80

  const report: AuditReport = {
    score: assessment.score,
    coveredCapabilities: assessment.coveredCapabilities,
    missingCapabilities: assessment.missingCapabilities,
    findings: assessment.findings,
    recommendedStages: assessment.recommendedStages,
    timestamp: new Date().toISOString(),
    compliant,
  }

  return report
}

export function writeAuditReport(report: AuditReport, repoRoot = process.cwd()): void {
  const auditDir = join(repoRoot, 'ci/audit')
  mkdirSync(auditDir, { recursive: true })
  writeFileSync(
    join(auditDir, 'pipeline-intelligence-audit.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  )
}

if (import.meta.url.endsWith(process.argv[1] || '')) {
  console.log('Executando auditoria do Pipeline Intelligence no repositorio GitOrch...')
  const report = runPipelineAudit()
  writeAuditReport(report)
  console.log('Score do Pipeline: ' + report.score + '/100 | Compliant: ' + report.compliant)
  console.log('Capacidades cobertas: ' + report.coveredCapabilities.join(', '))
  if (!report.compliant) {
    console.error('Pipeline nao atende aos requisitos minimos de governanca (Score < 80)')
    console.error('Gaps encontrados:', report.findings)
    process.exit(1)
  }
  console.log('Auditoria de Pipeline Intelligence concluida com sucesso!')
}
