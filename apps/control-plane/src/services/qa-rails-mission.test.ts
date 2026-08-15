import { describe, it, expect, vi } from 'vitest'
import { runQaMissionViaRails, buildJulesReworkComment } from './qa-rails-mission.js'
import { assertMissionDelivered } from './mission-outcome.js'
import type { LinhaDeSessao } from './dev-session-store.js'

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

/**
 * Linha de `dev_sessions` para os testes que exercitam o caminho autoritativo
 * de `ehPrDelegado` (Achado 1 da revisão da Task 6). Mesmo shape do helper de
 * `pr-delegado.test.ts` — não inventar outro.
 */
function linha(over: Partial<LinhaDeSessao>): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'p',
    issueNumber: 1,
    sessionName: 's',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    ...over,
  }
}

function fakeFetch(
  prs: Array<{
    number: number
    user: string
    existingReviews?: Array<{ body: string; commit_id: string }>
    /** Corpo do PR. Default preserva o `Closes #50` que os 15 testes antigos assumem. */
    body?: string
  }>,
  issueLabels: string[] = ['jules', 'gitorch:task'],
  /**
   * Número da issue vinculada consultada para Verification Criteria/labels.
   * Default 50 preserva o comportamento antigo; os testes do caminho
   * autoritativo (linha da sessão) passam a issue real da linha.
   */
  issueNumber = 50,
  /**
   * Achado Crítico da revisão da Task 7 (`diff-do-pr.ts`): antes desta
   * correção, `truncado` ficava `false` quando o laço de paginação esgotava
   * `MAX_PAGINAS` com o último lote ainda não-vazio. Este mock respondia ao
   * mesmo array em TODAS as páginas (ignorava `page=`), então `lerDiffDoPr`
   * sempre esgotava as 20 páginas — inofensivo enquanto o bug deixava
   * `truncado = false`, mas com a correção isso marcaria `truncado = true`
   * em todo teste que passa por aqui, quebrando as asserções de `APPROVE`
   * que nada têm a ver com truncamento. Por isso a página 2+ agora devolve
   * vazio — fiel ao GitHub real — e `patchArquivoUnico`/`checkRuns` deixam
   * os achados Importante 1 e 2 simularem "sem verificação" e "diff grande"
   * sem precisar de outro mock do zero.
   */
  opts: {
    patchArquivoUnico?: string
    checkRuns?: Array<{ conclusion?: string; status?: string }>
    /**
     * Achado Importante da revisão da Task 11: sem isto, o fallback genérico
     * (`return json({})` no final desta função) absorvia o `PUT .../merge`
     * sem que nenhum teste pudesse provar o caminho onde o GitHub recusa o
     * merge — `mesclarPr` cai no `catch` e devolve `mesclado: false`, mas a
     * suíte inteira era cega a esse ramo. Quando `true`, a rota de merge
     * devolve uma resposta NÃO-ok (405, "not mergeable"), fiel ao formato
     * real do erro do GitHub.
     */
    mergeFalha?: boolean
  } = {}
): typeof fetch {
  const posted: {
    reviews: unknown[]
    comments: unknown[]
    labels: Array<{ number: number; method: string; label?: string; labels?: string[] }>
    /**
     * Achado Importante da revisão da Task 11: antes, NENHUMA chamada ao
     * `PUT .../merge` era capturada — caía direto no fallback genérico
     * `return json({})`, que aceita qualquer coisa sem registrar nada. Sem
     * este array, nenhum teste consegue provar que o merge foi chamado, com
     * que corpo, ou para qual PR.
     */
    merges: Array<{ number: number; body: unknown }>
  } = { reviews: [], comments: [], labels: [], merges: [] }
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
          body: p.body ?? 'Closes #50',
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
      // O fetch da PR isolada devolve o MESMO corpo da listagem (é a mesma PR
      // no GitHub real) — sem isso, um teste que dependesse deste corpo (ex.:
      // "Closes #N" de outra issue) veria sempre o valor fixo antigo.
      const numeroDoPr = Number(u.split('?')[0]!.match(/\/pulls\/(\d+)$/)?.[1])
      const p = prs.find((x) => x.number === numeroDoPr)
      return json({ number: numeroDoPr, body: p?.body ?? 'Closes #50', head: { sha: 'abc123' } })
    }
    // label da issue vinculada — checar ANTES de "/issues/{issueNumber}" (que também
    // casaria com "/issues/{issueNumber}/labels" por ser substring).
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
    if (u.includes(`/issues/${issueNumber}`)) {
      return json({
        number: issueNumber,
        labels: issueLabels.map((name) => ({ name })),
        body: '## Verification Criteria\n\n- GET /reviews retorna lista\n- POST valida compra',
      })
    }
    if (u.includes('/commits/') && u.includes('/check-runs')) {
      return json({
        check_runs: opts.checkRuns ?? [{ name: 'ci', conclusion: 'success', status: 'completed' }],
      })
    }
    if (u.match(/\/pulls\/\d+\/files/)) {
      // A página 1 traz o arquivo; da página 2 em diante, vazio — como o
      // GitHub real. Sem isso `lerDiffDoPr` nunca vê uma página vazia e
      // esgota MAX_PAGINAS sempre, o que (depois da correção do Achado
      // Crítico) marcaria `truncado = true` em todo teste à toa.
      const pagina = Number(new URL(u).searchParams.get('page') ?? '1')
      if (pagina > 1) return json([])
      return json([{ filename: 'src/reviews.ts', patch: opts.patchArquivoUnico ?? '+code' }])
    }
    if (u.match(/\/issues\/\d+\/comments/) && method === 'GET') return json([]) // sem marker
    if (u.match(/\/pulls\/\d+\/reviews/) && method === 'POST') {
      posted.reviews.push(body)
      return json({ id: 1 })
    }
    if (u.match(/\/issues\/\d+\/comments/) && method === 'POST') {
      posted.comments.push(body)
      return json({ id: 1 })
    }
    // Rota de merge (Task 11): precisa vir ANTES do fallback genérico, senão
    // `return json({})` no final absorve a chamada sem registrar nada — o
    // mesmo defeito que a revisão apontou no dublê original.
    const mm = u.match(/\/pulls\/(\d+)\/merge$/)
    if (mm && method === 'PUT') {
      posted.merges.push({ number: Number(mm[1]), body })
      if (opts.mergeFalha) {
        // Resposta NÃO-ok de verdade (via `Response` real, `.ok` calculado
        // pelo status) — fiel ao formato do GitHub quando o PR não pode ser
        // mesclado (ex.: 405 "Pull Request is not mergeable").
        return new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), {
          status: 405,
        })
      }
      return json({ merged: true, sha: 'deadbeef', message: 'Squashed and merged.' })
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

  // Achado Importante 1 da revisão da Task 7: `'no checks'` SAIU da lista de
  // estados aprováveis (só `ciState === 'green'` libera aprovação), mas
  // nenhum teste provava isso — a suíte inteira continuava verde mesmo se
  // alguém reintroduzisse a exceção. Repositório sem verificação nenhuma é
  // exatamente o alvo da tese do produto: aprovar sem rede de segurança é o
  // risco que a trava existe para fechar.
  it('sem NENHUMA verificação (check_runs vazio), o motor aprova mas a trava vira REQUEST_CHANGES', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      checkRuns: [],
    })
    const posted = (
      f as unknown as {
        posted: {
          reviews: Array<{ event?: string; body?: string }>
          comments: Array<{ body?: string }>
        }
      }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE, // o motor manda aprovar — a trava tem que sobrepor
      fetchImpl: f,
    })
    // O evento do review postado é a prova real (não só o exitCode): sem
    // verificação nenhuma, o veredito efetivo NUNCA pode ser aprovação.
    expect(posted.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(posted.reviews[0]!.body).toContain('REQUEST CHANGES')
    expect(posted.comments).toHaveLength(1) // rework comment postado (fluxo de request_changes)
    expect(r.output).toContain('request_changes')
  })

  // Task 8 (decisão do dono 14/08/2026): repositório sem verificação
  // automática não é caso para aprovar em silêncio — é trabalho de backlog.
  // A trava acima já vira o veredito em REQUEST_CHANGES; falta a outra
  // metade: a lacuna precisa aparecer na SAÍDA da missão, porque é a saída
  // que `persistMissionMemory` (scheduler.ts) grava como memória do
  // projeto — sem o marcador `GITORCH-GAP` na saída, o RA nunca saberia que
  // precisa fundamentar a criação de CI, e o PO nunca teria o que virar
  // tarefa.
  it('sem verificação automática: não aprova e registra a lacuna na saída', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      checkRuns: [],
    })
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE, // o motor manda aprovar — a lacuna tem que sobrepor
      fetchImpl: f,
    })
    expect(r.output).toContain('GITORCH-GAP: this repository has no automated checks')
    expect(r.output).toContain('request_changes')
  })

  it('com verificação verde, não registra lacuna', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }]) // default: checkRuns 'success'
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.output).not.toContain('GITORCH-GAP')
  })

  // Achado Importante 2 da revisão da Task 7: nenhum teste desta suíte tinha
  // `truncado: true` de ponta a ponta (os patches dos fixtures são
  // minúsculos) — uma regressão que removesse `|| truncado` da trava não
  // quebraria nada aqui.
  it('diff que estoura LIMITE_DE_CARACTERES: o motor aprova mas a trava vira REQUEST_CHANGES, e o prompt avisa TRUNCATED', async () => {
    const patchGigante = 'x'.repeat(130_000) // > 120_000 (LIMITE_DE_CARACTERES)
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      patchArquivoUnico: patchGigante,
    })
    const posted = (
      f as unknown as { posted: { reviews: Array<{ event?: string; body?: string }> } }
    ).posted
    const prompts: string[] = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async (prompt) => {
        prompts.push(prompt)
        return APPROVE // o motor manda aprovar — a trava tem que sobrepor
      },
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(prompts[0]).toContain('TRUNCATED')
    expect(r.output).toContain('request_changes')
  })

  // Achado 1 da revisão da Task 6: os 15 testes acima nunca passam `sessoes`,
  // então `ehPrDelegado` sempre cai direto nos recuos (2 e 3) — o caminho 1
  // (a linha guardada, o autoritativo, o que resolveu o defeito medido em
  // produção) nunca era exercitado no ponto onde ele de fato opera. Uma
  // regressão que trocasse `options.sessoes ?? []` por `[]`, ou invertesse a
  // ordem de autoridade dentro de `ehPrDelegado`, passaria batida pelos 1159
  // testes da suíte. Os dois testes abaixo cobrem o cenário real do PR #63.
  it('reconhece o PR #63 real pela linha da sessão: autor loureng (sem "jules"), corpo sem Closes #N', async () => {
    // Caso real de produção: 85 execuções do QA dizendo "no delegated PR"
    // com este PR aberto na frente dele — o autor é a conta da instalação
    // (não contém "jules") e o corpo não traz palavra de ligação nenhuma.
    // Só a linha guardada (`sessoes`) sabe que o PR #63 nasceu da issue #24.
    const f = fakeFetch(
      [{ number: 63, user: 'loureng', body: 'Fix failing CI by downgrading action versions' }],
      ['jules', 'gitorch:task'],
      24
    )
    const posted = (
      f as unknown as {
        posted: {
          reviews: Array<{ event?: string }>
          labels: Array<{ number: number; method: string; labels?: string[] }>
        }
      }
    ).posted
    const prompts: string[] = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async (prompt) => {
        prompts.push(prompt)
        return APPROVE
      },
      sessoes: [linha({ issueNumber: 24, pullRequestNumber: 63 })],
      fetchImpl: f,
    })

    // Não é no-op: o PR foi reconhecido como delegado (sem isso o QA nunca
    // chegaria a julgar nada, que era exatamente o defeito de produção).
    expect(r.noOp).toBeUndefined()
    expect(posted.reviews[0]!.event).toBe('APPROVE')
    // A issue usada no julgamento (Verification Criteria + label final) é a
    // #24 da LINHA — não uma issue extraída do corpo, que aqui nem existe.
    expect(prompts[0]).toContain('linked issue #24')
    const marcada = posted.labels.find(
      (l) => l.method === 'POST' && (l.labels ?? []).includes('gitorch:agent:qa')
    )
    expect(marcada?.number).toBe(24)
  })

  // Task 10 (decisão do dono 14/08/2026): "tem que ter lógica entre jules e
  // QA". Sem isto, o veredito de rework vira comentário no PR e morre ali —
  // o dev assíncrono não lê o PR dele (medido: PR #79 real, 5 dias parado,
  // CI verde, 12 reprovações, zero retrabalho). `avisarSessao` é o fio que
  // fecha o laço: entrega a MESMA informação do comentário na sessão viva.
  it('ao reprovar, manda o que precisa mudar para a sessão do dev', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const enviadas: Array<{ sessionName: string; texto: string }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      avisarSessao: async (args) => {
        enviadas.push(args)
        return true
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(1)
    expect(enviadas[0]!.sessionName).toBe('sessions/123')
    expect(enviadas[0]!.texto).toContain('#79')
    // Os nomes REAIS do schema (DoDFields): implementationGuide e
    // verificationCriteria — não os inventados por engano em rascunho.
    expect(enviadas[0]!.texto).toContain('1. validar body; 2. teste do caso inválido')
    expect(enviadas[0]!.texto).toContain('- retornar 400 para material inexistente')
    // Instrução explícita: revisar o MESMO PR, não abrir outro.
    expect(enviadas[0]!.texto).toContain('SAME pull request')
  })

  it('ao aprovar, não manda nada para a sessão', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const enviadas: unknown[] = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      avisarSessao: async (a) => {
        enviadas.push(a)
        return true
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(0)
  })

  it('reprovação sem linha de sessão correspondente ao PR não derruba a missão', async () => {
    // O PR pode ser de um humano, ou anterior a esta mudança — sem linha
    // guardada, a missão segue sem avisar ninguém (não é erro).
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const enviadas: unknown[] = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [],
      avisarSessao: async (a) => {
        enviadas.push(a)
        return true
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(0)
  })

  it('sem avisarSessao (opção ausente): comportamento clássico preservado, sem quebrar', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
  })

  it('avisarSessao falha (retorna false): a missão não quebra, mas o silêncio é proibido — avisa no console', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      avisarSessao: async () => false,
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0) // o veredito já foi postado — isso não pode derrubar a missão
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('#79')
    expect(warnSpy.mock.calls[0]![0]).toContain('sessions/123')
    warnSpy.mockRestore()
  })

  it('o aviso sai pelo canal injetado, não pelo console — é ele que aparece no log estruturado', async () => {
    // Em produção o scheduler passa `app.log.warn`. Se o aviso escapasse para
    // o console, ele sumiria da observabilidade e o silêncio que esta peça
    // existe para matar voltaria pela porta dos fundos.
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const avisos: string[] = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      avisarSessao: async () => false,
      onWarn: (m) => avisos.push(m),
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('#79')
    expect(avisos[0]).toContain('sessions/123')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('avisarSessao lança exceção: a missão não quebra, e o aviso ainda sai (best-effort de verdade)', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 79, sessionName: 'sessions/123' })],
      avisarSessao: async () => {
        throw new Error('serviço externo fora do ar')
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('a linha vence a palavra de ligação: corpo aponta para OUTRA issue, a linha decide', async () => {
    // Prova a ORDEM de autoridade: mesmo com "Closes #99" no corpo, quem
    // decide a issue vinculada é a linha guardada (#24), não a regex do
    // corpo. Uma inversão de ordem em `ehPrDelegado` faria este teste falhar.
    const f = fakeFetch([{ number: 70, user: 'loureng', body: 'Closes #99' }], ['jules'], 24)
    const posted = (
      f as unknown as {
        posted: { labels: Array<{ number: number; method: string; labels?: string[] }> }
      }
    ).posted
    const prompts: string[] = []
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async (prompt) => {
        prompts.push(prompt)
        return APPROVE
      },
      sessoes: [linha({ issueNumber: 24, pullRequestNumber: 70 })],
      fetchImpl: f,
    })

    expect(prompts[0]).toContain('linked issue #24')
    expect(prompts[0]).not.toContain('linked issue #99')
    const marcada = posted.labels.find(
      (l) => l.method === 'POST' && (l.labels ?? []).includes('gitorch:agent:qa')
    )
    expect(marcada?.number).toBe(24)
  })

  // Achado Importante da revisão da Task 11 (a mais perigosa do plano: dá ao
  // produto o poder de mesclar código do cliente sem humano nenhum). A função
  // pura `mesclarPr` já tinha teste por porteiro em `merge-do-pr.test.ts`, mas
  // a INTEGRAÇÃO dentro desta missão nunca era exercitada — os 15+ testes do
  // ramo de aprovação continuavam verdes só porque o fallback genérico do
  // dublê (`return json({})`) absorvia o `PUT .../merge` sem checar nada. Uma
  // regressão que trocasse `merge_method`, removesse a chamada, invertesse a
  // condição de `aoMesclar`, ou apagasse o `mergeNote` do resumo passaria
  // batida pela suíte inteira — numa ação que mescla código de cliente sem
  // supervisão.
  it('approve com CI verde e diff completo: chama PUT .../merge com merge_method squash', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }]) // default: checkRuns 'success', patch pequeno (diff completo)
    const posted = (
      f as unknown as { posted: { merges: Array<{ number: number; body: unknown }> } }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    // Não basta contar a chamada: precisa ser NO PR certo e com o método de
    // merge que a decisão do dono (D7) fixou.
    expect(posted.merges).toHaveLength(1)
    expect(posted.merges[0]).toEqual({ number: 7, body: { merge_method: 'squash' } })
  })

  it('merge acontece: aoMesclar dispara UMA vez com o número certo do PR, e a saída declara "merged"', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }])
    const mesclados: Array<{ numeroDoPr: number }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      aoMesclar: async (args) => {
        mesclados.push(args)
      },
      fetchImpl: f,
    })
    // (b) fechar a sessão como "mesclada" só pode acontecer quando o merge de
    // fato aconteceu — aqui aconteceu, então `aoMesclar` tem que ter disparado
    // exatamente uma vez, com o PR #7.
    expect(mesclados).toEqual([{ numeroDoPr: 7 }])
    // (c) o resumo da missão precisa declarar o resultado do merge — texto
    // real do `mergeNote` (qa-rails-mission.ts), não inventado.
    expect(r.output).toContain('Merge: merged (verificação verde e QA aprovou).')
  })

  it('GitHub recusa o merge: aoMesclar NÃO dispara (perderia o rastro de um trabalho que continua aberto), e a saída declara "blocked"', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      mergeFalha: true,
    })
    const posted = (
      f as unknown as { posted: { merges: Array<{ number: number; body: unknown }> } }
    ).posted
    const mesclados: Array<{ numeroDoPr: number }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      aoMesclar: async (args) => {
        mesclados.push(args)
      },
      fetchImpl: f,
    })
    // A tentativa aconteceu (não é que o sistema nunca chamou o GitHub) — só
    // que o GitHub recusou.
    expect(posted.merges).toHaveLength(1)
    // (b) sem merge de verdade, `aoMesclar` fecharia a sessão como concluída
    // por engano — a linha ficaria "morta" com PR ainda aberto no GitHub.
    expect(mesclados).toHaveLength(0)
    // A missão não quebra por causa disso: o veredito de aprovação já foi
    // postado no PR antes da tentativa de merge.
    expect(r.exitCode).toBe(0)
    // (c) o resumo declara o bloqueio, com o motivo real devolvido por
    // `mesclarPr` quando `deps.merge()` lança (branch de exceção).
    expect(r.output).toContain('Merge: blocked (falha ao mesclar:')
    expect(r.output).toContain('pulls/7/merge failed (405)')
  })

  // C1 (achado crítico da revisão final): a aprovação já foi postada no PR
  // quando o GitHub recusa o merge (405, ou porque o produto não pôde
  // aprovar a própria PR e a review virou COMMENT). Sem esta correção, o
  // laço de descoberta via `alreadyJudged` pulava o PR PARA SEMPRE no ciclo
  // seguinte — já existe review nossa (com o marcador) naquele mesmo head —
  // e a esteira ficava presa: a linha da sessão nunca fecha, a issue nunca
  // volta à fila, e a vigia dispara o QA 6x/hora devolvendo sempre "nenhum
  // PR para julgar". Exatamente o defeito das 85 execuções cegas
  // ressuscitado. Prova em DOIS ciclos: ciclo 1 aprova e o GitHub recusa;
  // ciclo 2 (mesmo obstáculo já removido no GitHub) tem de reexaminar o
  // MESMO PR e tentar o merge de novo — não pode ser noOp.
  it('C1: aprovação recusada pelo GitHub não é beco sem saída — no ciclo seguinte o PR é reexaminado e o merge é tentado de novo', async () => {
    // Ciclo 1: QA aprova, GitHub recusa o merge (405). A review de aprovação
    // já foi postada ANTES da tentativa de merge — é o texto dela que o
    // ciclo 2 vai encontrar como "já julgada" no mesmo head.
    const f1 = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      mergeFalha: true,
    })
    const posted1 = (
      f1 as unknown as {
        posted: { reviews: Array<{ body?: string }>; merges: Array<{ number: number }> }
      }
    ).posted
    const r1 = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f1,
    })
    expect(r1.output).toContain('Merge: blocked')
    expect(posted1.merges).toHaveLength(1)
    const corpoDaAprovacao = posted1.reviews[0]!.body as string
    expect(corpoDaAprovacao).toContain('<!-- gitorch:qa -->')

    // Ciclo 2: o obstáculo já foi removido no GitHub (ex.: proteção de
    // branch ajustada) — mas a review de aprovação do ciclo 1 continua lá,
    // no MESMO head (mesmo commit_id 'abc123' que `fakeFetch` usa sempre).
    // Sem a correção, o PR seria pulado para sempre por já ter review nossa
    // ali, e a missão devolveria noOp eternamente mesmo com o merge
    // possível agora.
    const f2 = fakeFetch([
      {
        number: 7,
        user: 'jules[bot]',
        existingReviews: [{ body: corpoDaAprovacao, commit_id: 'abc123' }],
      },
    ])
    const posted2 = (
      f2 as unknown as { posted: { merges: Array<{ number: number; body: unknown }> } }
    ).posted
    const r2 = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f2,
    })
    expect(r2.noOp).toBeFalsy()
    expect(posted2.merges).toHaveLength(1)
    expect(r2.output).toContain('Merge: merged')
  })

  // Cuidado com o problema oposto: um PR REPROVADO cujo dev ainda não
  // retrabalhou continua sendo pulado — reexaminar aqui só faria spam de
  // re-julgamento, o defeito que `alreadyJudged` existia para evitar.
  it('C1: PR reprovado (review marcada de REQUEST CHANGES) continua pulado no mesmo head — sem spam de re-julgamento', async () => {
    const f = fakeFetch([
      {
        number: 9,
        user: 'jules[bot]',
        existingReviews: [
          {
            body: '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).',
            commit_id: 'abc123',
          },
        ],
      },
    ])
    const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
    expect(posted.merges).toHaveLength(0)
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
