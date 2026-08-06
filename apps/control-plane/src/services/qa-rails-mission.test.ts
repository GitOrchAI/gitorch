import { describe, it, expect } from 'vitest'
import { runQaMissionViaRails, buildJulesReworkComment } from './qa-rails-mission.js'
import { assertMissionDelivered } from './mission-outcome.js'

const RECON = JSON.stringify({
  ci: 'GitHub Actions (.github/workflows/ci.yml) — roda lint, typecheck e testes por workspace.',
  testSuites: ['vitest (unit, apps/control-plane)', 'vitest (unit, packages/cadence)'],
  coverageExpectation: 'todo arquivo de serviço novo ganha *.test.ts equivalente antes do merge.',
  criticalPaths: [
    'apps/control-plane/src/plugins/scheduler.ts (encadeamento de missões)',
    'apps/control-plane/src/services/qa-rails-mission.ts (veredito do QA)',
  ],
})

const APPROVE = JSON.stringify({
  verdict: 'approve',
  comment: {
    titulo: 'Reviews API',
    goal: 'Todos os critérios atendidos.',
    taskDetails: 'Diff cobre schema+rota+teste.',
    taskDescription: 'PR entrega os endpoints.',
    implementationGuide: 'n/a',
    verificationCriteria: '- GET /reviews retorna lista: OK\n- POST valida compra: OK',
    dependencies: 'nenhuma',
    relatedFiles: 'src/reviews.ts',
    notes: 'CI verde.',
  },
})

const REQUEST_CHANGES = JSON.stringify({
  verdict: 'request_changes',
  comment: {
    titulo: 'Faltou validação',
    goal: 'Rework necessário.',
    taskDetails: 'Sem checagem de material no controller.',
    taskDescription: 'POST /reviews não valida material.',
    implementationGuide: '1. validar body; 2. teste do caso inválido',
    verificationCriteria: '- retornar 400 para material inexistente',
    dependencies: 'nenhuma',
    relatedFiles: 'src/reviews.ts',
    notes: 'CI vermelho no unit-test.',
  },
})

function fakeFetch(
  prs: Array<{
    number: number
    user: string
    existingReviews?: Array<{ body: string; commit_id: string }>
  }>,
  issueLabels: string[] = ['jules', 'gitorch:task']
): typeof fetch {
  const posted: { reviews: unknown[]; comments: unknown[] } = { reviews: [], comments: [] }
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

    if (u.includes('/pulls?')) {
      return json(
        prs.map((p) => ({
          number: p.number,
          user: { login: p.user },
          draft: false,
          body: 'Closes #50',
          head: { sha: 'abc123' },
        }))
      )
    }
    const rv = u.match(/\/pulls\/(\d+)\/reviews/)
    if (rv && method === 'GET') {
      return json(prs.find((p) => p.number === Number(rv[1]))?.existingReviews ?? [])
    }
    if (u.endsWith('/user')) return json({ login: 'loureng' })
    if (/\/pulls\/\d+$/.test(u.split('?')[0]!)) {
      return json({ number: 1, body: 'Closes #50', head: { sha: 'abc123' } })
    }
    if (u.includes('/issues/50')) {
      return json({
        number: 50,
        labels: issueLabels.map((name) => ({ name })),
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

  it('acha PR delegado mesmo com autor humano (Jules abre pela conta do dono): issue com label jules', async () => {
    const f = fakeFetch([{ number: 9, user: 'loureng' }])
    const posted = (
      f as unknown as { posted: { reviews: Array<{ event?: string; body?: string }> } }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBeUndefined()
    // PR do próprio dono do token: o GitHub proíbe APPROVE (422) — o veredito
    // sai como review COMMENT com o resultado explícito no texto.
    expect(posted.reviews[0]!.event).toBe('COMMENT')
    expect(posted.reviews[0]!.body).toContain('APPROVE')
  })

  it('autor diferente do dono do token → APPROVE de verdade', async () => {
    const f = fakeFetch([{ number: 9, user: 'google-labs-jules[bot]' }])
    const posted = (f as unknown as { posted: { reviews: Array<{ event?: string }> } }).posted
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('APPROVE')
  })

  it('autor humano + issue SEM label de delegação → não é trabalho delegado (no-op)', async () => {
    const f = fakeFetch([{ number: 9, user: 'loureng' }], ['gitorch:task'])
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBe(true)
  })

  it('PR já julgado neste head → não re-julga a cada wake (no-op)', async () => {
    const f = fakeFetch([
      {
        number: 9,
        user: 'jules[bot]',
        existingReviews: [{ body: '<!-- gitorch:qa -->\nGitOrch QA: ...', commit_id: 'abc123' }],
      },
    ])
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })

  it('head NOVO após rework → julga de novo (review antiga era de outro sha)', async () => {
    const f = fakeFetch([
      {
        number: 9,
        user: 'jules[bot]',
        existingReviews: [{ body: '<!-- gitorch:qa -->\nrework pedido', commit_id: 'sha-velho' }],
      },
    ])
    const posted = (f as unknown as { posted: { reviews: Array<{ event?: string }> } }).posted
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('APPROVE')
  })

  it('o card da issue segue o veredito: approve → done; rework → inProgress', async () => {
    const moves: Array<{ issue: number; column: string }> = []
    const moveCard = async (issue: number, column: string) => {
      moves.push({ issue, column })
      return `card #${issue} -> ${column} (set)`
    }
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      moveCard,
      fetchImpl: fakeFetch([{ number: 7, user: 'jules[bot]' }]),
    })
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      moveCard,
      fetchImpl: fakeFetch([{ number: 8, user: 'jules[bot]' }]),
    })
    // A issue vinculada (Closes #50 no corpo da PR) é a movida — não a PR.
    expect(moves).toEqual([
      { issue: 50, column: 'done' },
      { issue: 50, column: 'inProgress' },
    ])
  })

  it('sem PR aberta e mode "recon": produz o baseline de reconhecimento, não noOp', async () => {
    const f = fakeFetch([])
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      mode: 'recon',
      execute: async () => RECON,
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(r.noOp).toBeUndefined()
    expect(r.output).toContain('## CI/CD')
    expect(r.output).toContain('## Test suites')
    expect(r.output).toContain('## Coverage expectation')
    expect(r.output).toContain('## Critical paths')
    expect(r.output).toContain('GitHub Actions')

    // Contrato de entregável (mission-outcome.ts): o scheduler só grava
    // memória e marca a missão como concluída se isto passar. Sem o modo
    // recon, "sem PR" saía como noOp — aqui precisa ser entregável real.
    const entrega = assertMissionDelivered('qa', r.output)
    expect(entrega.delivered).toBe(true)
  })

  it('sem PR aberta e SEM mode "recon": continua no-op (comportamento clássico preservado)', async () => {
    const f = fakeFetch([])
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => RECON,
      fetchImpl: f,
    })
    expect(r.noOp).toBe(true)
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
