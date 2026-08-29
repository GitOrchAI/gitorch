import { describe, it, expect } from 'vitest'
import { acharIncidentesDeInfra, runIncidentSensor } from './incident-sensor.js'

/**
 * `fetch` fake: roteia por trecho de caminho (mais específico primeiro) e
 * REGISTRA todo método usado — nenhuma rota de POST é servida de propósito,
 * para provar que o sensor não abre issue (D54).
 */
function fakeFetch(rotas: Record<string, unknown>, metodos: string[] = []): typeof fetch {
  const ordenadas = Object.entries(rotas).sort((a, b) => b[0].length - a[0].length)
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    metodos.push((init?.method ?? 'GET').toUpperCase())
    for (const [chave, corpo] of ordenadas) {
      const bate =
        chave.startsWith('/repos/') &&
        !chave.includes('/actions') &&
        !chave.includes('/branches') &&
        !chave.includes('/contents')
          ? new URL(url).pathname === chave
          : url.includes(chave)
      if (bate) {
        if (corpo === '__403__') return new Response('no', { status: 403 })
        return new Response(JSON.stringify(corpo), { status: 200 })
      }
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const REPO = 'acme/api'

const cenarioComUmAchado = (): Record<string, unknown> => ({
  [`/repos/${REPO}`]: { default_branch: 'main' },
  '/branches/main/protection/required_status_checks': { contexts: ['CI'] },
  '/actions/workflows?per_page=100': {
    workflows: [{ id: 7, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
  },
  '/actions/workflows/7/runs': {
    workflow_runs: [
      { id: 70, name: 'CI', event: 'push', status: 'completed', conclusion: 'failure' },
    ],
  },
  '/contents/.github/workflows/ci.yml': {
    encoding: 'base64',
    content: Buffer.from('name: CI').toString('base64'),
  },
  '/actions/runs/70/jobs': { jobs: [] },
  '/actions/runs?per_page=30': { workflow_runs: [] },
})

describe('acharIncidentesDeInfra', () => {
  it('devolve achados tipados e um resumo por classe — sem abrir issue', async () => {
    const metodos: string[] = []
    const r = await acharIncidentesDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: fakeFetch(cenarioComUmAchado(), metodos),
    })
    expect(r.noOp).toBe(false)
    expect(r.achados).toHaveLength(1)
    expect(r.achados[0]?.classe).toBe('ci-do-cliente')
    expect(r.achados[0]?.identidadeEstavel).toBe('wf:7')
    expect(r.output).toContain('ci-do-cliente')
    expect(r.output).toContain('nenhuma issue aberta aqui')
    // real-seam: zero POST
    expect(metodos.every((m) => m === 'GET')).toBe(true)
  })

  it('nada quebrado → noOp', async () => {
    const r = await acharIncidentesDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: fakeFetch({
        [`/repos/${REPO}`]: { default_branch: 'main' },
        '/actions/workflows?per_page=100': { workflows: [] },
        '/actions/runs?per_page=30': { workflow_runs: [] },
      }),
    })
    expect(r.noOp).toBe(true)
    expect(r.achados).toEqual([])
    expect(r.output).toContain('nada quebrado')
  })

  it('erro de rede na coleta → noOp, best-effort (nunca joga)', async () => {
    const fBomba = (async () => {
      throw new Error('rede caiu')
    }) as typeof fetch
    const r = await acharIncidentesDeInfra({
      repository: REPO,
      githubToken: 't',
      fetchImpl: fBomba,
      onWarn: () => undefined,
    })
    expect(r.achados).toEqual([])
    expect(r.noOp).toBe(true)
  })
})

describe('runIncidentSensor (@deprecated)', () => {
  it('nunca cria issue: created é sempre []', async () => {
    const metodos: string[] = []
    const r = await runIncidentSensor({
      repository: REPO,
      githubToken: 't',
      fetchImpl: fakeFetch(cenarioComUmAchado(), metodos),
    })
    expect(r.created).toEqual([])
    expect(r.achados).toHaveLength(1)
    expect(metodos.every((m) => m === 'GET')).toBe(true)
  })

  it('mapeia cap → teto', async () => {
    const cenario: Record<string, unknown> = {
      [`/repos/${REPO}`]: { default_branch: 'main' },
      '/branches/main/protection/required_status_checks': { contexts: [] },
      '/actions/workflows?per_page=100': {
        workflows: [
          { id: 1, name: 'A', path: '.github/workflows/a.yml', state: 'active' },
          { id: 2, name: 'B', path: '.github/workflows/b.yml', state: 'active' },
          { id: 3, name: 'C', path: '.github/workflows/c.yml', state: 'active' },
        ],
      },
      '/actions/runs?per_page=30': { workflow_runs: [] },
    }
    for (const id of [1, 2, 3]) {
      cenario[`/actions/workflows/${id}/runs`] = {
        workflow_runs: [
          { id: id * 10, name: 'x', event: 'schedule', status: 'completed', conclusion: 'failure' },
        ],
      }
      cenario[`/contents/.github/workflows/${String.fromCharCode(96 + id)}.yml`] = {
        encoding: 'base64',
        content: Buffer.from('name: x').toString('base64'),
      }
      cenario[`/actions/runs/${id * 10}/jobs`] = { jobs: [] }
    }
    const r = await runIncidentSensor({
      repository: REPO,
      githubToken: 't',
      cap: 2,
      fetchImpl: fakeFetch(cenario),
    })
    expect(r.achados).toHaveLength(2)
  })
})
