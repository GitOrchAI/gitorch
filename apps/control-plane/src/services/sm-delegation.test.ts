import { describe, it, expect } from 'vitest'
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
  it('delega tasks prontas: sem bloqueio, sem jules', async () => {
    const f = fakeFetch([
      { number: 10, labels: ['gitorch:task'], body: 'sem bloqueio' },
      { number: 11, labels: ['gitorch:task', 'jules'], body: 'já delegada' },
    ])
    const labeled = (f as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled
    const r = await runSmDelegation({ repository: 'o/r', githubToken: 't', fetchImpl: f })
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
        return 'sessions/xyz'
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
      criarSessaoDev: async () => 'sessions/xyz',
      aoCriarSessao: async (d) => {
        guardadas.push(d)
      },
    })

    expect(guardadas).toEqual([{ issueNumber: 42, sessionName: 'sessions/xyz' }])
  })

  it('falha ao guardar a ligação não derruba a delegação das outras tasks', async () => {
    const impl = fakeFetch([taskPronta()])

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => 'sessions/xyz',
      aoCriarSessao: async () => {
        throw new Error('banco fora do ar')
      },
    })

    expect(r.delegated).toEqual([42])
  })

  it('sem sessão criada, não há ligação para guardar', async () => {
    const impl = fakeFetch([taskPronta()])
    const guardadas: Array<{ issueNumber: number; sessionName: string }> = []

    await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => null,
      aoCriarSessao: async (d) => {
        guardadas.push(d)
      },
    })

    expect(guardadas).toEqual([])
  })

  it('dev assíncrono indisponível: a delegação continua valendo (label aplicado)', async () => {
    const impl = fakeFetch([taskPronta()])
    const labeled = (impl as unknown as { labeled: Array<{ number: number; labels: string[] }> })
      .labeled

    const r = await runSmDelegation({
      repository: 'GitOrchAI/gitorch',
      githubToken: 't',
      fetchImpl: impl,
      criarSessaoDev: async () => null,
    })

    expect(r.delegated).toEqual([42])
    expect(labeled.some((l) => l.labels.includes('jules'))).toBe(true)
    expect(r.output).toContain('#42')
  })
})
