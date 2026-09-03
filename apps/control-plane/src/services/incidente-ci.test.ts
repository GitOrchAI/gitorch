import { describe, it, expect, vi } from 'vitest'
import {
  coletarAchadosDeInfra,
  MAX_WORKFLOWS_POR_VARREDURA,
  gatilhoDoYaml,
} from './incidente-ci.js'

/** Monta um `fetch` fake roteado por trecho de caminho (mais específico primeiro). */
function fakeFetch(rotas: Record<string, unknown>, espia?: (url: string) => void): typeof fetch {
  const ordenadas = Object.entries(rotas).sort((a, b) => b[0].length - a[0].length)
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    espia?.(url)
    for (const [chave, corpo] of ordenadas) {
      const bate =
        chave.startsWith('/repos/') &&
        !chave.includes('?') &&
        !chave.includes('/actions') &&
        !chave.includes('/branches') &&
        !chave.includes('/contents')
          ? new URL(url).pathname === chave
          : url.includes(chave)
      if (bate) {
        if (corpo === '__403__') {
          return new Response('forbidden', { status: 403 })
        }
        if (typeof corpo === 'string') {
          return new Response(corpo, { status: 200 })
        }
        return new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const REPO = 'acme/api'

describe('coletarAchadosDeInfra', () => {
  it('só o workflow cuja ÚLTIMA run falhou vira achado; o que recuperou não', async () => {
    const quandoFalhou = new Date().toISOString()
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: ['CI / build'] },
      '/actions/workflows?per_page=100': {
        workflows: [
          { id: 11, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
          { id: 22, name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'active' },
        ],
      },
      '/actions/workflows/11/runs': {
        workflow_runs: [
          { id: 900, name: 'CI', event: 'push', status: 'completed', conclusion: 'success' },
        ],
      },
      '/actions/workflows/22/runs': {
        workflow_runs: [
          {
            id: 901,
            name: 'Nightly',
            event: 'schedule',
            status: 'completed',
            conclusion: 'failure',
            run_started_at: quandoFalhou,
            html_url: 'https://github.com/acme/api/actions/runs/901',
          },
        ],
      },
      '/contents/.github/workflows/nightly.yml': {
        encoding: 'base64',
        content: Buffer.from('name: Nightly\non:\n  schedule:\n    - cron: "0 0 * * *"').toString(
          'base64'
        ),
      },
      '/actions/runs/901/jobs': {
        jobs: [{ id: 5001, conclusion: 'failure' }],
      },
      '/actions/jobs/5001/logs': 'npm ERR! missing script: build\nExit code 1',
      '/actions/runs?per_page=30': { workflow_runs: [] },
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })

    expect(achados).toHaveLength(1)
    expect(achados[0]?.identidadeEstavel).toBe('wf:22')
    expect(achados[0]?.classe).toBe('config-de-actions') // schedule, ativo, fora do gate
    expect(achados[0]?.travaMerge).toBe(false)
    expect(achados[0]?.evidencia).toContain('missing script: build')
    expect(achados[0]?.evidencia).toContain('cron')
    expect(achados[0]?.paths).toEqual(['.github/workflows/nightly.yml'])
    // A1 (fix-up L4-T2): campos estruturados — nada de regex no título
    // (nomeEArquivoDoAchado, removido do scheduler).
    expect(achados[0]?.nomeDoWorkflow).toBe('Nightly')
    expect(achados[0]?.arquivo).toBe('.github/workflows/nightly.yml')
    expect(achados[0]?.gatilho).toBe('schedule')
    expect(achados[0]?.falhaDesde).toBe(quandoFalhou)
  })

  // A1 (fix-up L4-T2): `falhaDesde` cai para `created_at` quando a run não
  // carrega `run_started_at`.
  it('falhaDesde usa created_at quando a run não tem run_started_at', async () => {
    const criadoEm = '2026-08-15T10:00:00Z'
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: [] },
      '/actions/workflows?per_page=100': {
        workflows: [{ id: 50, name: 'X', path: '.github/workflows/x.yml', state: 'active' }],
      },
      '/actions/workflows/50/runs': {
        workflow_runs: [
          {
            id: 970,
            name: 'X',
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            created_at: criadoEm,
          },
        ],
      },
      '/contents/.github/workflows/x.yml': {
        encoding: 'base64',
        content: Buffer.from('name: X\non: push').toString('base64'),
      },
      '/actions/runs/970/jobs': { jobs: [] },
      '/actions/runs?per_page=30': { workflow_runs: [] },
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })
    expect(achados[0]?.falhaDesde).toBe(criadoEm)
    expect(achados[0]?.gatilho).toBe('push')
  })

  it('workflow que roda no gate (push) e falhou → ci-do-cliente + travaMerge', async () => {
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': '__403__',
      '/actions/workflows?per_page=100': {
        workflows: [
          { id: 30, name: 'Tests', path: '.github/workflows/tests.yml', state: 'active' },
        ],
      },
      '/actions/workflows/30/runs': {
        workflow_runs: [
          {
            id: 950,
            name: 'Tests',
            event: 'pull_request',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
      '/contents/.github/workflows/tests.yml': {
        encoding: 'base64',
        content: Buffer.from('name: Tests').toString('base64'),
      },
      '/actions/runs/950/jobs': { jobs: [] },
      '/actions/runs?per_page=30': { workflow_runs: [] },
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })
    expect(achados).toHaveLength(1)
    expect(achados[0]?.classe).toBe('ci-do-cliente')
    expect(achados[0]?.travaMerge).toBe(true)
  })

  it('workflow instalado pelo GitOrch que falhou → scaffolding-do-gitorch', async () => {
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: [] },
      '/actions/workflows?per_page=100': {
        workflows: [
          {
            id: 40,
            name: 'Dependabot → Jules',
            path: '.github/workflows/dependabot-to-jules.yml',
            state: 'active',
          },
        ],
      },
      '/actions/workflows/40/runs': {
        workflow_runs: [
          {
            id: 960,
            name: 'Dependabot → Jules',
            event: 'schedule',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
      '/contents/.github/workflows/dependabot-to-jules.yml': {
        encoding: 'base64',
        content: Buffer.from('name: x').toString('base64'),
      },
      '/actions/runs/960/jobs': { jobs: [] },
      '/actions/runs?per_page=30': { workflow_runs: [] },
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })
    expect(achados).toHaveLength(1)
    expect(achados[0]?.classe).toBe('scaffolding-do-gitorch')
  })

  it('o job do Dependabot que falhou vira um achado dependabot:updates', async () => {
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: [] },
      '/actions/workflows?per_page=100': { workflows: [] },
      '/actions/runs?per_page=30': {
        workflow_runs: [
          {
            id: 12,
            name: 'npm_and_yarn in /. - Update #1544086901',
            path: 'dynamic/dependabot/dependabot-updates',
            status: 'completed',
            conclusion: 'failure',
            created_at: '2026-08-29T10:00:00Z',
            html_url: 'https://github.com/acme/api/actions/runs/12',
          },
        ],
      },
      '/contents/.github/dependabot.yml': {
        encoding: 'base64',
        content: Buffer.from('version: 2\nupdates:\n  - package-ecosystem: npm').toString('base64'),
      },
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })
    expect(achados).toHaveLength(1)
    expect(achados[0]?.identidadeEstavel).toBe('dependabot:updates')
    expect(achados[0]?.classe).toBe('dependabot-travado')
    expect(achados[0]?.evidencia).toContain('package-ecosystem: npm')
    // A1 (fix-up L4-T2): campos fixos para o achado do Dependabot.
    expect(achados[0]?.nomeDoWorkflow).toBe('Dependabot Updates')
    expect(achados[0]?.arquivo).toBe('.github/dependabot.yml')
    expect(achados[0]?.gatilho).toBe('dependabot')
    expect(achados[0]?.falhaDesde).toBe('2026-08-29T10:00:00Z')
  })

  it('Dependabot sem .github/dependabot.yml legível → achado sai sem `arquivo`', async () => {
    const f = fakeFetch({
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: [] },
      '/actions/workflows?per_page=100': { workflows: [] },
      '/actions/runs?per_page=30': {
        workflow_runs: [
          {
            id: 13,
            name: 'npm_and_yarn in /. - Update #2',
            path: 'dynamic/dependabot/dependabot-updates',
            status: 'completed',
            conclusion: 'failure',
            created_at: '2026-08-29T10:00:00Z',
          },
        ],
      },
      '/contents/.github/dependabot.yml': '__403__',
    })

    const achados = await coletarAchadosDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: f,
    })
    expect(achados).toHaveLength(1)
    expect(achados[0]?.arquivo).toBeUndefined()
    expect(achados[0]?.nomeDoWorkflow).toBe('Dependabot Updates')
    expect(achados[0]?.gatilho).toBe('dependabot')
  })

  it('NUNCA faz POST — o sensor não abre issue (real-seam)', async () => {
    const metodos: string[] = []
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      metodos.push((init?.method ?? 'GET').toUpperCase())
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes(`/repos/${REPO}`) && url.endsWith(`/repos/${REPO}`)) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      }
      if (url.includes('/actions/workflows?per_page=100')) {
        return new Response(JSON.stringify({ workflows: [] }), { status: 200 })
      }
      if (url.includes('/actions/runs?per_page=30')) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await coletarAchadosDeInfra({ repository: REPO, githubToken: 't', fetchImpl: f })
    expect(metodos.every((m) => m === 'GET')).toBe(true)
  })

  it('recusa repository fora do formato dono/repo sem tocar a rede', async () => {
    const f = vi.fn()
    const achados = await coletarAchadosDeInfra({
      repository: 'https://evil.example/x',
      githubToken: 't',
      fetchImpl: f as unknown as typeof fetch,
    })
    expect(achados).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  // Endurecimento (ESTEIRA-T8): a função é alcançável pelo tique sob
  // tickEmAndamento. Um repo com dezenas de workflows não pode virar dezenas
  // de chamadas sequenciais — corta em MAX_WORKFLOWS_POR_VARREDURA e roda as
  // checagens de "última run" em lotes paralelos.
  it('workflows acima do teto não são conferidos (protege o tique)', async () => {
    const workflows = Array.from({ length: MAX_WORKFLOWS_POR_VARREDURA + 15 }, (_, i) => ({
      id: 1000 + i,
      name: `WF ${i}`,
      path: `.github/workflows/wf-${i}.yml`,
      state: 'active',
    }))
    const conferidos = new Set<number>()
    const f = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (new URL(url).pathname === `/repos/${REPO}`) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      }
      if (url.includes('/actions/workflows?per_page=100')) {
        return new Response(JSON.stringify({ workflows }), { status: 200 })
      }
      const m = url.match(/\/actions\/workflows\/(\d+)\/runs/)
      if (m) {
        conferidos.add(Number(m[1]))
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { id: 1, name: 'x', event: 'push', status: 'completed', conclusion: 'success' },
            ],
          }),
          { status: 200 }
        )
      }
      if (url.includes('/actions/runs?per_page=30')) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await coletarAchadosDeInfra({ repository: REPO, githubToken: 't', fetchImpl: f })
    expect(conferidos.size).toBe(MAX_WORKFLOWS_POR_VARREDURA)
  })
})

// A1 (fix-up L4-T2): parse simples por linhas do `on:` do YAML — sem lib de
// YAML nova. Cobre os 3 formatos comuns que aparecem em workflow de verdade.
describe('gatilhoDoYaml', () => {
  it('escalar: on: push', () => {
    expect(gatilhoDoYaml('name: X\non: push\njobs: {}')).toBe('push')
  })

  it('lista: on: [push, pull_request]', () => {
    expect(gatilhoDoYaml('name: X\non: [push, pull_request]\njobs: {}')).toBe('push, pull_request')
  })

  it('mapeamento: on:\\n  push:\\n  pull_request:\\n    branches: [main]', () => {
    const yaml = [
      'name: X',
      'on:',
      '  push:',
      '  pull_request:',
      '    branches: [main]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
    ].join('\n')
    expect(gatilhoDoYaml(yaml)).toBe('push, pull_request')
  })

  it('mapeamento com um só gatilho e sub-chaves', () => {
    const yaml = ['on:', '  schedule:', '    - cron: "0 0 * * *"'].join('\n')
    expect(gatilhoDoYaml(yaml)).toBe('schedule')
  })

  it('sem on: → undefined', () => {
    expect(gatilhoDoYaml('name: X\njobs: {}')).toBeUndefined()
  })

  it('yaml vazio → undefined', () => {
    expect(gatilhoDoYaml('')).toBeUndefined()
  })
})
