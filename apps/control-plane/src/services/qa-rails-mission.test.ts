import { describe, it, expect } from 'vitest'
import { runQaMissionViaRails, buildJulesReworkComment } from './qa-rails-mission.js'

const APPROVE = JSON.stringify({
  verdict: 'approve',
  comment: {
    titulo: 'Reviews API',
    description: 'PR entrega os endpoints.',
    notes: 'CI verde.',
    implementationGuide: 'n/a',
    verificationCriteria: '- GET /reviews retorna lista: OK\n- POST valida compra: OK',
    summary: 'Todos os critérios atendidos.',
    analysisResult: 'Diff cobre schema+rota+teste.',
    relatedFiles: 'src/reviews.ts',
  },
})

const REQUEST_CHANGES = JSON.stringify({
  verdict: 'request_changes',
  comment: {
    titulo: 'Faltou validação',
    description: 'POST /reviews não valida material.',
    notes: 'CI vermelho no unit-test.',
    implementationGuide: '1. validar body; 2. teste do caso inválido',
    verificationCriteria: '- retornar 400 para material inexistente',
    summary: 'Rework necessário.',
    analysisResult: 'Sem checagem de material no controller.',
    relatedFiles: 'src/reviews.ts',
  },
})

function fakeFetch(prs: Array<{ number: number; user: string }>): typeof fetch {
  const posted: { reviews: unknown[]; comments: unknown[] } = { reviews: [], comments: [] }
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

    if (u.includes('/pulls?')) {
      return json(prs.map((p) => ({ number: p.number, user: { login: p.user }, draft: false })))
    }
    if (/\/pulls\/\d+$/.test(u.split('?')[0]!)) {
      return json({ number: 1, body: 'Closes #50', head: { sha: 'abc123' } })
    }
    if (u.includes('/issues/50')) {
      return json({
        number: 50,
        body: '## Verification Criteria\n\n- GET /reviews retorna lista\n- POST valida compra',
      })
    }
    if (u.includes('/commits/') && u.includes('/check-runs')) {
      return json({ check_runs: [{ name: 'ci', conclusion: 'success', status: 'completed' }] })
    }
    if (u.match(/\/pulls\/\d+\/files/))
      return json([{ filename: 'src/reviews.ts', patch: '+code' }])
    if (u.match(/\/issues\/\d+\/comments/) && method === 'GET') return json([]) // sem marker
    if (u.match(/\/pulls\/\d+\/reviews/) && method === 'POST') {
      posted.reviews.push(body)
      return json({ id: 1 })
    }
    if (u.match(/\/issues\/\d+\/comments/) && method === 'POST') {
      posted.comments.push(body)
      return json({ id: 1 })
    }
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { posted: typeof posted }).posted = posted
  return impl
}

describe('buildJulesReworkComment', () => {
  it('menciona @jules e traz os 8 campos', () => {
    const c = buildJulesReworkComment(JSON.parse(REQUEST_CHANGES).comment)
    expect(c).toContain('@jules')
    expect(c).toContain('## Verification Criteria')
    expect(c).toContain('material')
  })
})

describe('runQaMissionViaRails', () => {
  it('sem PR do Jules pendente: no-op', async () => {
    const f = fakeFetch([])
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBe(true)
  })

  it('approve: posta review APPROVE, sem comentário @jules', async () => {
    const f = fakeFetch([{ number: 7, user: 'google-labs-jules[bot]' }])
    const posted = (
      f as unknown as {
        posted: { reviews: Array<{ event?: string }>; comments: Array<{ body?: string }> }
      }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(posted.reviews[0]!.event).toBe('APPROVE')
    expect(posted.comments).toHaveLength(0)
  })

  it('request_changes: posta REQUEST_CHANGES + comentário @jules', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }])
    const posted = (
      f as unknown as {
        posted: { reviews: Array<{ event?: string }>; comments: Array<{ body?: string }> }
      }
    ).posted
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(posted.comments[0]!.body).toContain('@jules')
  })
})
