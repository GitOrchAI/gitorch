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

function fakeFetch(
  prs: Array<{
    number: number
    user: string
    existingReviews?: Array<{ body: string; commit_id: string }>
  }>,
  issueLabels: string[] = ['jules', 'gitorch:task']
): typeof fetch {
  const posted: {
    reviews: unknown[]
    comments: unknown[]
    labels: Array<{ number: number; method: string; label?: string; labels?: string[] }>
  } = { reviews: [], comments: [], labels: [] }
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
    // label da issue vinculada — checar ANTES de "/issues/50" (que também
    // casaria com "/issues/50/labels" por ser substring).
    const dm = u.match(/\/issues\/(\d+)\/labels\/([^/]+)$/)
    if (dm && method === 'DELETE') {
      posted.labels.push({ number: Number(dm[1]), method, label: decodeURIComponent(dm[2]!) })
      return json({})
    }
    const lm = u.match(/\/issues\/(\d+)\/labels$/)
    if (lm && method === 'POST') {
      posted.labels.push({ number: Number(lm[1]), method, labels: body.labels })
      return json([])
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
    // O veredito é tentado com força total: quem sabe dizer se a PR é do
    // próprio ator é o GitHub (422 "own pull request"), não uma pergunta de
    // identidade que o token de aplicativo não pode responder. Neste cenário o
    // GitHub aceita, então sai APPROVE mesmo.
    expect(posted.reviews[0]!.event).toBe('APPROVE')
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

  it('ao julgar, marca a issue VINCULADA (não a PR) com gitorch:agent:qa e tira o agente anterior', async () => {
    const f = fakeFetch(
      [{ number: 7, user: 'jules[bot]' }],
      ['jules', 'gitorch:task', 'gitorch:agent:jules']
    )
    const posted = (
      f as unknown as {
        posted: {
          labels: Array<{ number: number; method: string; label?: string; labels?: string[] }>
        }
      }
    ).posted
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })

    const added = posted.labels.find(
      (l) => l.method === 'POST' && (l.labels ?? []).includes('gitorch:agent:qa')
    )
    expect(added?.number).toBe(50) // a issue #50 vinculada pelo "Closes #50", não a PR #7
    const removed = posted.labels.find((l) => l.method === 'DELETE')
    expect(removed).toEqual({ number: 50, method: 'DELETE', label: 'gitorch:agent:jules' })
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

// Visto em produção, com a missão do QA marcada FAILED:
//
//   GithubExecutionError: GitHub GET /user failed (403):
//   {"message":"Resource not accessible by integration"}
//
// O QA perguntava "quem sou eu?" para não tentar aprovar o próprio PR — o
// GitHub recusa isso com 422. Só que a identidade agora é a do APLICATIVO, e
// aplicativo não é uma pessoa: `GET /user` responde 403 sempre. A pergunta era
// impossível de responder com o token que ele tem.
//
// Agora quem decide é a resposta do GitHub: tenta o veredito com força total e,
// se vier o 422 de "não pode revisar o próprio PR", reposta como comentário —
// que é sempre permitido. Nunca falha a missão por causa disso.
describe('QA: veredito sem depender de "quem sou eu"', () => {
  const prAberta = {
    number: 7,
    user: { login: 'app/gitorch-ai' },
    body: 'closes #3',
    head: { sha: 'abc' },
    draft: false,
  }

  function githubFake(opts: { recusaReview: boolean }) {
    const chamadas: Array<{ method: string; path: string; body?: unknown }> = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url).replace('https://api.github.com', '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      chamadas.push({ method, path: u, body })
      const ok = (d: unknown) =>
        ({
          ok: true,
          status: 200,
          json: async () => d,
          text: async () => '',
        }) as unknown as Response

      if (u === '/user') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ message: 'Resource not accessible by integration' }),
          text: async () => 'Resource not accessible by integration',
        } as unknown as Response
      }
      if (u.includes('/pulls?')) return ok([prAberta])
      if (u.match(/\/pulls\/\d+$/)) return ok({ body: 'closes #3', head: { sha: 'abc' } })
      if (u.includes('/reviews?')) return ok([])
      if (u.includes('/issues/'))
        return ok({ body: '## Verification Criteria\n\n- funciona', labels: [{ name: 'jules' }] })
      if (u.includes('/files')) return ok([{ filename: 'a.ts', patch: '+1' }])
      if (u.includes('/check-runs') || u.includes('/status'))
        return ok({ check_runs: [], state: 'success' })
      if (method === 'POST' && u.includes('/reviews')) {
        const evento = (body as { event?: string })?.event
        if (opts.recusaReview && evento !== 'COMMENT') {
          return {
            ok: false,
            status: 422,
            json: async () => ({ message: 'Can not approve your own pull request' }),
            text: async () => 'Can not approve your own pull request',
          } as unknown as Response
        }
        return ok({})
      }
      return ok({})
    }) as unknown as typeof fetch
    return { impl, chamadas }
  }

  it('não pergunta mais "quem sou eu" — a missão não quebra com o 403 do aplicativo', async () => {
    const { impl, chamadas } = githubFake({ recusaReview: false })

    const r = await runQaMissionViaRails({
      repository: 'dono/repo',
      githubToken: 'ghs_app',
      execute: async () => APPROVE,
      fetchImpl: impl,
    })

    expect(r.exitCode).toBe(0)
    expect(chamadas.some((c) => c.path === '/user')).toBe(false)
  })

  it('PR do próprio ator: o 422 do GitHub vira comentário, e o veredito sai mesmo assim', async () => {
    const { impl, chamadas } = githubFake({ recusaReview: true })

    const r = await runQaMissionViaRails({
      repository: 'dono/repo',
      githubToken: 'ghs_app',
      execute: async () => APPROVE,
      fetchImpl: impl,
    })

    expect(r.exitCode).toBe(0)
    const reviews = chamadas.filter((c) => c.method === 'POST' && c.path.includes('/reviews'))
    expect(reviews.length).toBeGreaterThanOrEqual(2)
    expect((reviews.at(-1)!.body as { event?: string }).event).toBe('COMMENT')
  })
})
