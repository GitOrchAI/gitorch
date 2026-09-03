import { describe, it, expect } from 'vitest'
import { classificarFalhaDeInfra } from './classificar-falha-de-infra.js'

const ativo = { state: 'active', ultimaRunEm: new Date().toISOString() }

describe('classificarFalhaDeInfra', () => {
  it('workflow required + push → ci-do-cliente', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/ci.yml', event: 'push', name: 'CI' },
        ativo,
        ['zero-tolerance']
      )
    ).toBe('ci-do-cliente')
  })

  it('workflow que roda em pull_request → ci-do-cliente mesmo sem estar na proteção', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/tests.yml', event: 'pull_request', name: 'Tests' },
        ativo,
        []
      )
    ).toBe('ci-do-cliente')
  })

  it('path dynamic/dependabot → dependabot-travado (o updater, não um teste)', () => {
    expect(
      classificarFalhaDeInfra(
        {
          path: 'dynamic/dependabot/dependabot-updates',
          event: 'dynamic',
          name: 'npm_and_yarn in /. - Update #1544086901',
        },
        {},
        []
      )
    ).toBe('dependabot-travado')
  })

  it('workflow instalado pelo GitOrch → scaffolding-do-gitorch', () => {
    expect(
      classificarFalhaDeInfra(
        {
          path: '.github/workflows/sla-tracker.yml',
          event: 'schedule',
          name: 'SLA Tracker for Dependabot Alerts',
        },
        ativo,
        []
      )
    ).toBe('scaffolding-do-gitorch')
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/jules-pr-monitor.yml', event: 'schedule', name: 'x' },
        ativo,
        []
      )
    ).toBe('scaffolding-do-gitorch')
  })

  it('workflow com o marcador gitorch:managed → scaffolding, mesmo sem estar na lista', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/algo-novo.yml', event: 'schedule', name: 'x' },
        ativo,
        [],
        'name: Algo\n# gitorch:managed\non:\n  schedule:'
      )
    ).toBe('scaffolding-do-gitorch')
  })

  it('workflow desativado → workflow-morto', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/old.yml', event: 'schedule', name: 'x' },
        { state: 'disabled_manually' },
        []
      )
    ).toBe('workflow-morto')
  })

  it('workflow ativo mas sem rodar há mais de 30 dias → workflow-morto', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/deploy-production.yml', event: 'push', name: 'Deploy' },
        { state: 'active', ultimaRunEm: '2026-02-07T18:06:00Z' },
        []
      )
    ).toBe('workflow-morto')
  })

  it('workflow legado que saiu da lista fixa (D62), sem marcador → NÃO é scaffolding, é ci-do-cliente', () => {
    // dependabot-to-jules.yml e auto-merge.yml existiram na lista fixa até
    // 02/09 (D62, PRs #456 e #3920) e foram removidos porque os workflows
    // legados de automação concorrente saíram dos dois repos de teste. Sem
    // o marcador `gitorch:managed`, esses nomes hoje não são reconhecidos
    // como scaffolding-do-gitorch — e é isso que se quer: se aparecerem em
    // ALGUM repositório sem o marcador, é CI do cliente, não bug nosso.
    for (const path of [
      '.github/workflows/dependabot-to-jules.yml',
      '.github/workflows/auto-merge.yml',
    ]) {
      expect(classificarFalhaDeInfra({ path, event: 'pull_request', name: 'x' }, ativo, [])).toBe(
        'ci-do-cliente'
      )
    }
  })

  it('mesmo nome legado, mas COM o marcador gitorch:managed no conteúdo → volta a ser scaffolding-do-gitorch', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/auto-merge.yml', event: 'pull_request', name: 'x' },
        ativo,
        [],
        'name: Auto Merge\n# gitorch:managed\non: pull_request'
      )
    ).toBe('scaffolding-do-gitorch')
  })

  it('workflow do cliente, ativo, fora do caminho de merge → config-de-actions', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/nightly.yml', event: 'schedule', name: 'Nightly' },
        ativo,
        ['zero-tolerance']
      )
    ).toBe('config-de-actions')
  })
})
