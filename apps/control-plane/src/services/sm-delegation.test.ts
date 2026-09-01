import { describe, it, expect, vi } from 'vitest'
import { runSmDelegation, extractBlockers } from './sm-delegation.js'
import type { LinhaDeSessao } from './dev-session-store.js'

describe('extractBlockers', () => {
  it('lê "Blocked by #N, #M" do corpo', () => {
    expect(extractBlockers('foo\n\nBlocked by #12, #34\nbar')).toEqual([12, 34])
  })
  it('sem bloqueio → []', () => {
    expect(extractBlockers('nada aqui')).toEqual([])
  })
})

interface FakeIssue {
  number: number
  labels: string[]
  body: string
  state?: string
  title?: string
}

function fakeFetch(issues: FakeIssue[], closed: number[] = []) {
  const labeled: Array<{ number: number; labels: string[] }> = []
  const removed: Array<{ number: number; label: string }> = []
  const byNumber = new Map(issues.map((i) => [i.number, i]))
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

    // lista de tasks abertas com label gitorch:task
    if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
      return json(
        issues.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((n) => ({ name: n })),
          body: i.body,
        }))
      )
    }
    // estado de um blocker
    const m = u.match(/\/issues\/(\d+)$/)
    if (m && method === 'GET') {
      const n = Number(m[1])
      return json({ number: n, state: closed.includes(n) ? 'closed' : 'open' })
    }
    // PRs que referenciam a issue (nenhuma, para simplificar)
    if (u.includes('/issues?') && u.includes('linked')) return json([])
    // remover label (rotação do label de agente)
    const dm = u.match(/\/issues\/(\d+)\/labels\/([^/]+)$/)
    if (dm && method === 'DELETE') {
      const n = Number(dm[1])
      const label = decodeURIComponent(dm[2]!)
      removed.push({ number: n, label })
      const issue = byNumber.get(n)
      if (issue) issue.labels = issue.labels.filter((l) => l !== label)
      return json({})
    }
    // aplicar label
    const lm = u.match(/\/issues\/(\d+)\/labels$/)
    if (lm && method === 'POST') {
      const n = Number(lm[1])
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      labeled.push({ number: n, labels: body.labels })
      byNumber.get(n)?.labels.push(...body.labels)
      return json([])
    }
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { labeled: typeof labeled }).labeled = labeled
  ;(impl as unknown as { removed: typeof removed }).removed = removed
  return impl
}

describe('runSmDelegation', () => {
  it('delega task pronta; NÃO delega task com sessão viva', async () => {
    // #11 já carrega a etiqueta `jules`, mas isso sozinho não a tira da fila
    // (é exatamente o defeito que fazia #46/#47/#48 morrerem em silêncio). O
    // que a tira da fila é ter uma linha viva em `sessoesVivas`.
    const f = fakeFetch([
      { number: 10, labels: ['gitorch:task'], body: 'sem bloqueio' },
      { number: 11, labels: ['gitorch:task', 'jules'], body: 'sessão em andamento' },
    ])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      sessoesVivas: [
        {
          id: 'x',
          projectId: 'p',
          issueNumber: 11,
          sessionName: 's',
          state: 'IN_PROGRESS',
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
        },
      ],
    })
    const delegateCalls = labeled.filter((l) => l.labels.includes('jules'))
    expect(delegateCalls.map((l) => l.number)).toEqual([10])
    expect(r.delegated).toEqual([10])
  })

  it('task com blocker AINDA aberto NÃO é delegada; com blocker fechado é', async () => {
    const f = fakeFetch(
      [
        { number: 20, labels: ['gitorch:task'], body: 'Blocked by #99' }, // #99 aberto
        { number: 21, labels: ['gitorch:task'], body: 'Blocked by #98' }, // #98 fechado
      ],
      [98]
    )
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    await runSmDelegation({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    const delegateCalls = labeled.filter((l) => l.labels.includes('jules'))
    expect(delegateCalls.map((l) => l.number)).toEqual([21])
  })

  it('respeita o cap de delegação por ciclo', async () => {
    const f = fakeFetch([
      { number: 1, labels: ['gitorch:task'], body: '' },
      { number: 2, labels: ['gitorch:task'], body: '' },
      { number: 3, labels: ['gitorch:task'], body: '' },
    ])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    await runSmDelegation({ repository: 'o/r', githubToken: 't', cap: 2, fetchImpl: f })
    const delegateCalls = labeled.filter((l) => l.labels.includes('jules'))
    expect(delegateCalls).toHaveLength(2)
  })

  it('ao delegar, marca gitorch:agent:jules e tira o agente anterior (ex.: gitorch:agent:po)', async () => {
    const f = fakeFetch([
      { number: 30, labels: ['gitorch:task', 'gitorch:agent:po'], body: 'sem bloqueio' },
    ])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    const removed = (f as unknown as { removed: Array<{ number: number; label: string }> }).removed

    await runSmDelegation({ repository: 'o/r', githubToken: 't', fetchImpl: f })

    expect(labeled.some((l) => l.number === 30 && l.labels.includes('gitorch:agent:jules'))).toBe(
      true
    )
    expect(removed).toEqual([{ number: 30, label: 'gitorch:agent:po' }])
  })

  // CAUSA RAIZ 29/08: a esteira do gitorch parou porque as 15 linhas abertas
  // do projeto estavam TODAS em COMPLETED (o Jules já tinha entregue) e o
  // contador de concorrência as somava contra o teto de 15 → folga zero → o SM
  // não delegava mais nada, com dezenas de tasks prontas esperando.
  it('sessão COMPLETED não trava a delegação — a vaga já liberou no Jules', async () => {
    const quinzeCompletas: LinhaDeSessao[] = Array.from({ length: 15 }, (_, i) => ({
      id: `s${i}`,
      projectId: 'p',
      issueNumber: 900 + i,
      sessionName: `sessions/completa-${i}`,
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
    }))
    const f = fakeFetch([{ number: 51, labels: ['gitorch:task'], body: 'pronta' }])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      sessoesVivas: quinzeCompletas,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(r.delegated).toEqual([51])
    expect(labeled.filter((l) => l.labels.includes('jules')).map((l) => l.number)).toEqual([51])
  })

  it('ocupamVagaNaConta no teto: a conta cheia por OUTRO projeto barra a delegação aqui', async () => {
    const f = fakeFetch([{ number: 52, labels: ['gitorch:task'], body: 'pronta' }])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      sessoesVivas: [], // este projeto está vazio…
      ocupamVagaNaConta: 15, // …mas a conta já está no teto por outro projeto
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(r.delegated).toEqual([])
    expect(labeled.filter((l) => l.labels.includes('jules'))).toEqual([])
  })
})

// Desejo do dono: delegar tem de ACIONAR o dev assíncrono. Antes disto o SM
// aplicava o label e terminava — e, se ninguém estivesse escutando, a esteira
// morria ali em silêncio (medido: uma task P0 delegada, treze missões depois,
// nenhum PR). Agora a delegação cria uma sessão de trabalho com identificador,
// que o SM registra na saída para poder ser cobrada.
describe('runSmDelegation: aciona o dev assíncrono', () => {
  // fábrica, não constante: o fetch falso MUTA os labels da issue ao delegar —
  // compartilhar o objeto faria o segundo teste ver a task já delegada.
  const taskPronta = (): FakeIssue => ({
    number: 42,
    title: 'Corrigir emissão de token',
    labels: ['gitorch:task'],
    body: 'sem bloqueio',
  })

  it('ao delegar, cria a sessão do dev com o repositório e o número da task', async () => {
    const impl = fakeFetch([taskPronta()])
    const pedidos: Array<{ repository: string; titulo: string; prompt: string }> = []

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async (args) => {
        pedidos.push(args)
        return { situacao: 'criada' as const, sessionName: 'sessions/xyz' }
      },
    })

    expect(r.delegated).toEqual([42])
    expect(pedidos).toHaveLength(1)
    expect(pedidos[0]!.repository).toBe('GitOrchAI/gitorch')
    expect(pedidos[0]!.prompt).toContain('#42')
    expect(r.output).toContain('sessions/xyz')
  })

  it('guarda a ligação issue → sessão assim que a sessão nasce', async () => {
    const impl = fakeFetch([taskPronta()])
    const guardadas: Array<{ issueNumber: number; sessionName: string }> = []

    await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/xyz' }),
      aoCriarSessao: async (d) => {
        guardadas.push(d)
      },
    })

    expect(guardadas).toEqual([{ issueNumber: 42, sessionName: 'sessions/xyz' }])
  })

  // INVERTIDO EM 22/08/2026, e a inversão é o conserto.
  //
  // Este teste prendia `delegated === [42]` quando a ligação não podia ser
  // guardada: a issue era marcada como delegada mesmo sem ninguém conseguir
  // acompanhar a sessão. Aquilo era tolerável enquanto ninguém varria as vagas
  // — passou a ser destrutivo no instante em que a reconciliação entrou no ar,
  // porque uma sessão viva sem linha no banco é EXATAMENTE o que ela arquiva
  // dez minutos depois. O produto marcaria a tarefa como em andamento e, em
  // seguida, mataria o trabalho que tinha acabado de encomendar.
  //
  // Agora a sessão órfã é desfeita na hora e a issue continua por fazer.
  it('falha ao guardar a ligação desfaz a sessão e NÃO conta como delegada', async () => {
    const impl = fakeFetch([taskPronta()])
    const desfeitas: string[] = []

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/xyz' }),
      aoCriarSessao: async () => {
        throw new Error('banco fora do ar')
      },
      desfazerSessao: async (nome) => {
        desfeitas.push(nome)
      },
    })

    expect(r.delegated).toEqual([])
    expect(desfeitas).toEqual(['sessions/xyz'])
    // O ciclo segue de pé: quem falha é a delegação daquela issue, não a
    // missão inteira.
    expect(r.exitCode).toBe(0)
  })

  // I4 (achado importante da revisão final): este é EXATAMENTE o caso em
  // que "o julgamento não vai encontrar este PR" — a sessão nasceu no dev
  // assíncrono mas a ligação issue↔sessão não pôde ser guardada. Sem canal
  // injetado, o aviso saía por `console.warn` cru, invisível no logger
  // estruturado (pino). Mesmo padrão já aplicado no QA (commit 5477a3e) e
  // em `github-app-token.ts`: `onWarn` opcional, default `console.warn`.
  it('o aviso sai pelo canal injetado, não pelo console — é ele que aparece no log estruturado', async () => {
    const impl = fakeFetch([taskPronta()])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // `console.warn` já é um `vi.fn()` global (mock de `src/test/setup.ts`)
    // compartilhado entre testes deste arquivo — `spyOn` nele devolve a MESMA
    // instância, sem limpar chamadas de testes anteriores (ex.: "falha ao
    // guardar a ligação..." acima, que aciona o mesmo caminho SEM `onWarn`).
    // Limpa aqui para a asserção `not.toHaveBeenCalled()` medir só ESTA
    // chamada, não o histórico acumulado do arquivo.
    warnSpy.mockClear()
    const avisos: string[] = []

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/xyz' }),
      aoCriarSessao: async () => {
        throw new Error('banco fora do ar')
      },
      onWarn: (m) => avisos.push(m),
    })

    // A issue não fica marcada como delegada (ver o teste acima), e o aviso
    // continua saindo pelo canal injetado — que é o ponto deste teste.
    expect(r.delegated).toEqual([])
    expect(avisos.join(' ')).toContain('#42')
    expect(avisos.join(' ')).toContain('banco fora do ar')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('sem sessão criada, não há ligação para guardar', async () => {
    const impl = fakeFetch([taskPronta()])
    const guardadas: Array<{ issueNumber: number; sessionName: string }> = []

    await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => ({ situacao: 'desligado' }),
      aoCriarSessao: async (d) => {
        guardadas.push(d)
      },
    })

    expect(guardadas).toEqual([])
  })

  // Renomeado em 22/08/2026: 'indisponível' juntava dois casos que agora são
  // distintos. DESLIGADO (sem chave) mantém a etiqueta como plano B, que é o
  // que este teste prende. RECUSADO tem comportamento oposto e teste próprio,
  // em delegacao-que-falha.test.ts.
  it('dev assíncrono DESLIGADO: a delegação continua valendo (label aplicado)', async () => {
    const impl = fakeFetch([taskPronta()])
    const labeled = (impl as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => ({ situacao: 'desligado' }),
    })

    expect(r.delegated).toEqual([42])
    expect(labeled.some((l) => l.labels.includes('jules'))).toBe(true)
    expect(r.output).toContain('#42')
  })
})

// Desejo do dono: a fila deixa de ser "issue sem a etiqueta" e passa a ser a
// linha viva em `dev_sessions`. Medido em produção: #46, #47 e #48 foram
// delegadas, o trabalho morreu na sessão, e como as três carregavam a
// etiqueta nunca mais voltaram para a fila — morreram em silêncio.
describe('runSmDelegation: fila sai da linha da sessão, não da etiqueta', () => {
  it('redelega issue que já tem a etiqueta mas cuja sessão morreu', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/issues?state=open')) {
        return new Response(
          JSON.stringify([
            {
              number: 46,
              title: 'morta',
              labels: [{ name: 'gitorch:task' }, { name: 'jules' }],
              body: '',
            },
          ]),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const r = await runSmDelegation({
      repository: 'acme/api',
      githubToken: 't',
      fetchImpl,
      sessoesVivas: [],
      delegadasHoje: 0,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(r.delegated).toEqual([46])
  })

  it('não delega issue que já tem sessão viva', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/issues?state=open')) {
        return new Response(
          JSON.stringify([
            { number: 46, title: 'em trabalho', labels: [{ name: 'gitorch:task' }], body: '' },
          ]),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const r = await runSmDelegation({
      repository: 'acme/api',
      githubToken: 't',
      fetchImpl,
      sessoesVivas: [
        {
          id: 'x',
          projectId: 'p',
          issueNumber: 46,
          sessionName: 's',
          state: 'IN_PROGRESS',
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
        },
      ],
      delegadasHoje: 0,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(r.delegated).toEqual([])
  })
})

describe('teto de tempo (leva D)', () => {
  it('toda chamada ao GitHub carrega um AbortSignal não abortado', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify([]), { status: 200 })
    )
    await runSmDelegation({
      repository: 'acme/api',
      githubToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})

describe('a reserva acontece ANTES de gastar cota do dev externo', () => {
  const tarefaPronta = [{ number: 153, labels: [{ name: 'gitorch:task' }], body: '' }]

  function fetchDeIssues(tarefas: unknown[]) {
    return (async () =>
      new Response(JSON.stringify(tarefas), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
  }

  // O caso medido: 39 das 100 sessoes diarias nasceram no dev externo e foram
  // desfeitas em seguida porque a issue ja tinha dono. Desfazer devolve a
  // vaga, mas NAO devolve a cota.
  it('issue que ja tem dono nao chega a acionar o dev externo', async () => {
    const criar = vi.fn()
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues(tarefaPronta),
      reservarLugarDaIssue: async () => false,
      criarSessaoDev: criar as never,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(criar).not.toHaveBeenCalled()
  })

  it('ganhando a reserva, o dev externo e acionado normalmente', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 'sessions/1' }))
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues(tarefaPronta),
      reservarLugarDaIssue: async () => true,
      aoCriarSessao: async () => undefined,
      criarSessaoDev: criar as never,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(criar).toHaveBeenCalledTimes(1)
  })

  // Sem devolver o lugar, a issue ficaria presa para sempre num dono que nao
  // existe — trocando um desperdicio por uma trava permanente.
  it('dev externo que recusa devolve o lugar reservado', async () => {
    const liberar = vi.fn(async () => undefined)
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues(tarefaPronta),
      reservarLugarDaIssue: async () => true,
      liberarLugarDaIssue: liberar,
      criarSessaoDev: (async () => ({ situacao: 'falhou', motivo: 'sem vaga' })) as never,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(liberar).toHaveBeenCalledWith(153)
  })

  // Sem a reserva ligada, o comportamento e o antigo: chamadores que ainda nao
  // passam a funcao seguem funcionando.
  it('sem reserva configurada, aciona o dev como antes', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 'sessions/1' }))
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues(tarefaPronta),
      aoCriarSessao: async () => undefined,
      criarSessaoDev: criar as never,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(criar).toHaveBeenCalledTimes(1)
  })
})

// ESTEIRA-T9: um incidente = uma issue = UM PR.
describe('runSmDelegation: incidente de infra já coberto por um PR', () => {
  const fetchDeIssues = (tarefas: unknown[]) =>
    (async () =>
      new Response(JSON.stringify(tarefas), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

  it('issue de incidente com PR aberto NÃO vira sessão nova; comenta 1x', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 's/1' }))
    const comentar = vi.fn(async () => undefined)
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues([{ number: 200, labels: [{ name: 'gitorch:task' }], body: '' }]),
      criarSessaoDev: criar as never,
      aoCriarSessao: async () => undefined,
      issuesComPrDeIncidente: new Map([[200, 314]]),
      comentarCoberturaDeIncidente: comentar,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(criar).not.toHaveBeenCalled()
    expect(r.delegated).toEqual([])
    expect(comentar).toHaveBeenCalledWith({ issueNumber: 200, prNumber: 314 })
  })

  it('issue de incidente SEM PR ainda é delegada normalmente', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 's/2' }))
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues([{ number: 201, labels: [{ name: 'gitorch:task' }], body: '' }]),
      criarSessaoDev: criar as never,
      aoCriarSessao: async () => undefined,
      issuesComPrDeIncidente: new Map([[200, 314]]),
      comentarCoberturaDeIncidente: vi.fn(async () => undefined),
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(r.delegated).toEqual([201])
  })
})

describe('runSmDelegation: D14 — "já resolvido" barra a delegação ANTES da sessão do dev', () => {
  const fetchDeIssues = (tarefas: unknown[]) =>
    (async () =>
      new Response(JSON.stringify(tarefas), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

  // CASO REAL (01/09): issue #46 de GitOrchAI/gitorch pedia registrar o
  // /wishlist, já implementado 17 dias antes no commit d175cb70 — e mesmo
  // assim foi delegada, gastando uma sessão inteira do dev para descobrir o
  // óbvio e ainda acordando o dono à toa (D14, defeito de fundo).
  it('issue marcada "ja_resolvido" pelo diagnóstico NÃO vira sessão — é sinalizada', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 's/46' }))
    const sinalizar = vi.fn(async () => undefined)
    const diagnosticar = vi.fn(
      async () =>
        new Map([
          [
            46,
            {
              issue: 46,
              categoria: 'ja_resolvido' as const,
              motivo: 'o grafo aponta commit d175cb70 alterando telegram.ts depois da issue abrir',
            },
          ],
        ])
    )

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: fetchDeIssues([
        {
          number: 46,
          title: 'Register /wishlist Telegram command',
          labels: [{ name: 'gitorch:task' }],
          body: '',
          created_at: '2026-08-07T00:00:00Z',
          updated_at: '2026-08-07T00:00:00Z',
        },
      ]),
      criarSessaoDev: criar as never,
      aoCriarSessao: async () => undefined,
      diagnosticarJaResolvido: diagnosticar,
      sinalizarPossivelmenteResolvida: sinalizar,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })

    // A PROVA central: nenhuma sessão nasceu para a #46.
    expect(criar).not.toHaveBeenCalled()
    expect(r.delegated).toEqual([])
    // E ela foi sinalizada para revisão — nunca fechada sozinha (o
    // diagnóstico sugere, tem 43% de erro medido).
    expect(sinalizar).toHaveBeenCalledWith({
      issueNumber: 46,
      achado: expect.objectContaining({ categoria: 'ja_resolvido' }),
    })
    expect(r.sinalizadasComoResolvidas).toEqual([46])
  })

  it('issue SEM achado "ja_resolvido" é delegada normalmente — o gate não é indiscriminado', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 's/47' }))
    const diagnosticar = vi.fn(async () => new Map())

    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues([
        {
          number: 47,
          title: 'Feature nova, ainda não existe',
          labels: [{ name: 'gitorch:task' }],
          body: '',
          created_at: '2026-08-30T00:00:00Z',
          updated_at: '2026-08-30T00:00:00Z',
        },
      ]),
      criarSessaoDev: criar as never,
      aoCriarSessao: async () => undefined,
      diagnosticarJaResolvido: diagnosticar,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })

    expect(criar).toHaveBeenCalledOnce()
    expect(r.delegated).toEqual([47])
    expect(r.sinalizadasComoResolvidas).toEqual([])
  })

  it('sem diagnosticarJaResolvido injetado: comportamento antigo, sem gate nenhum (compatibilidade)', async () => {
    const criar = vi.fn(async () => ({ situacao: 'criada' as const, sessionName: 's/48' }))

    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues([{ number: 48, labels: [{ name: 'gitorch:task' }], body: '' }]),
      criarSessaoDev: criar as never,
      aoCriarSessao: async () => undefined,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })

    expect(r.delegated).toEqual([48])
    expect(r.sinalizadasComoResolvidas).toEqual([])
  })

  it('diagnóstico não roda quando não sobra nenhuma candidata (economiza grafo)', async () => {
    // #50 já tem sessão viva — o filtro mais barato já resolve sozinho, e o
    // diagnóstico (caro: clona/consulta o grafo do código) nem chega a ser
    // chamado. Gastar grafo aqui seria puro desperdício.
    const diagnosticar = vi.fn(async () => new Map())
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDeIssues([{ number: 50, labels: [{ name: 'gitorch:task' }], body: '' }]),
      sessoesVivas: [
        {
          id: 'x',
          projectId: 'p',
          issueNumber: 50,
          sessionName: 's',
          state: 'IN_PROGRESS',
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
        },
      ],
      diagnosticarJaResolvido: diagnosticar,
      tetoConcorrentes: 15,
      tetoDiario: 100,
    })
    expect(diagnosticar).not.toHaveBeenCalled()
  })
})
