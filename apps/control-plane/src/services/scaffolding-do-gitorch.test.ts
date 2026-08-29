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
    for (const base of [
      'auto-merge.yml',
      'code-scanning-to-jules.yml',
      'dependabot-to-jules.yml',
      'sla-tracker.yml',
      'dependabot-automation.yml',
      'dependabot-alert-to-issue.yml',
      'ci-failure-handler.yml',
      'cd-failure-handler.yml',
      'auto-merge-monitor.yml',
      'cleanup-artifacts.yml',
    ]) {
      expect(ehScaffoldingDoGitorch(`.github/workflows/${base}`)).toBe(true)
    }
  })

  it('reconhece qualquer jules-*.yml por convenção', () => {
    expect(ehScaffoldingDoGitorch('.github/workflows/jules-pr-monitor.yml')).toBe(true)
    expect(ehScaffoldingDoGitorch('.github/workflows/jules-inventado-amanha.yaml')).toBe(true)
  })

  it('NÃO marca o CI real do cliente como scaffolding', () => {
    expect(ehScaffoldingDoGitorch('.github/workflows/ci.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/tests.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/deploy.yml')).toBe(false)
    expect(ehScaffoldingDoGitorch('.github/workflows/ci.yml', 'name: CI\non: [push]')).toBe(false)
  })
})
