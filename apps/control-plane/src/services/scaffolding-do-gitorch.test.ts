import { describe, it, expect } from 'vitest'
import { ehScaffoldingDoGitorch, MARCADOR_SCAFFOLDING } from './scaffolding-do-gitorch.js'

describe('ehScaffoldingDoGitorch', () => {
  it('reconhece pelo marcador no conteúdo do workflow (o jeito certo)', () => {
    expect(
      ehScaffoldingDoGitorch(
        '.github/workflows/qualquer-nome.yml',
        `name: X\n# ${MARCADOR_SCAFFOLDING}\non: push`
      )
    ).toBe(true)
  })

  it('reconhece os workflows que o GitOrch já instalou nos dois repos de teste', () => {
    for (const base of ['sla-tracker.yml', 'dependabot-automation.yml', 'cleanup-artifacts.yml']) {
      expect(ehScaffoldingDoGitorch(`.github/workflows/${base}`)).toBe(true)
    }
  })

  it('reconhece qualquer jules-*.yml por convenção', () => {
    expect(ehScaffoldingDoGitorch('.github/workflows/jules-pr-monitor.yml')).toBe(true)
    expect(ehScaffoldingDoGitorch('.github/workflows/jules-inventado-amanha.yaml')).toBe(true)
  })

  it('workflows legados removidos (D62, 02/09) saem da lista fixa → false, salvo jules-*', () => {
    // Não existem mais nos repos de teste: os workflows legados foram
    // removidos (D62). A lista fixa encolheu para o que existe hoje.
    for (const base of [
      'dependabot-to-jules.yml',
      'code-scanning-to-jules.yml',
      'ci-failure-handler.yml',
      'cd-failure-handler.yml',
      'dependabot-alert-to-issue.yml',
      'auto-merge.yml',
      'auto-merge-monitor.yml',
    ]) {
      expect(ehScaffoldingDoGitorch(`.github/workflows/${base}`)).toBe(false)
    }
    // Exceção: `jules-pr-monitor.yml` saiu da lista fixa mas continua `true`
    // porque cai na convenção `jules-*.yml`, testada pela regex, não pela lista.
    expect(ehScaffoldingDoGitorch('.github/workflows/jules-pr-monitor.yml')).toBe(true)
  })

  it('NÃO marca o CI real do cliente como scaffolding', () => {
    expect(ehScaffoldingDoGitorch('.github/workflows/ci.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/tests.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/deploy.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/ci.yml', 'name: CI\non: [push]')).toBe(false)
  })
})
