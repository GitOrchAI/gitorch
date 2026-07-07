import { describe, it, expect } from 'vitest'
import { buildDiagnosisFindings } from './diagnosis-findings.js'
import type { StructuralDiagnosis } from '@gitorch/cgc'
import type { GithubSignals } from './github-signals.js'

/**
 * Veredito + achados + nota de saúde — ZERO LLM, determinístico. Achados
 * carregam uma `key` (i18n no front, nunca texto fixo em PT no backend) +
 * `data` pra interpolar. Score é uma fórmula simples e auditável, não IA.
 */
function structural(overrides: Partial<StructuralDiagnosis> = {}): StructuralDiagnosis {
  return {
    fileCount: 20,
    indexedFiles: 20,
    symbolsByType: { function: 40, class: 5 },
    largestFiles: [{ file: 'src/big.ts', symbolCount: 30 }],
    mostCalledFunctions: [{ name: 'core', file: 'src/core.ts', callCount: 12 }],
    untestedModules: [],
    directoryInventory: { src: ['a.ts', 'b.ts'] },
    ...overrides,
  }
}
function signals(overrides: Partial<GithubSignals> = {}): GithubSignals {
  return {
    openIssues: 0,
    openPullRequests: 0,
    stalePullRequests: 0,
    ciHealth: 'passing',
    ...overrides,
  }
}

describe('buildDiagnosisFindings', () => {
  it('repo saudável: score alto, achado positivo, sem achados de risco', () => {
    const r = buildDiagnosisFindings(structural(), signals())
    expect(r.healthScore).toBeGreaterThanOrEqual(80)
    expect(r.findings.some((f) => f.key === 'healthy_core' && f.severity === 'good')).toBe(true)
    expect(r.findings.some((f) => f.severity === 'bad')).toBe(false)
  })

  it('muitos módulos sem teste rebaixa o score e gera achado de risco com a proporção certa', () => {
    const s = structural({
      indexedFiles: 10,
      untestedModules: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'], // 70%
    })
    const r = buildDiagnosisFindings(s, signals())
    const f = r.findings.find((x) => x.key === 'untested_ratio')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('bad')
    expect(f!.data['untestedCount']).toBe(7)
    expect(f!.data['totalCount']).toBe(10)
    expect(f!.data['percent']).toBe(70)
    expect(r.healthScore).toBeLessThan(80)
  })

  it('CI falhando é sempre achado crítico, independente de outros fatores', () => {
    const r = buildDiagnosisFindings(structural(), signals({ ciHealth: 'failing' }))
    const f = r.findings.find((x) => x.key === 'ci_failing')
    expect(f?.severity).toBe('bad')
  })

  it('PRs parados geram achado com a contagem certa', () => {
    const r = buildDiagnosisFindings(
      structural(),
      signals({ stalePullRequests: 3, openPullRequests: 5 })
    )
    const f = r.findings.find((x) => x.key === 'stale_prs')
    expect(f?.data['staleCount']).toBe(3)
    expect(f?.data['openCount']).toBe(5)
  })

  it('score nunca sai de [0,100]', () => {
    const worst = structural({
      indexedFiles: 5,
      untestedModules: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    })
    const r = buildDiagnosisFindings(
      worst,
      signals({ ciHealth: 'failing', stalePullRequests: 20, openIssues: 50 })
    )
    expect(r.healthScore).toBeGreaterThanOrEqual(0)
    expect(r.healthScore).toBeLessThanOrEqual(100)
  })
})
