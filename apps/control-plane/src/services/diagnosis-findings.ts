import type { StructuralDiagnosis } from '@gitorch/cgc'
import type { GithubSignals } from './github-signals.js'

/**
 * Veredito zero-LLM do diagnóstico grátis (F1). `key` é o texto que o FRONT
 * traduz via t() (pt/en/es) — o backend nunca embute frase fixa em um idioma;
 * `data` são os números pra interpolar no template localizado.
 */
export type FindingSeverity = 'good' | 'warn' | 'bad'

export interface DiagnosisFinding {
  key: 'healthy_core' | 'untested_ratio' | 'stale_prs' | 'ci_failing' | 'open_issues'
  severity: FindingSeverity
  data: Record<string, number>
}

export interface DiagnosisFindingsResult {
  healthScore: number
  findings: DiagnosisFinding[]
}

const clampScore = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

export function buildDiagnosisFindings(
  structural: StructuralDiagnosis,
  github: GithubSignals
): DiagnosisFindingsResult {
  const findings: DiagnosisFinding[] = []
  let score = 100

  const totalCount = structural.indexedFiles
  const untestedCount = structural.untestedModules.length
  const percent = totalCount > 0 ? Math.round((untestedCount / totalCount) * 100) : 0

  if (totalCount > 0 && percent >= 40) {
    findings.push({
      key: 'untested_ratio',
      severity: percent >= 60 ? 'bad' : 'warn',
      data: { untestedCount, totalCount, percent },
    })
    score -= percent >= 60 ? 25 : 12
  }

  if (github.ciHealth === 'failing') {
    findings.push({ key: 'ci_failing', severity: 'bad', data: {} })
    score -= 20
  }

  if (github.stalePullRequests > 0) {
    findings.push({
      key: 'stale_prs',
      severity: github.stalePullRequests >= 3 ? 'bad' : 'warn',
      data: { staleCount: github.stalePullRequests, openCount: github.openPullRequests },
    })
    score -= Math.min(20, github.stalePullRequests * 5)
  }

  if (github.openIssues >= 10) {
    findings.push({
      key: 'open_issues',
      severity: github.openIssues >= 30 ? 'bad' : 'warn',
      data: { openIssues: github.openIssues },
    })
    score -= github.openIssues >= 30 ? 15 : 8
  }

  // Achado positivo: nenhum sinal ruim disparou -> reforça confiança (Ethos).
  if (findings.every((f) => f.severity !== 'bad')) {
    findings.push({
      key: 'healthy_core',
      severity: 'good',
      data: { fileCount: structural.fileCount },
    })
  }

  return { healthScore: clampScore(score), findings }
}
