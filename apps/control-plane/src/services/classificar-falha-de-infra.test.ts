import { describe, it, expect } from 'vitest'
import { classificarFalhaDeInfra, ehAutomacaoDoCliente } from './classificar-falha-de-infra.js'

const ativo = { state: 'active', ultimaRunEm: new Date().toISOString() }

// L4-T2 (D63): os 17 nomes reais medidos nas 97 sessões que foram para
// incidente de automação — 6 do gitorch, 11 do patinhas. TODOS já caem em
// `ehScaffoldingDoGitorch` (lista fixa/prefixo jules-*), então isto testa a
// função PURA `ehAutomacaoDoCliente` isoladamente: é o sinal que vale para um
// workflow do MESMO formato num repositório novo, ainda sem entrar na lista
// fixa de scaffolding.
const NOMES_DE_AUTOMACAO_MEDIDOS = [
  // GitOrchAI/gitorch
  'code-scanning-to-jules.yml',
  'dependabot-to-jules.yml',
  'jules-apology-handler.yml',
  'jules-auto-recovery.yml',
  'jules-pr-ci-failure.yml',
  'jules-pr-conflict.yml',
  // loureng/patinhas-3d-crafts
  'dependabot-alert-to-issue.yml',
  'ci-failure-handler.yml',
  'cd-failure-handler.yml',
  'auto-merge-monitor.yml',
  'jules-pr-monitor.yml',
  'jules-api-retry.yml',
  'jules-auto-merge.yml',
  'jules-ci-failure-fix.yml',
  'jules-merge-conflict-fix.yml',
  'jules-conflict-resolver.yml',
  'jules-pr-labeler.yml',
]

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

  // L4-T2 (D63): "o dono não quer o Jules consertando o robô do Jules" — para
  // automações FUTURAS/de outros clientes que ainda não estão na lista fixa
  // de scaffolding nem carregam o marcador, o produto não abre incidente P0,
  // abre proposta. A ordem importa: DEPOIS de scaffolding-do-gitorch, ANTES
  // de ci-do-cliente — mesmo rodando em push/pull_request.
  it('workflow de automação novo (não listado, sem marcador) → automacao, mesmo em push', () => {
    expect(
      classificarFalhaDeInfra(
        {
          path: '.github/workflows/auto-merge-checker.yml',
          event: 'push',
          name: 'Auto Merge Checker',
        },
        ativo,
        ['zero-tolerance']
      )
    ).toBe('automacao')
  })

  it('dependabot-automation.yml COM marcador gitorch:managed → scaffolding-do-gitorch, não automacao', () => {
    expect(
      classificarFalhaDeInfra(
        { path: '.github/workflows/dependabot-automation.yml', event: 'schedule', name: 'x' },
        ativo,
        [],
        'name: x\n# gitorch:managed\non:\n  schedule:'
      )
    ).toBe('scaffolding-do-gitorch')
  })
})

describe('ehAutomacaoDoCliente', () => {
  it('os 17 nomes reais medidos (basename) → true', () => {
    for (const arquivo of NOMES_DE_AUTOMACAO_MEDIDOS) {
      expect(ehAutomacaoDoCliente('x', `.github/workflows/${arquivo}`)).toBe(true)
    }
  })

  it('casa também pelo `nome` de exibição, não só pelo caminho', () => {
    expect(ehAutomacaoDoCliente('Dependabot → Jules', '.github/workflows/algo.yml')).toBe(true)
    expect(ehAutomacaoDoCliente('Auto-merge do PR', '.github/workflows/algo.yml')).toBe(true)
  })

  it('ci.yml, cd.yml, tests.yml, deploy.yml → NÃO automação', () => {
    for (const arquivo of ['ci.yml', 'cd.yml', 'tests.yml', 'deploy.yml']) {
      expect(ehAutomacaoDoCliente('x', `.github/workflows/${arquivo}`)).toBe(false)
    }
  })
})
