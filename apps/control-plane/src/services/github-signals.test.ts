import { describe, it, expect, vi } from 'vitest'
import { fetchGithubSignals } from './github-signals.js'

/**
 * Sinais do GitHub para o diagnóstico grátis (F1): issues abertas, PRs parados,
 * saúde do CI. Zero LLM — só a API do GitHub com o token cifrado do usuário.
 * fetch é injetado para testar sem rede.
 */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    const key = Object.keys(routes).find((r) => u.includes(r))
    if (!key) {
      return new Response('[]', { status: 404 })
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as unknown as typeof fetch
}

describe('fetchGithubSignals', () => {
  it('agrega issues abertas (excluindo PRs), PRs parados e saúde do CI', async () => {
    const now = Date.parse('2026-07-07T00:00:00Z')
    const old = '2026-05-01T00:00:00Z' // ~67 dias -> parado
    const fresh = '2026-07-06T00:00:00Z' // 1 dia -> não parado
    const fetchImpl = fakeFetch({
      '/issues': [
        { number: 1, pull_request: undefined, updated_at: fresh },
        { number: 2, pull_request: undefined, updated_at: old },
        // item com pull_request é PR mascarado de issue -> não conta como issue
        { number: 3, pull_request: { url: 'x' }, updated_at: fresh },
      ],
      '/pulls': [
        { number: 10, updated_at: old }, // parado
        { number: 11, updated_at: fresh }, // ativo
      ],
      '/actions/runs': {
        workflow_runs: [
          { status: 'completed', conclusion: 'failure', updated_at: fresh },
          { status: 'completed', conclusion: 'success', updated_at: old },
        ],
      },
    })

    const s = await fetchGithubSignals('acme/loja', 'tok', {
      fetchImpl,
      staleDays: 30,
      now,
    })

    expect(s.openIssues).toBe(2) // só as duas issues reais, não o PR mascarado
    expect(s.openPullRequests).toBe(2)
    expect(s.stalePullRequests).toBe(1) // só o PR #10
    expect(s.ciHealth).toBe('failing') // run mais recente concluído = failure
  })

  it('CI unknown quando não há runs concluídos; degrada sem quebrar em erro de rede', async () => {
    const fetchImpl = fakeFetch({
      '/issues': [],
      '/pulls': [],
      '/actions/runs': { workflow_runs: [{ status: 'in_progress', conclusion: null }] },
    })
    const s = await fetchGithubSignals('acme/loja', 'tok', { fetchImpl, now: Date.now() })
    expect(s.openIssues).toBe(0)
    expect(s.openPullRequests).toBe(0)
    expect(s.stalePullRequests).toBe(0)
    expect(s.ciHealth).toBe('unknown')
  })
})
