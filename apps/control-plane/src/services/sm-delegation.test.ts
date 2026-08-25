import { describe, it, expect, vi } from 'vitest'
import { runSmDelegation, extractBlockers } from './sm-delegation.js'

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
