import { describe, it, expect, vi } from 'vitest'
import {
  runQaMissionViaRails,
  buildJulesReworkComment,
  MAX_TENTATIVAS_DE_MERGE,
} from './qa-rails-mission.js'
import { assertMissionDelivered } from './mission-outcome.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { TETO_DE_ESPERA_MS } from './vigia-da-verificacao.js'

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
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
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
    /**
     * fix/qa-nao-julga-com-verificacao-pendente: quando `true`, a resposta da
     * PR isolada (`GET /pulls/{n}`) devolve `head: {}` — sem `sha`. Simula o
     * caso em que o GitHub não devolve o SHA do head, o que deixa `ciState`
     * em `'unknown'` (não dá para consultar check-runs sem o sha).
     */
    semShaNaPrIsolada?: boolean
    /**
     * Achado 2 da revisão da Tarefa 7: o hash de idempotência do aviso de
     * demora amarra o aviso ao SHA do head. Default 'abc123' preserva o
     * comportamento de todos os testes existentes; os testes que provam a
     * dedupe/rearme do aviso variam este valor para simular um push novo.
     */
    headSha?: string
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
          head: { sha: opts.headSha ?? 'abc123' },
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
      return json({
        number: numeroDoPr,
        body: p?.body ?? 'Closes #50',
        head: opts.semShaNaPrIsolada ? {} : { sha: opts.headSha ?? 'abc123' },
      })
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

  it('acha PR delegado mesmo com autor humano (Jules abre pela conta do dono): issue com label jules E sessão para ela', async () => {
    // fix/pr-humano-nao-e-entrega-do-dev: o caminho 3 (corpo + etiqueta) só
    // reconhece delegação com uma linha de sessão por trás — a SM cria a
    // linha ANTES do dev assíncrono abrir o PR, então este cenário (a
    // instalação abre o PR pela conta do dono, sem "jules" no login) sempre
    // tem sessão real disponível na produção. Sem a linha aqui, este teste
    // estaria provando de novo o mesmo furo do PR #99 (ver pr-delegado.test.ts).
    const f = fakeFetch([{ number: 9, user: 'loureng' }])
    const posted = (
      f as unknown as { posted: { reviews: Array<{ event?: string; body?: string }> } }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: null })],
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

  // Task 8 (decisão do dono 15/08/2026): "julga todos, mescla só o que
  // delegou". Antes desta mudança este cenário era descartado na origem
  // (no-op) — agora a entrega de humano não é mais jogada fora: o QA julga,
  // escreve o parecer, e só não mescla. Ver a suíte "Tarefa 8" abaixo para os
  // quatro cenários do brief.
  it('autor humano + issue SEM label de delegação: não é mais descartado — julga, mas não pode mesclar', async () => {
    const f = fakeFetch([{ number: 9, user: 'loureng' }], ['gitorch:task'])
    const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(r.noOp).toBeUndefined()
    expect(posted.reviews).toHaveLength(1)
    expect(posted.merges).toHaveLength(0)
    expect(r.podeMesclar).toBe(false)
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

  // Leva B: "done" deixou de ser decisão desta missão — só rework move o
  // card (para "inProgress"), imediatamente, porque isso é verdade no
  // instante do julgamento sem depender de publicação nenhuma. Aprovação
  // (mesmo com merge concluído) não move mais nada aqui: quem decide "done"
  // é `resolverEntregaDoBoard` (scheduler.ts), só quando a publicação
  // confirma que o código foi ao ar — ou quando o repositório prova que não
  // publica, e então o merge já é a entrega.
  it('o card da issue só se move no rework, para "inProgress" — "done" passou a depender da publicação (Leva B)', async () => {
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
    expect(moves).toEqual([{ issue: 50, column: 'inProgress' }])
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

  // Defeito real de produção: o QA julgou o PR #97 ENQUANTO a verificação
  // automática ainda rodava — `QA judged PR #97: request_changes (CI
  // pending)`. Minutos depois a verificação terminou 100% verde, mas a
  // reprovação ficou PRESA para sempre: o skip de "já julgado" (mesmo head
  // sha) nunca deixa o QA re-julgar o mesmo estado, e um motivo TRANSITÓRIO
  // (verificação ainda rodando) virou um bloqueio PERMANENTE. `pending` não
  // é veredito — é "ainda não sei". Tarefa 7: a vigília ativa
  // (`decidirSobreVerificacao`, Tarefa 6) decide `esperar` para este caso —
  // sem postar review nenhuma — e a saída declara o motivo real da decisão.
  it('verificação PENDENTE (PR #97): não julga, não posta review nenhuma, e a saída avisa que está esperando', async () => {
    const f = fakeFetch([{ number: 97, user: 'jules[bot]' }], undefined, undefined, {
      checkRuns: [{ status: 'in_progress' }],
    })
    const posted = (
      f as unknown as { posted: { reviews: unknown[]; comments: unknown[]; merges: unknown[] } }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      // Se a missão chegar a chamar o motor aqui, o pulo não aconteceu antes
      // do julgamento — o teste tem que falhar de forma ruidosa, não muda.
      execute: async () => {
        throw new Error('não deveria julgar com CI pendente')
      },
      fetchImpl: f,
    })
    expect(posted.reviews).toHaveLength(0)
    expect(posted.comments).toHaveLength(0)
    expect(posted.merges).toHaveLength(0)
    expect(r.exitCode).toBe(0)
    expect(r.noOp).toBe(true)
    expect(r.output).toContain('PR #97')
    expect(r.output).toContain('não julgado')
    expect(r.output).toContain('verificação em pending')
  })

  it('verificação VERDE: continua julgando normalmente (não regrediu)', async () => {
    const f = fakeFetch([{ number: 97, user: 'jules[bot]' }], undefined, undefined, {
      checkRuns: [{ conclusion: 'success', status: 'completed' }],
    })
    const posted = (f as unknown as { posted: { reviews: Array<{ event?: string }> } }).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('APPROVE')
    expect(r.noOp).toBeUndefined()
  })

  it('verificação RED (falhou): continua reprovando, não pula', async () => {
    const f = fakeFetch([{ number: 12, user: 'jules[bot]' }], undefined, undefined, {
      checkRuns: [{ conclusion: 'failure', status: 'completed' }],
    })
    const posted = (
      f as unknown as { posted: { reviews: Array<{ event?: string }>; comments: unknown[] } }
    ).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE, // o motor manda aprovar — a trava tem que sobrepor (CI vermelho)
      fetchImpl: f,
    })
    expect(posted.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(posted.comments).toHaveLength(1)
    expect(r.output).toContain('request_changes')
    expect(r.noOp).toBeUndefined()
  })

  // `unknown` (não deu para ler o head sha, logo não dá para consultar
  // check-runs) entra no MESMO pulo que `pending`, e pelo mesmo motivo:
  // julgar às cegas arrisca travar um PR para sempre com uma reprovação
  // possivelmente errada — o mesmo defeito do PR #97, só que por uma porta
  // diferente. Ao contrário de `no checks` (estado ESTÁVEL — o repositório
  // não tem verificação e não vai passar a ter só de esperar, por isso
  // CONTINUA sendo julgado e vira a lacuna GITORCH-GAP), `unknown` é uma
  // leitura SEM evidência nenhuma sobre qual dos quatro estados é o real.
  // Errar para o lado de não agir agora é mais seguro que errar para o lado
  // de uma reprovação permanente e talvez incorreta.
  it('CI unknown (head sha ausente): pula como pending, não julga às cegas', async () => {
    const f = fakeFetch([{ number: 55, user: 'jules[bot]' }], undefined, undefined, {
      semShaNaPrIsolada: true,
    })
    const posted = (f as unknown as { posted: { reviews: unknown[]; comments: unknown[] } }).posted
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => {
        throw new Error('não deveria julgar com CI unknown')
      },
      fetchImpl: f,
    })
    expect(posted.reviews).toHaveLength(0)
    expect(posted.comments).toHaveLength(0)
    expect(r.noOp).toBe(true)
    expect(r.output).toContain('PR #55')
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

  // ACHADO 6 DA LENTE (21/08/2026): a metade que GUARDA o recado não tinha
  // teste nenhum. Como `registrarAvisoPendente` é opcional, remover a fiação
  // não quebraria tsc nem teste — a feature morreria em silêncio, e o defeito
  // que ela conserta (429 passageiro encalhando a entrega para sempre) voltaria
  // sem ninguém perceber.
  it('aviso que NÃO chega ao dev vira pendência guardada, com o texto inteiro', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const guardadas: Array<{ sessionName: string; texto: string }> = []
    const enviadas: Array<{ sessionName: string; texto: string }> = []

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 74, pullRequestNumber: 79, sessionName: 'sessions/guardar' })],
      // Canal próprio: sem ele o aviso cairia no console e contaminaria a
      // contagem dos testes vizinhos que espiam `console.warn`.
      onWarn: () => undefined,
      // O serviço externo recusa — foi o HTTP 429 medido em produção.
      avisarSessao: async (a) => {
        enviadas.push(a)
        return false
      },
      registrarAvisoPendente: async (a) => {
        guardadas.push(a)
      },
      fetchImpl: f,
    })

    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(1)
    // O recado tem que ser GUARDADO, e guardado INTEIRO: a reentrega precisa do
    // texto, não de um sinal de que existiu um texto.
    expect(guardadas).toHaveLength(1)
    expect(guardadas[0]!.sessionName).toBe(enviadas[0]!.sessionName)
    expect(guardadas[0]!.texto).toBe(enviadas[0]!.texto)
  })

  it('aviso que CHEGA não guarda pendência nenhuma', async () => {
    const f = fakeFetch([{ number: 79, user: 'jules[bot]' }])
    const guardadas: unknown[] = []
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [linha({ issueNumber: 74, pullRequestNumber: 79, sessionName: 'sessions/guardar' })],
      onWarn: () => undefined,
      avisarSessao: async () => true,
      registrarAvisoPendente: async (a) => {
        guardadas.push(a)
      },
      fetchImpl: f,
    })
    expect(guardadas).toHaveLength(0)
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

  // Reproduz, com carimbo de hora real (15/08/2026), a corrida entre o QA e a
  // vigia: às 16:42:22 o QA julgou o PR #97 (achou a delegação pelo recuo 3 —
  // corpo com "Fixes #74" + issue com a etiqueta) e às 16:45:01 a vigia gravou
  // `pullRequestNumber = 97` na linha. NESTE instante do julgamento a linha
  // ainda não tem o PR gravado — é exatamente o estado que este teste monta.
  it('reprova ANTES de a vigia gravar o PR na linha: avisa a sessão pela issue de origem, não pelo PR', async () => {
    const f = fakeFetch(
      [{ number: 97, user: 'gitorch-app[bot]', body: 'Fixes #74' }],
      ['jules'],
      74
    )
    const enviadas: Array<{ sessionName: string; texto: string }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      // A vigia ainda não gravou o PR: pullRequestNumber continua null.
      sessoes: [linha({ issueNumber: 74, pullRequestNumber: null, sessionName: 'sessions/74abc' })],
      avisarSessao: async (args) => {
        enviadas.push(args)
        return true
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(1)
    expect(enviadas[0]!.sessionName).toBe('sessions/74abc')
    expect(enviadas[0]!.texto).toContain('#97')
  })

  it('duas linhas para a mesma issue (uma abandonada com PR velho, outra viva): avisa a viva/mais recente', async () => {
    // `LinhaDeSessao` não expõe `closedAt` — quem garante "viva/mais recente"
    // aqui é a ORDEM em que o chamador entrega `sessoes` (o scheduler entrega
    // `createdAt: 'desc'`, mais recente primeiro). A linha abandonada, com um
    // PR de uma tentativa anterior, vem DEPOIS no array — se o código pegasse
    // a primeira linha da issue sem respeitar essa ordem, ou se caísse de
    // volta para a linha errada, este teste pegaria a regressão.
    const f = fakeFetch(
      [{ number: 97, user: 'gitorch-app[bot]', body: 'Fixes #74' }],
      ['jules'],
      74
    )
    const enviadas: Array<{ sessionName: string; texto: string }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      sessoes: [
        linha({ issueNumber: 74, pullRequestNumber: null, sessionName: 'sessions/nova-viva' }),
        linha({
          issueNumber: 74,
          pullRequestNumber: 90,
          sessionName: 'sessions/velha-abandonada',
        }),
      ],
      avisarSessao: async (args) => {
        enviadas.push(args)
        return true
      },
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(enviadas).toHaveLength(1)
    expect(enviadas[0]!.sessionName).toBe('sessions/nova-viva')
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
    expect(posted.merges[0]).toEqual({ number: 7, body: { merge_method: 'squash', sha: 'abc123' } })
  })

  // I2 (achado importante da revisão final): o diff e o estado da
  // verificação são lidos MINUTOS antes do motor produzir o veredito (linha
  // ~289 chama o motor, que demora); o merge só acontece depois. Sem
  // amarrar o merge ao head que foi de fato revisado, um push do dev nessa
  // janela — e é exatamente o que o QA pede ao reprovar: "Revise the SAME
  // pull request" — faria o produto mesclar código que ninguém leu nem
  // verificou, furando os três porteiros por dentro.
  it('I2: o corpo do PUT .../merge contém o sha do head que foi revisado', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }])
    const posted = (
      f as unknown as { posted: { merges: Array<{ number: number; body: unknown }> } }
    ).posted
    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
    })
    expect(posted.merges).toHaveLength(1)
    // 'abc123' é o head.sha que `fakeFetch` devolve tanto na listagem quanto
    // na leitura isolada da PR (o mesmo lido no passo 2, antes do motor).
    expect(posted.merges[0]!.body).toEqual({ merge_method: 'squash', sha: 'abc123' })
  })

  it('merge acontece: aoMesclar dispara UMA vez com o número certo do PR, e a saída declara "merged"', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }])
    const mesclados: Array<{
      numeroDoPr: number
      mergeCommitSha: string
      issueNumber: number | null
    }> = []
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
    // exatamente uma vez, com o PR #7. (Tarefa 17) `mergeCommitSha` é
    // 'deadbeef' — o `sha` que `fakeFetch` devolve na RESPOSTA do
    // `PUT .../merge` — nunca 'abc123', o head.sha da PR: depois do squash
    // aquele commit não existe no branch base, e é o branch base que o CD
    // publica. `issueNumber` é `null` aqui: o recuo por AUTOR ("jules[bot]")
    // não conhece a issue de origem — Importante 4 cobre o recuo pela LINHA
    // autoritativa, no teste seguinte.
    expect(mesclados).toEqual([{ numeroDoPr: 7, mergeCommitSha: 'deadbeef', issueNumber: null }])
    // (c) o resumo da missão precisa declarar o resultado do merge — texto
    // real do `mergeNote` (qa-rails-mission.ts), não inventado.
    expect(r.output).toContain('Merge: merged (verificação verde e QA aprovou).')
  })

  // Importante 4 da revisão final da branch: `aoMesclarUmaEntrega`
  // (scheduler.ts) precisa do número da issue para o recuo quando o PR ainda
  // não foi gravado na linha — este teste prova que o valor REAL da issue
  // (resolvido pelo laço de descoberta, não um valor qualquer) chega até
  // `aoMesclar`.
  it('Importante 4: aoMesclar leva também o número da issue de origem (achado pela linha autoritativa)', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }])
    const mesclados: Array<{
      numeroDoPr: number
      mergeCommitSha: string
      issueNumber: number | null
    }> = []
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      sessoes: [linha({ pullRequestNumber: 7, issueNumber: 99, sessionName: 'sessions/xyz' })],
      aoMesclar: async (args) => {
        mesclados.push(args)
      },
      fetchImpl: f,
    })
    expect(mesclados).toEqual([{ numeroDoPr: 7, mergeCommitSha: 'deadbeef', issueNumber: 99 }])
    expect(r.exitCode).toBe(0)
  })

  it('GitHub recusa o merge: aoMesclar NÃO dispara (perderia o rastro de um trabalho que continua aberto), e a saída declara "blocked"', async () => {
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
      mergeFalha: true,
    })
    const posted = (
      f as unknown as { posted: { merges: Array<{ number: number; body: unknown }> } }
    ).posted
    const mesclados: Array<{ numeroDoPr: number; mergeCommitSha: string }> = []
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

  // Tarefa 10 (mescla recusada não prende a entrega para sempre): o C1 acima
  // já garante que uma aprovação parada é REPROCESSADA em vez de pulada —
  // mas sem teto, reprocessaria para sempre a cada tique do relógio, gerando
  // review e tentativa de merge novas sem nunca avisar ninguém que existe um
  // conflito real esperando um humano. Prova em TRÊS passagens seguidas
  // contra o MESMO commit: a 1a e a 2a continuam retomando a mescla (o C1 de
  // sempre, com o contador subindo); a 3a fecha `MAX_TENTATIVAS_DE_MERGE` e
  // avisa o dono com o motivo real devolvido pelo GitHub.
  describe('Tarefa 10: mescla recusada não prende a entrega para sempre', () => {
    it('entrega aprovada mas com mescla recusada é retomada na passagem seguinte — no 3o fracasso seguido avisa o dono', async () => {
      // A linha da sessão é a MESMA nas três passagens — como no banco real,
      // onde `registrarFracassoDeMerge` grava e a próxima leitura já vê o
      // contador atualizado. O teste simula essa persistência mutando o
      // mesmo objeto que o mock de `registrarFracassoDeMerge` recebe.
      const sessao = linha({ issueNumber: 50, pullRequestNumber: 7, sessionName: 'sessions/7' })
      const avisos: string[] = []
      const opcoesComuns = {
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        sessoes: [sessao],
        registrarFracassoDeMerge: async (args: { contador: number }) => {
          sessao.mergeFailures = args.contador
        },
        avisarDono: async (msg: string) => {
          avisos.push(msg)
        },
      }

      // 1a passagem: aprova, tenta mesclar, o GitHub recusa (fracasso #1).
      const f1 = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
        mergeFalha: true,
      })
      const posted1 = (
        f1 as unknown as { posted: { reviews: Array<{ body?: string }>; merges: unknown[] } }
      ).posted
      const r1 = await runQaMissionViaRails({ ...opcoesComuns, fetchImpl: f1 })
      expect(r1.output).toContain('Merge: blocked')
      expect(posted1.merges).toHaveLength(1)
      expect(sessao.mergeFailures).toBe(1)
      expect(avisos).toHaveLength(0) // ainda não bateu o teto

      const corpoDaAprovacao = posted1.reviews[0]!.body as string

      // 2a passagem: MESMO commit ('abc123', o padrão de `fakeFetch`), já com
      // aprovação NOSSA marcada nele — não pode pular (o C1 continua
      // valendo). GitHub recusa de novo (fracasso #2, ainda abaixo do teto).
      const f2 = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [{ body: corpoDaAprovacao, commit_id: 'abc123' }],
          },
        ],
        undefined,
        undefined,
        { mergeFalha: true }
      )
      const posted2 = (f2 as unknown as { posted: { merges: unknown[] } }).posted
      const r2 = await runQaMissionViaRails({ ...opcoesComuns, fetchImpl: f2 })
      expect(r2.noOp).toBeFalsy() // NÃO pode ser pulado — é o defeito que esta tarefa fecha
      expect(posted2.merges).toHaveLength(1)
      expect(sessao.mergeFailures).toBe(2)
      expect(avisos).toHaveLength(0)

      // 3a passagem: mesmo commit, 3o fracasso seguido — bate
      // MAX_TENTATIVAS_DE_MERGE. Avisa o dono com o motivo real do GitHub.
      const f3 = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [{ body: corpoDaAprovacao, commit_id: 'abc123' }],
          },
        ],
        undefined,
        undefined,
        { mergeFalha: true }
      )
      const posted3 = (f3 as unknown as { posted: { merges: unknown[] } }).posted
      const r3 = await runQaMissionViaRails({ ...opcoesComuns, fetchImpl: f3 })
      expect(r3.noOp).toBeFalsy()
      expect(posted3.merges).toHaveLength(1)
      expect(sessao.mergeFailures).toBe(MAX_TENTATIVAS_DE_MERGE)
      expect(avisos).toHaveLength(1)
      expect(avisos[0]).toContain('#7')
      expect(avisos[0]).toContain(`${MAX_TENTATIVAS_DE_MERGE} vezes seguidas`)
      // O motivo é o texto REAL devolvido por `mesclarPr` (falha ao chamar o
      // GitHub) — não um texto inventado pelo aviso.
      expect(avisos[0]).toContain('pulls/7/merge failed (405)')

      // 4a passagem: MESMO commit, teto já batido. "Para de tentar até o
      // commit mudar" — nem posta review nova, nem chama merge de novo, e
      // não avisa OUTRA vez (repetir o aviso a cada tique seria o mesmo spam
      // que este produto já provou não fazer noutros avisos).
      const f4 = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [{ body: corpoDaAprovacao, commit_id: 'abc123' }],
          },
        ],
        undefined,
        undefined,
        { mergeFalha: true }
      )
      const posted4 = (f4 as unknown as { posted: { reviews: unknown[]; merges: unknown[] } })
        .posted
      const r4 = await runQaMissionViaRails({ ...opcoesComuns, fetchImpl: f4 })
      expect(r4.noOp).toBe(true)
      expect(posted4.reviews).toHaveLength(0)
      expect(posted4.merges).toHaveLength(0)
      expect(sessao.mergeFailures).toBe(MAX_TENTATIVAS_DE_MERGE)
      expect(avisos).toHaveLength(1) // não repetiu o aviso
    })

    it('commit novo (head sha mudou) zera o contador — é tentativa nova, não a mesma que já falhara 3x', async () => {
      const sessao = linha({
        issueNumber: 50,
        pullRequestNumber: 7,
        sessionName: 'sessions/7',
        // Já tinha batido o teto no commit ANTERIOR ('abc123').
        mergeFailures: MAX_TENTATIVAS_DE_MERGE,
        mergeLastFailedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const registrados: number[] = []

      // A review antiga (aprovação do commit velho) continua no GitHub presa
      // a 'abc123' — o head ATUAL já é outro ('def456': o dev empurrou de
      // novo). `reviewMarcadaNesteHead` não bate mais neste sha, então o PR
      // NÃO é mais "já julgado, retomando" — é julgamento fresco de um
      // commit que nunca foi tentado antes.
      const f = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [
              {
                body: '<!-- gitorch:qa -->\nGitOrch QA verdict: APPROVE — criteria met, CI green.',
                commit_id: 'abc123',
              },
            ],
          },
        ],
        undefined,
        undefined,
        { mergeFalha: true, headSha: 'def456' }
      )
      const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted

      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        sessoes: [sessao],
        fetchImpl: f,
        registrarFracassoDeMerge: async (args) => {
          registrados.push(args.contador)
        },
      })

      // Não foi pulado por "já bateu o teto" — é um commit que NUNCA falhou.
      expect(r.noOp).toBeFalsy()
      expect(posted.reviews).toHaveLength(1) // julgamento fresco: postou review nova
      expect(posted.merges).toHaveLength(1) // tentou mesclar o commit NOVO
      // Recomeçou do 1 — NÃO somou sobre o 3 que já estava gravado.
      expect(registrados).toEqual([1])
    })
  })

  // Item 2 (leva B2): um re-julgamento sem fim, mais estreito que o da
  // Tarefa 10 mas real — a verificação vira vermelha no MESMO commit depois
  // de uma aprovação nossa já postada. A trava determinística baixa o
  // veredito para "pedir mudanças" sem NUNCA chamar o GitHub para mesclar —
  // e o contador de fracasso de mescla só anda quando o GitHub É chamado
  // (Tarefa 10). Sem a correção, `.find` (reviews mais antigas primeiro)
  // sempre re-achava a aprovação ORIGINAL, e a entrega era reprocessada a
  // cada passagem: motor acionado, review nova e comentário de retrabalho
  // postados no PR do cliente, para sempre.
  describe('Item 2: verificação vira vermelha no MESMO commit depois de aprovado — o laço termina', () => {
    it('2a passagem (CI vermelho): reprova sem tentar mesclar; 3a passagem (mesmo par de reviews): já julgado, PARA de reprocessar', async () => {
      const sessao = linha({ issueNumber: 50, pullRequestNumber: 7, sessionName: 'sessions/7' })
      const opcoesComuns = {
        repository: 'o/r',
        githubToken: 't',
        sessoes: [sessao],
        registrarFracassoDeMerge: async (args: { contador: number }) => {
          sessao.mergeFailures = args.contador
        },
      }

      // 1a passagem: CI verde, aprova, tenta mesclar — o GitHub recusa
      // (fracasso #1, abaixo do teto). Mesmo ponto de partida do teste da
      // Tarefa 10: precisa de uma aprovação JÁ POSTADA no head atual.
      const f1 = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
        mergeFalha: true,
      })
      const posted1 = (f1 as unknown as { posted: { reviews: Array<{ body?: string }> } }).posted
      const r1 = await runQaMissionViaRails({
        ...opcoesComuns,
        execute: async () => APPROVE,
        fetchImpl: f1,
      })
      expect(r1.noOp).toBeFalsy()
      expect(sessao.mergeFailures).toBe(1)
      const corpoDaAprovacao = posted1.reviews[0]!.body as string

      // 2a passagem: MESMO commit ('abc123'), mas a verificação virou
      // VERMELHA (sem push novo do dev). `aindaPodeTentarMesclar` continua
      // `true` (1 fracasso < teto), então a entrega É reprocessada — mas a
      // trava determinística baixa o veredito para "pedir mudanças" porque
      // `ciState !== 'green'`, então o caminho de aprovação/merge nunca é
      // alcançado: nenhuma tentativa de merge, nenhum fracasso novo contado.
      const f2 = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [{ body: corpoDaAprovacao, commit_id: 'abc123' }],
          },
        ],
        undefined,
        undefined,
        { checkRuns: [{ conclusion: 'failure', status: 'completed' }] }
      )
      const posted2 = (
        f2 as unknown as { posted: { reviews: Array<{ body?: string }>; merges: unknown[] } }
      ).posted
      const r2 = await runQaMissionViaRails({
        ...opcoesComuns,
        execute: async () => APPROVE,
        fetchImpl: f2,
      })
      expect(r2.noOp).toBeFalsy() // foi reprocessada — o C1 da Tarefa 8 continua valendo
      expect(posted2.reviews).toHaveLength(1) // postou o "pedir mudanças" desta passagem
      expect(posted2.merges).toHaveLength(0) // NUNCA tentou mesclar com CI vermelho
      expect(sessao.mergeFailures).toBe(1) // o contador de MERGE não andou — não é essa a falha
      const corpoDaReprovacao = posted2.reviews[0]!.body as string

      // 3a passagem: o GitHub agora tem DUAS reviews nossas no MESMO commit
      // ('abc123') — a aprovação original E a reprovação da passagem
      // anterior, nesta ordem (a API sempre devolve mais antiga primeiro).
      // CI continua vermelho. SEM a correção, a busca pela review marcada
      // (mais antiga primeiro) reencontra a APROVAÇÃO original, trata a
      // entrega como "aprovação parada" e reprocessa de novo — motor
      // acionado, mais uma review e mais um comentário postados, para
      // sempre, sem nunca contar como fracasso de merge. COM a correção, a
      // review MAIS RECENTE (a reprovação) é a que conta: a entrega já foi
      // julgada, e a passagem é pulada — o mesmo desfecho de qualquer outra
      // reprovação normal.
      const f3 = fakeFetch(
        [
          {
            number: 7,
            user: 'jules[bot]',
            existingReviews: [
              { body: corpoDaAprovacao, commit_id: 'abc123' },
              { body: corpoDaReprovacao, commit_id: 'abc123' },
            ],
          },
        ],
        undefined,
        undefined,
        { checkRuns: [{ conclusion: 'failure', status: 'completed' }] }
      )
      const posted3 = (
        f3 as unknown as { posted: { reviews: unknown[]; comments: unknown[]; merges: unknown[] } }
      ).posted
      const r3 = await runQaMissionViaRails({
        ...opcoesComuns,
        execute: async () => {
          throw new Error('não deveria julgar de novo: a review mais recente já é reprovação')
        },
        fetchImpl: f3,
      })
      expect(r3.noOp).toBe(true) // já julgado — o laço TERMINA
      expect(posted3.reviews).toHaveLength(0)
      expect(posted3.comments).toHaveLength(0)
      expect(posted3.merges).toHaveLength(0)
      expect(sessao.mergeFailures).toBe(1) // continua o mesmo — nada mudou
    })
  })

  // Tarefa 7 — a vigília ativa da verificação substitui o pulo passivo pela
  // decisão de `decidirSobreVerificacao` (Tarefa 6). Os três casos abaixo são
  // o Step 6 do brief: (a) pendente recente, (b) pendente além do teto,
  // (c) verde depois de pendente — com a limpeza da marca PROVADA (R2 do
  // controlador), não só o julgamento.
  describe('Tarefa 7: a vigília da verificação', () => {
    it('(a) pendente recente: não julga, e grava a marca de pendência (primeiro avistamento)', async () => {
      const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
      })
      const posted = (f as unknown as { posted: { reviews: unknown[]; comments: unknown[] } })
        .posted
      const registradas: Array<{ sessionName: string; agora: Date }> = []
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar com verificação pendente')
        },
        // Nunca vista pendente antes (`pendingSince: null`) — é o PRIMEIRO
        // avistamento, o que `registrarPendencia` precisa marcar.
        sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7, sessionName: 'sessions/pend-a' })],
        registrarPendencia: async (args) => {
          registradas.push(args)
        },
        fetchImpl: f,
      })
      expect(r.noOp).toBe(true)
      expect(posted.reviews).toHaveLength(0)
      expect(posted.comments).toHaveLength(0)
      expect(registradas).toHaveLength(1)
      expect(registradas[0]!.sessionName).toBe('sessions/pend-a')
      expect(registradas[0]!.agora).toBeInstanceOf(Date)
    })

    it('(b) pendente além do teto: não julga, e avisa o dono UMA vez pelo mesmo canal do session-watch', async () => {
      const f = fakeFetch([{ number: 8, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
      })
      const posted = (f as unknown as { posted: { reviews: unknown[]; comments: unknown[] } })
        .posted
      const avisos: string[] = []
      const registradas: unknown[] = []
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar com verificação pendente')
        },
        // Vista pendente pela primeira vez bem além do teto de espera —
        // tempo real decorrido, não um relógio injetado (esta missão não
        // recebe `agora` de fora; a mesma folga de segundos que o teste leva
        // para rodar é irrelevante contra um teto de 90 minutos).
        sessoes: [
          linha({
            issueNumber: 51,
            pullRequestNumber: 8,
            sessionName: 'sessions/pend-b',
            reworkNoticePending: null,
            reworkNoticeAttempts: 0,
            pendingSince: new Date(Date.now() - (TETO_DE_ESPERA_MS + 5 * 60 * 1000)),
          }),
        ],
        avisarDono: async (mensagem) => {
          avisos.push(mensagem)
        },
        registrarPendencia: async (args) => {
          registradas.push(args)
        },
        fetchImpl: f,
      })
      expect(r.noOp).toBe(true)
      expect(posted.reviews).toHaveLength(0)
      expect(posted.comments).toHaveLength(0)
      expect(avisos).toHaveLength(1)
      expect(avisos[0]).toContain('#8')
      // Depois do teto a ação é `avisar-demora`, não `esperar` — a marca já
      // está gravada desde o primeiro avistamento; regravar não é o papel
      // deste ramo.
      expect(registradas).toHaveLength(0)
    })

    // Achado 2 da revisão da Tarefa 7: sem idempotência, `avisar-demora`
    // dispararia a cada tick do scheduler (~1min) — o dono seria avisado a
    // cada minuto, para sempre, depois do teto. A correção reaproveita
    // `answeredHash`/`hashDaMensagem`, a MESMA disciplina que
    // `session-watch.ts` já usa para o ramo `investigar`
    // ("SPAM apaga sinal tanto quanto silêncio").
    it('avisar-demora consecutivo para o MESMO commit parado NÃO avisa de novo', async () => {
      const pendingSince = new Date(Date.now() - (TETO_DE_ESPERA_MS + 5 * 60 * 1000))

      // Primeira passagem: nunca avisado (answeredHash: null) — avisa e
      // grava o hash amarrado ao commit parado.
      const f1 = fakeFetch([{ number: 11, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
        headSha: 'commit-parado',
      })
      const avisos1: string[] = []
      const marcas: Array<{ sessionName: string; hash: string }> = []
      await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar')
        },
        sessoes: [
          linha({
            issueNumber: 52,
            pullRequestNumber: 11,
            sessionName: 'sessions/pend-d',
            pendingSince,
            answeredHash: null,
          }),
        ],
        avisarDono: async (mensagem) => {
          avisos1.push(mensagem)
        },
        registrarAvisoDeDemora: async (args) => {
          marcas.push(args)
        },
        fetchImpl: f1,
      })
      expect(avisos1).toHaveLength(1)
      expect(marcas).toHaveLength(1)
      expect(marcas[0]!.sessionName).toBe('sessions/pend-d')

      // Segunda passagem, próximo tick: MESMO commit ('commit-parado'), com
      // o hash da primeira já persistido na linha (simula o que
      // `registrarAvisoDeDemora` teria gravado) — nada mudou de verdade.
      const f2 = fakeFetch([{ number: 11, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
        headSha: 'commit-parado',
      })
      const avisos2: string[] = []
      await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar')
        },
        sessoes: [
          linha({
            issueNumber: 52,
            pullRequestNumber: 11,
            sessionName: 'sessions/pend-d',
            pendingSince,
            answeredHash: marcas[0]!.hash,
          }),
        ],
        avisarDono: async (mensagem) => {
          avisos2.push(mensagem)
        },
        fetchImpl: f2,
      })
      expect(avisos2).toHaveLength(0)
    })

    it('novo push (commit muda) enquanto a verificação segue parada: avisa de novo — a situação mudou de verdade', async () => {
      const pendingSince = new Date(Date.now() - (TETO_DE_ESPERA_MS + 5 * 60 * 1000))

      const f1 = fakeFetch([{ number: 12, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
        headSha: 'commit-1',
      })
      const avisos1: string[] = []
      const marcas: Array<{ sessionName: string; hash: string }> = []
      await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar')
        },
        sessoes: [
          linha({
            issueNumber: 53,
            pullRequestNumber: 12,
            sessionName: 'sessions/pend-e',
            pendingSince,
            answeredHash: null,
          }),
        ],
        avisarDono: async (mensagem) => {
          avisos1.push(mensagem)
        },
        registrarAvisoDeDemora: async (args) => {
          marcas.push(args)
        },
        fetchImpl: f1,
      })
      expect(avisos1).toHaveLength(1)

      // O dev empurrou algo novo enquanto a verificação seguia pendente: o
      // head mudou. O hash amarrado ao commit ANTERIOR não bate mais.
      const f2 = fakeFetch([{ number: 12, user: 'jules[bot]' }], undefined, undefined, {
        checkRuns: [{ status: 'in_progress' }],
        headSha: 'commit-2',
      })
      const avisos2: string[] = []
      await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => {
          throw new Error('não deveria julgar')
        },
        sessoes: [
          linha({
            issueNumber: 53,
            pullRequestNumber: 12,
            sessionName: 'sessions/pend-e',
            pendingSince,
            answeredHash: marcas[0]!.hash,
          }),
        ],
        avisarDono: async (mensagem) => {
          avisos2.push(mensagem)
        },
        fetchImpl: f2,
      })
      expect(avisos2).toHaveLength(1)
    })

    it('(c) verde depois de pendente: julga normalmente, e PROVA que limparPendencia foi chamada para esta sessão (R2)', async () => {
      const f = fakeFetch([{ number: 9, user: 'jules[bot]' }]) // default: checkRuns 'success' -> ciState green
      const posted = (f as unknown as { posted: { reviews: Array<{ event?: string }> } }).posted
      const limpezas: Array<{ sessionName: string }> = []
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        // Esteve pendente antes (marca presente) — agora a verificação saiu
        // verde, então a decisão é `julgar` e a marca tem que sair.
        sessoes: [
          linha({
            issueNumber: 50,
            pullRequestNumber: 9,
            sessionName: 'sessions/pend-c',
            reworkNoticePending: null,
            reworkNoticeAttempts: 0,
            pendingSince: new Date(Date.now() - 10 * 60 * 1000),
          }),
        ],
        limparPendencia: async (args) => {
          limpezas.push(args)
        },
        fetchImpl: f,
      })
      // Não basta ter julgado — R2 exige provar que a limpeza aconteceu PARA
      // ESTA sessão, não só que o julgamento seguiu adiante.
      expect(limpezas).toHaveLength(1)
      expect(limpezas[0]!.sessionName).toBe('sessions/pend-c')
      // E o julgamento de fato aconteceu (a limpeza não substitui o resto do
      // fluxo, só acontece a caminho dele).
      expect(r.noOp).toBeUndefined()
      expect(posted.reviews[0]!.event).toBe('APPROVE')
    })

    it('verde sem NUNCA ter estado pendente: julga normalmente, e limparPendencia NÃO é chamada (nada para limpar)', async () => {
      const f = fakeFetch([{ number: 10, user: 'jules[bot]' }])
      const limpezas: unknown[] = []
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        sessoes: [linha({ issueNumber: 50, pullRequestNumber: 10, pendingSince: null })],
        limparPendencia: async (args) => {
          limpezas.push(args)
        },
        fetchImpl: f,
      })
      expect(r.noOp).toBeUndefined()
      expect(limpezas).toHaveLength(0)
    })
  })

  // Task 8 (decisão do dono 15/08/2026): "julga todos, mescla só o que
  // delegou". O quase-acidente que motiva isto: um PR de HUMANO citou o
  // número de uma issue no corpo de um relatório, e o QA quase confundiu a
  // citação com entrega do dev assíncrono — com merge automático ligado,
  // teria mesclado sozinho trabalho de humano. A separação fica em DUAS
  // decisões: julgar (sempre) e mesclar (só quando `ehPrDelegado` prova
  // autoria). Esta suíte prova a metade do juiz: o filtro que descartava
  // entregas não-delegadas na origem (linhas ~199-224 antes desta mudança)
  // sai; `podeMesclar` no resultado espelha `delegado`, independente do
  // veredito — é o campo que a Tarefa 9 usa para travar o merge por fora.
  describe('Tarefa 8: o juiz julga toda entrega, mescla só a delegada', () => {
    it('entrega de humano (sem sessão, sem menção a issue delegada): recebe parecer, mas não pode mesclar, e NUNCA um evento de aprovação formal', async () => {
      const f = fakeFetch([
        {
          number: 40,
          user: 'loureng',
          body: 'Ajuste de documentação, sem relação com nenhuma tarefa do GitOrch',
        },
      ])
      const posted = (
        f as unknown as {
          posted: { reviews: Array<{ event?: string }>; merges: unknown[] }
        }
      ).posted
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE, // o motor manda aprovar — o evento formal tem que ser rebaixado mesmo assim
        fetchImpl: f,
      })
      // Não é mais descartado na origem — o QA examinou a entrega e emitiu
      // parecer (é o oposto do no-op que este mesmo cenário produzia antes).
      expect(r.noOp).toBeUndefined()
      expect(posted.reviews).toHaveLength(1)
      // Achado A da revisão independente da Tarefa 8: uma entrega NÃO
      // delegada nunca pode receber `event: APPROVE` — numa proteção de
      // branch que exige "1 approving review", isso tornaria o PR de humano
      // mesclável (por qualquer pessoa, ou por auto-merge) sem que ninguém
      // de verdade tivesse aprovado. O parecer sai como COMMENT, sempre.
      expect(posted.reviews[0]!.event).toBe('COMMENT')
      expect(posted.reviews[0]!.event).not.toBe('APPROVE')
      // A prova real de que a função de mesclar nunca foi chamada: nenhuma
      // chamada PUT .../merge saiu, não só que `aoMesclar` ficou quieto.
      expect(posted.merges).toHaveLength(0)
      expect(r.podeMesclar).toBe(false)
    })

    it('entrega delegada (com linha de sessão): julgada e pode mesclar', async () => {
      const f = fakeFetch([{ number: 41, user: 'loureng' }], ['jules', 'gitorch:task'])
      const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        // Caminho autoritativo de `ehPrDelegado`: a linha guardada, não o
        // recuo pelo login (aqui deliberadamente humano, 'loureng').
        sessoes: [linha({ issueNumber: 50, pullRequestNumber: 41 })],
        fetchImpl: f,
      })
      expect(r.noOp).toBeUndefined()
      expect(posted.reviews).toHaveLength(1)
      expect(posted.merges).toHaveLength(1)
      expect(r.podeMesclar).toBe(true)
    })

    it('entrega de humano reprovada: parecer de mudanças postado como COMMENT (nunca review formal), ainda sem merge', async () => {
      const f = fakeFetch([
        { number: 42, user: 'loureng', body: 'PR isolado, sem issue vinculada' },
      ])
      const posted = (
        f as unknown as {
          posted: {
            reviews: Array<{ event?: string; body?: string }>
            comments: unknown[]
            merges: unknown[]
          }
        }
      ).posted
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => REQUEST_CHANGES,
        fetchImpl: f,
      })
      // Achado A da revisão independente da Tarefa 8: entrega NÃO delegada
      // nunca recebe evento FORMAL de review (nem APPROVE, nem
      // REQUEST_CHANGES) — só COMMENT. Um REQUEST_CHANGES formal também
      // participa da proteção de branch (conta como revisão feita), então o
      // mesmo cuidado do achado de aprovação vale aqui.
      expect(posted.reviews[0]!.event).toBe('COMMENT')
      // O parecer deixa explícito, em linguagem de negócio, que o GitOrch
      // opinou mas não vai mesclar — quem decide é a pessoa dona do PR.
      expect(posted.reviews[0]!.body).toContain('NÃO vai mesclá-lo')
      // Sem @jules: essa entrega não tem dev assíncrono nenhum para
      // retrabalhar — o comentário de rework é específico da esteira do
      // Jules e não se aplica a uma entrega que o produto não encomendou.
      expect(posted.comments).toHaveLength(0)
      expect(posted.merges).toHaveLength(0)
      expect(r.podeMesclar).toBe(false)
    })

    it('mistura de entregas (humano + delegada) abertas juntas: as duas são julgadas ao longo da fila, só a delegada mescla', async () => {
      // Ciclo 1: a entrega de humano (#50) ainda não tem parecer neste head
      // — é a candidata desta passagem pela fila. A delegada (#51) segue
      // aberta, sem ser tocada ainda.
      const fCiclo1 = fakeFetch([
        {
          number: 50,
          user: 'loureng',
          body: 'Ajuste isolado, sem relação com o que o produto delegou',
        },
        { number: 51, user: 'jules[bot]' },
      ])
      const posted1 = (
        fCiclo1 as unknown as {
          posted: { reviews: Array<{ body?: string }>; merges: Array<{ number: number }> }
        }
      ).posted
      const r1 = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        fetchImpl: fCiclo1,
      })
      expect(r1.podeMesclar).toBe(false) // pegou a entrega de humano (#50)
      expect(posted1.reviews).toHaveLength(1)
      expect(posted1.merges).toHaveLength(0)
      const parecerDoHumano = posted1.reviews[0]!.body as string

      // Ciclo 2 (mesma passagem pela fila de entregas abertas): a entrega de
      // humano já tem parecer marcado neste head — não é rejulgada (a
      // mesma guarda contra opinião duplicada vale para humano). A
      // delegada, ainda sem parecer, é a candidata desta vez.
      const fCiclo2 = fakeFetch([
        {
          number: 50,
          user: 'loureng',
          body: 'Ajuste isolado, sem relação com o que o produto delegou',
          existingReviews: [{ body: parecerDoHumano, commit_id: 'abc123' }],
        },
        { number: 51, user: 'jules[bot]' },
      ])
      const posted2 = (
        fCiclo2 as unknown as {
          posted: { reviews: unknown[]; merges: Array<{ number: number; body: unknown }> }
        }
      ).posted
      const r2 = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        fetchImpl: fCiclo2,
      })
      expect(r2.podeMesclar).toBe(true) // agora pegou a delegada (#51)
      // Só julgou a delegada nesta passagem — a de humano ficou de fora,
      // porque já tinha sido julgada no ciclo 1 (nada de opinião duplicada).
      expect(posted2.reviews).toHaveLength(1)
      // Das duas entregas julgadas ao longo da fila (50 no ciclo 1, 51 no
      // ciclo 2), só a delegada foi mesclada.
      expect(posted2.merges).toHaveLength(1)
      expect(posted2.merges[0]!.number).toBe(51)
    })

    it('entrega de humano cujo corpo diz "Closes #N" (sem sessão): parecer sai, mas NÃO escreve label nem move card no board do cliente', async () => {
      // Achado B da revisão independente da Tarefa 8: body default do
      // fixture é 'Closes #50' — a MESMA forma de citação de texto do
      // quase-acidente original (PR #99), agora sem sessão nenhuma por trás.
      // `ehPrDelegado` não reconhece isto como delegado (falta a sessão que
      // o caminho 3 exige), mas `linkedIssue`, mais abaixo neste módulo, cai
      // no MESMO recuo fraco (regex sobre o corpo) para achar a issue #50.
      const f = fakeFetch([{ number: 45, user: 'loureng' }])
      const posted = (
        f as unknown as {
          posted: {
            reviews: unknown[]
            labels: Array<{ number: number; method: string; labels?: string[] }>
          }
        }
      ).posted
      const moveCardCalls: Array<{ issue: number; column: string }> = []
      const moveCard = async (issue: number, column: string) => {
        moveCardCalls.push({ issue, column })
        return `card #${issue} -> ${column} (set)`
      }
      const r = await runQaMissionViaRails({
        repository: 'o/r',
        githubToken: 't',
        execute: async () => APPROVE,
        moveCard,
        fetchImpl: f,
      })
      // O julgamento e o parecer continuam saindo para QUALQUER entrega — a
      // regra do dono ("julga todos") não muda com este achado.
      expect(r.noOp).toBeUndefined()
      expect(posted.reviews).toHaveLength(1)
      expect(r.podeMesclar).toBe(false)
      // A parte que o achado B corrige: nenhuma escrita na infraestrutura do
      // CLIENTE (label da issue, card do board) para trabalho que ele não
      // encomendou — só a citação de texto não é prova de entrega, no board
      // igual já era no merge.
      expect(posted.labels).toHaveLength(0)
      expect(moveCardCalls).toHaveLength(0)
    })
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
      // fix/pr-humano-nao-e-entrega-do-dev: `prAberta` usa "closes #3" +
      // issue #3 com label `jules`, sem "jules" no login (`app/gitorch-ai`)
      // — o caminho 3 agora exige sessão real para essa issue (ver
      // pr-delegado.test.ts, caso real do PR #99). Na produção a SM grava a
      // linha ANTES do dev assíncrono abrir o PR, então este cenário sempre
      // tem sessão disponível.
      sessoes: [linha({ issueNumber: 3, pullRequestNumber: null })],
      fetchImpl: impl,
    })

    expect(r.exitCode).toBe(0)
    const reviews = chamadas.filter((c) => c.method === 'POST' && c.path.includes('/reviews'))
    expect(reviews.length).toBeGreaterThanOrEqual(2)
    expect((reviews.at(-1)!.body as { event?: string }).event).toBe('COMMENT')
  })
})

// Task 15 fechava a tarefa entregue por aqui, no instante do merge — a
// cobertura daquele comportamento (fechar, não fechar duas vezes, falha de
// permissão nunca engolida) migrou para `fechar-tarefa.test.ts` (a decisão
// pura, inalterada) e para os testes de `varrerPublicacoes` em
// `scheduler.ts` (Leva B: o NOVO ponto de disparo, que só fecha a tarefa
// quando a publicação confirma a entrega — ver `resolverEntregaDoBoard`).

describe('teto de tempo (leva D)', () => {
  it('toda chamada ao GitHub (review, merge incluídos) carrega um AbortSignal não abortado', async () => {
    const base = fakeFetch([{ number: 7, user: 'google-labs-jules[bot]' }])
    const spy = vi.fn(base)
    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: spy as unknown as typeof fetch,
    })
    expect(r.exitCode).toBe(0)
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    for (const call of spy.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})

// ── O beco sem saída da janela cega (22/08/2026) ───────────────────────────
//
// Entre a abertura do pull request e a gravação da ligação issue↔sessão houve
// uma janela de seis horas e meia (medida no PR #132, 20/08). Dentro dela o
// julgamento não achava a linha da sessão e concluía que a entrega era de
// terceiro.
//
// Para uma APROVAÇÃO isso já tinha saída: a exceção C1 reexamina aprovação
// com PR ainda aberto. Para uma REPROVAÇÃO não tinha nenhuma, e é aí que o
// estrago era permanente e mudo:
//
//   1. o parecer sai como reprovação, com o aviso de que o produto não vai
//      mesclar — escrito no pull request do CLIENTE, sobre trabalho que o
//      produto encomendou;
//   2. o pedido de retrabalho ao dev NÃO é enviado, porque esse envio é
//      reservado a entregas delegadas — e naquele instante o produto achava
//      que esta não era;
//   3. no ciclo seguinte, `foiAprovacao` é falso, a entrega é tratada como
//      julgada e é pulada PARA SEMPRE.
//
// Resultado: pull request reprovado, dev que nunca soube que precisava
// retrabalhar, e ninguém para reabrir o caso. Sem erro em log nenhum.
describe('reprovação emitida sob premissa errada é REFEITA quando a ligação chega', () => {
  const reprovacaoSemPoderDeMesclar =
    '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).\n\n' +
    '<!-- gitorch:qa:sem-poder-de-mesclar -->\n' +
    'GitOrch analisou este PR e registrou o parecer acima, mas NÃO vai mesclá-lo: esta ' +
    'entrega não foi encomendada pelo produto. A decisão de aceitar este código é sua, como ' +
    'autor do PR.'

  function prReprovadoNaJanelaCega(corpoDaReview: string) {
    return fakeFetch(
      [
        {
          number: 7,
          user: 'loureng',
          body: 'sem palavra de ligação nenhuma',
          existingReviews: [{ body: corpoDaReview, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
  }

  it('volta a ser julgada, e agora o dev É avisado do retrabalho', async () => {
    const f = prReprovadoNaJanelaCega(reprovacaoSemPoderDeMesclar)
    const posted = (
      f as unknown as { posted: { reviews: Array<{ event?: string }>; comments: unknown[] } }
    ).posted
    const avisosAoDev: Array<{ sessionName: string; texto: string }> = []

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
      // A LIGAÇÃO CHEGOU: é isto que muda a premissa.
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7, sessionName: 'sessions/9' })],
      avisarSessao: async (a) => {
        avisosAoDev.push(a)
        return true
      },
    })

    expect(r.noOp).toBeFalsy()
    expect(posted.reviews).toHaveLength(1)
    // O que estava faltando e ninguém via: o pedido de retrabalho chegando ao
    // dev. Sem a ligação, ele nunca era enviado — e o PR ficava esperando um
    // retrabalho que ninguém tinha pedido.
    expect(avisosAoDev).toHaveLength(1)
    expect(avisosAoDev[0]!.sessionName).toBe('sessions/9')
    expect(posted.comments.length).toBeGreaterThan(0)
  })

  it('o parecer novo NÃO repete o aviso de que não vai mesclar', async () => {
    // Se repetisse, o cliente leria duas vezes, no mesmo pull request, que a
    // entrega dele não foi encomendada — e a segunda vez seria falsa.
    const f = prReprovadoNaJanelaCega(reprovacaoSemPoderDeMesclar)
    const posted = (f as unknown as { posted: { reviews: Array<{ body?: string }> } }).posted

    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(posted.reviews[0]!.body).not.toContain('não foi encomendada pelo produto')
    expect(posted.reviews[0]!.body).not.toContain('sem-poder-de-mesclar')
  })

  it('SEM a ligação, continua pulado — a premissa não mudou, não há o que refazer', async () => {
    // A guarda contra transformar o conserto em spam: o parecer sobre entrega
    // de humano continua sendo julgamento final, como sempre foi.
    const f = fakeFetch([
      {
        number: 9,
        user: 'loureng',
        body: 'PR de humano',
        existingReviews: [{ body: reprovacaoSemPoderDeMesclar, commit_id: 'abc123' }],
      },
    ])
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })

  it('reprovação de entrega JÁ delegada continua pulada — o dev ainda não retrabalhou', async () => {
    // A outra metade da guarda, e a mais importante: a reprovação normal (sem
    // a marca) segue sendo julgamento final no mesmo commit. Refazer aqui
    // seria opinar de novo sobre um código que não mudou.
    const f = prReprovadoNaJanelaCega(
      '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).'
    )
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })

  it('o teto de tentativas de merge continua valendo — refazer não é licença para insistir', async () => {
    const f = prReprovadoNaJanelaCega(reprovacaoSemPoderDeMesclar)
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
      sessoes: [
        linha({ issueNumber: 50, pullRequestNumber: 7, mergeFailures: MAX_TENTATIVAS_DE_MERGE }),
      ],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })

  it('LEGADO: o parecer publicado ANTES da marca também destrava', async () => {
    // Os pareceres que motivaram esta tarefa não têm marcador — só a frase em
    // português. Ignorá-los deixaria presos exatamente os pull requests que o
    // conserto existe para soltar.
    const f = prReprovadoNaJanelaCega(
      '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).\n\n' +
        'GitOrch analisou este PR e registrou o parecer acima, mas NÃO vai mesclá-lo: esta ' +
        'entrega não foi encomendada pelo produto. A decisão de aceitar este código é sua, ' +
        'como autor do PR.'
    )
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => REQUEST_CHANGES,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(posted.reviews).toHaveLength(1)
  })
})

// ── O achado ALTO da lente (22/08/2026) ────────────────────────────────────
//
// O rejulgamento por premissa errada quase virou uma escalada de privilégio.
// `ehPrDelegado` tem um ramo frouxo — "o corpo cita Fixes #N + a issue está
// etiquetada + existe ALGUMA sessão para aquela issue" — que basta para
// decidir se vale opinar, mas NÃO para reabrir um parecer já publicado.
//
// A sequência concreta: um humano abre o pull request citando `Fixes #74`
// como referência; o produto opina e escreve, no PR dele, "NÃO vou mesclá-lo,
// a decisão é sua"; depois o SM delega a issue #74 de verdade e cria a linha
// de sessão. No ciclo seguinte, sem esta guarda, o produto rejulgaria o PR do
// HUMANO, aprovaria formalmente e chamaria o merge — mesclando o pull request
// que prometeu publicamente não mesclar, no repositório do cliente.
//
// A ligação que autoriza refazer é a sessão apontando para ESTE pull request,
// não um palpite pelo corpo.
describe('rejulgar não pode virar licença para mesclar PR de humano', () => {
  it('sessão existe para a issue, mas aponta para OUTRO PR: continua pulado', async () => {
    const parecerPublicado =
      '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).\n\n' +
      '<!-- gitorch:qa:sem-poder-de-mesclar -->\n' +
      'GitOrch analisou este PR e registrou o parecer acima, mas NÃO vai mesclá-lo: esta ' +
      'entrega não foi encomendada pelo produto.'

    const f = fakeFetch(
      [
        {
          number: 99,
          user: 'loureng',
          body: 'Fixes #50 — referência, não entrega delegada',
          existingReviews: [{ body: parecerPublicado, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      // A sessão existe para a issue #50 — mas foi aberta para o PR #7, não
      // para o #99 deste humano.
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
    expect(posted.merges).toHaveLength(0)
  })

  it('sessão SEM pull request nenhum ainda: também continua pulado', async () => {
    const parecerPublicado =
      '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).\n\n' +
      '<!-- gitorch:qa:sem-poder-de-mesclar -->\nnão foi encomendada pelo produto.'

    const f = fakeFetch(
      [
        {
          number: 99,
          user: 'loureng',
          body: 'Fixes #50',
          existingReviews: [{ body: parecerPublicado, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: null })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })
})

// ── A reprovação que veio do PORTÃO, não do código (23/08/2026) ────────────
//
// O produto tem uma trava determinística: motor diz "aprovar", verificação não
// está verde, veredito é rebaixado para "pedir mudanças". A trava está certa —
// aprovar com CI vermelho seria mesclar no escuro.
//
// O que faltava era a VOLTA. Essa reprovação não diz nada sobre a qualidade da
// entrega: diz que, naquele instante, o portão estava fechado. Quando a
// verificação fica verde depois no MESMO commit — reexecução, teste instável
// que passou na segunda, conserto de infraestrutura —, o motivo deixou de
// existir e ninguém voltava atrás.
//
// ISSO TRAVOU UM PROJETO INTEIRO. Medido no banco: loureng/patinhas-3d-crafts
// com ZERO entregas mescladas em treze sessões, contra sete de dezoito no
// gitorch, com as missões rodando igual nos dois. O PR #3768 estava CLEAN, com
// a verificação inteira verde, e a única review nossa no head atual era um
// "pedir mudanças" emitido quando o CI ainda estava vermelho.
describe('reprovação pelo PORTÃO volta a ser julgada quando o CI fica verde', () => {
  const reprovadoPeloPortao =
    '<!-- gitorch:qa -->\n<!-- gitorch:qa:reprovado-pelo-portao -->\n' +
    'GitOrch QA verdict: REQUEST CHANGES (see comment).'

  const reprovadoPeloCodigo =
    '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).'

  it('CI VERDE agora: a entrega volta a ser julgada e é mesclada', async () => {
    const f = fakeFetch(
      [
        {
          number: 7,
          user: 'jules[bot]',
          existingReviews: [{ body: reprovadoPeloPortao, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { merges: unknown[]; reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(r.noOp).toBeFalsy()
    expect(posted.reviews).toHaveLength(1)
    expect(posted.merges).toHaveLength(1)
  })

  it('CI ainda VERMELHO: NÃO rejulga — senão vira opinião repetida a cada ciclo', async () => {
    // A guarda que impede o laço. Sem ela, o rejulgamento produziria a mesma
    // reprovação e postaria outra review no pull request do cliente, sem fim.
    const f = fakeFetch(
      [
        {
          number: 7,
          user: 'jules[bot]',
          existingReviews: [{ body: reprovadoPeloPortao, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50,
      { checkRuns: [{ status: 'completed', conclusion: 'failure' }] }
    )
    const posted = (f as unknown as { posted: { reviews: unknown[]; merges: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
    expect(posted.merges).toHaveLength(0)
  })

  it('reprovação de CÓDIGO continua sendo final — o dev é que tem de agir', async () => {
    // A metade mais importante da guarda: só a reprovação do PORTÃO volta.
    // Reabrir reprovação de código seria opinar de novo sobre um diff que não
    // mudou.
    const f = fakeFetch(
      [
        {
          number: 9,
          user: 'jules[bot]',
          existingReviews: [{ body: reprovadoPeloCodigo, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 9 })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })

  it('o teto de tentativas de merge continua valendo', async () => {
    const f = fakeFetch(
      [
        {
          number: 7,
          user: 'jules[bot]',
          existingReviews: [{ body: reprovadoPeloPortao, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { merges: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [
        linha({ issueNumber: 50, pullRequestNumber: 7, mergeFailures: MAX_TENTATIVAS_DE_MERGE }),
      ],
    })

    expect(r.noOp).toBe(true)
    expect(posted.merges).toHaveLength(0)
  })
})

// ── O achado ALTO da lente: diff truncado NÃO pode reabrir ────────────────
//
// O rebaixamento tem duas causas: verificação não-verde e diff que não coube.
// Marcar as duas igual criaria um laço sem fim, porque `truncado` é
// determinístico para o mesmo commit — mesmos arquivos, mesmo resultado,
// sempre. O ciclo seria: rejulga porque o CI ficou verde → o motor aprova →
// truncado continua verdadeiro → rebaixa de novo → posta outra review →
// rejulga de novo, para sempre.
//
// E o teto de tentativas NÃO fecharia esse laço: `mergeFailures` só avança
// quando o GitHub é chamado para mesclar, e isso nunca acontece enquanto o
// veredito é rebaixado. Seria opinião repetida no pull request do cliente, a
// cada tique, sem nada para segurar.
describe('diff grande demais continua sendo reprovação FINAL', () => {
  it('rebaixamento por diff truncado NÃO ganha a marca do portão', async () => {
    // Sem isto, o próximo ciclo reabriria e o laço começaria.
    const f = fakeFetch([{ number: 7, user: 'jules[bot]' }], ['jules', 'gitorch:task'], 50, {
      patchArquivoUnico: 'x'.repeat(200_000),
    })
    const posted = (f as unknown as { posted: { reviews: Array<{ body?: string }> } }).posted

    await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(posted.reviews).toHaveLength(1)
    expect(posted.reviews[0]!.body).not.toContain('reprovado-pelo-portao')
  })

  it('e por isso o ciclo seguinte NÃO reabre a entrega', async () => {
    // A prova do laço que não acontece: uma reprovação sem a marca é final,
    // mesmo com o CI verde.
    const semMarca = '<!-- gitorch:qa -->\nGitOrch QA verdict: REQUEST CHANGES (see comment).'
    const f = fakeFetch(
      [
        {
          number: 7,
          user: 'jules[bot]',
          existingReviews: [{ body: semMarca, commit_id: 'abc123' }],
        },
      ],
      ['jules', 'gitorch:task'],
      50
    )
    const posted = (f as unknown as { posted: { reviews: unknown[] } }).posted

    const r = await runQaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: async () => APPROVE,
      fetchImpl: f,
      sessoes: [linha({ issueNumber: 50, pullRequestNumber: 7 })],
    })

    expect(r.noOp).toBe(true)
    expect(posted.reviews).toHaveLength(0)
  })
})
