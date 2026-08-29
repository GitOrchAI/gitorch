import { describe, it, expect, vi } from 'vitest'
import { runSmWatchdog, buildTelegramNotifier } from './sm-watchdog.js'

const JULES_FAIL =
  "Jules has failed to create a task. You can try again later by removing and re-adding the 'jules' label."
const JULES_APOLOGY =
  "I apologize, but I encountered an unexpected error and wasn't able to complete the task."
const RETRY_MARKER = '<!-- gitorch:sm-retry -->'

interface FakeIssue {
  number: number
  labels: string[]
  comments: Array<{ body: string; created_at: string }>
  openPr?: boolean
}

function fakeFetch(issues: FakeIssue[]) {
  const actions: Array<{ kind: string; number: number; detail?: string }> = []
  const byNumber = new Map(issues.map((i) => [i.number, i]))
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

    if (u.includes('/issues?') && u.includes('gitorch%3Atask%2Cjules')) {
      return json(
        issues.map((i) => ({ number: i.number, labels: i.labels.map((n) => ({ name: n })) }))
      )
    }
    const cm = u.match(/\/issues\/(\d+)\/comments/)
    if (cm && method === 'GET') return json(byNumber.get(Number(cm[1]))?.comments ?? [])
    if (cm && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      actions.push({ kind: 'comment', number: Number(cm[1]), detail: body.body })
      return json({ id: 1 })
    }
    const tl = u.match(/\/issues\/(\d+)\/timeline/)
    if (tl) {
      const issue = byNumber.get(Number(tl[1]))
      return json(
        issue?.openPr
          ? [{ event: 'cross-referenced', source: { issue: { state: 'open', pull_request: {} } } }]
          : []
      )
    }
    const dl = u.match(/\/issues\/(\d+)\/labels\/(.+)$/)
    if (dl && method === 'DELETE') {
      actions.push({ kind: 'unlabel', number: Number(dl[1]), detail: decodeURIComponent(dl[2]!) })
      return json([])
    }
    const lm = u.match(/\/issues\/(\d+)\/labels$/)
    if (lm && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      actions.push({ kind: 'label', number: Number(lm[1]), detail: body.labels.join(',') })
      return json([])
    }
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { actions: typeof actions }).actions = actions
  return impl
}

function actionsOf(f: typeof fetch) {
  return (f as unknown as { actions: Array<{ kind: string; number: number; detail?: string }> })
    .actions
}

describe('runSmWatchdog', () => {
  it('falha nova do Jules NÃO reaplica a label — a cobrança mora na linha da sessão', async () => {
    // Comportamento antigo (removido): esta mesma falha disparava
    // unlabel+label+comment de retentativa. Provado inerte — a fila de
    // delegação escolhia justamente as issues SEM a label ('jules'), então
    // reaplicá-la numa issue que já a tem nunca a devolvia à fila. Quem
    // cobra agora é a linha da sessão em dev_sessions (fila-de-delegacao.ts):
    // sessão fechada sem merge devolve a issue sozinha, sem tocar em labels.
    const f = fakeFetch([
      {
        number: 10,
        labels: ['gitorch:task', 'jules'],
        comments: [{ body: JULES_FAIL, created_at: '2026-07-05T10:00:00Z' }],
      },
    ])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(actionsOf(f)).toEqual([])
    expect(r.noOp).toBe(true)
  })

  it('falha ANTERIOR à última retentativa não dispara de novo (no-op)', async () => {
    const f = fakeFetch([
      {
        number: 11,
        labels: ['gitorch:task', 'jules'],
        comments: [
          { body: JULES_APOLOGY, created_at: '2026-07-05T09:00:00Z' },
          { body: `${RETRY_MARKER}\nretry 1/3`, created_at: '2026-07-05T10:00:00Z' },
        ],
      },
    ])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(actionsOf(f)).toEqual([])
    expect(r.noOp).toBe(true)
  })

  it('PR aberto referenciando a issue → não interfere', async () => {
    const f = fakeFetch([
      {
        number: 12,
        labels: ['gitorch:task', 'jules'],
        comments: [{ body: JULES_FAIL, created_at: '2026-07-05T10:00:00Z' }],
        openPr: true,
      },
    ])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(actionsOf(f)).toEqual([])
    expect(r.noOp).toBe(true)
  })

  it('limite de retentativas estourado → gitorch:stuck + escalação + notify', async () => {
    const mk = (t: string, body: string) => ({ body, created_at: t })
    const notified: string[] = []
    const f = fakeFetch([
      {
        number: 13,
        labels: ['gitorch:task', 'jules'],
        comments: [
          mk('2026-07-05T08:00:00Z', JULES_FAIL),
          mk('2026-07-05T08:10:00Z', `${RETRY_MARKER}\n1/3`),
          mk('2026-07-05T09:00:00Z', JULES_FAIL),
          mk('2026-07-05T09:10:00Z', `${RETRY_MARKER}\n2/3`),
          mk('2026-07-05T10:00:00Z', JULES_APOLOGY),
          mk('2026-07-05T10:10:00Z', `${RETRY_MARKER}\n3/3`),
          mk('2026-07-05T11:00:00Z', JULES_FAIL),
        ],
      },
    ])
    const r = await runSmWatchdog({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      notify: async (m) => {
        notified.push(m)
        return true
      },
    })
    const a = actionsOf(f)
    expect(a.find((x) => x.kind === 'label')!.detail).toBe('gitorch:stuck')
    expect(a.some((x) => x.kind === 'unlabel')).toBe(false)
    expect(r.stuck).toEqual([13])
    expect(notified).toHaveLength(1)
  })

  it('já marcada gitorch:stuck → não escala duas vezes', async () => {
    const f = fakeFetch([
      {
        number: 14,
        labels: ['gitorch:task', 'jules', 'gitorch:stuck'],
        comments: [
          { body: `${RETRY_MARKER}\n1/3`, created_at: '2026-07-05T08:00:00Z' },
          { body: `${RETRY_MARKER}\n2/3`, created_at: '2026-07-05T08:30:00Z' },
          { body: `${RETRY_MARKER}\n3/3`, created_at: '2026-07-05T09:00:00Z' },
          { body: JULES_FAIL, created_at: '2026-07-05T10:00:00Z' },
        ],
      },
    ])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(actionsOf(f)).toEqual([])
    expect(r.noOp).toBe(true)
  })

  it('sem comentário de falha → tudo quieto', async () => {
    const f = fakeFetch([{ number: 15, labels: ['gitorch:task', 'jules'], comments: [] }])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(r.noOp).toBe(true)
    expect(r.output).toContain('all quiet')
  })
})

describe('buildTelegramNotifier', () => {
  it('sem config → undefined; com config → envia sendMessage', async () => {
    expect(buildTelegramNotifier({})).toBeUndefined()
    const calls: string[] = []
    const f = (async (url: Parameters<typeof fetch>[0]) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const notify = buildTelegramNotifier({ botToken: 'tok', chatId: '42', fetchImpl: f })!
    expect(await notify('oi')).toBe(true)
    expect(calls[0]).toContain('api.telegram.org/bottok/sendMessage')
  })

  it('a chamada carrega um AbortSignal não abortado', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const notify = buildTelegramNotifier({ botToken: 'tok', chatId: '42', fetchImpl: f })!
    await notify('oi')
    const init = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as
      RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
  })

  it('CRÍTICO (leva D): um socket do Telegram que nunca resolve nem rejeita não fica pendurado para sempre', async () => {
    // Prova real do defeito do despacho: um fetch cujo socket travou (nem
    // sucesso nem erro) — sem teto, `notify()` nunca se resolveria e
    // prenderia `tickEmAndamento` (scheduler.ts) para sempre, junto com
    // TODA varredura futura de TODO projeto. `.catch(() => false)` dentro de
    // `notify` não é proteção nenhuma contra isso: um socket travado nunca
    // REJEITA sozinho, só um `AbortSignal` o força a rejeitar.
    const fetchQueNuncaResolve = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
    ) as unknown as typeof fetch
    // Teto curto só para o teste não esperar os 10s reais de produção — o
    // mecanismo (`fetchComTeto`) é o mesmo.
    const notify = buildTelegramNotifier({
      botToken: 'tok',
      chatId: '42',
      fetchImpl: fetchQueNuncaResolve,
      timeoutMs: 20,
    })!
    // `notify` engole o abort — o que importa aqui é que a promise SE
    // RESOLVE (não fica pendurada); o valor `false` diz que a entrega falhou.
    await expect(notify('publicação confirmada')).resolves.toBe(false)
  })

  // Achado Baixo 6 (Task 5/F8) + correção (fix/telegram-notifier-propaga-falha):
  // a função devolvida NUNCA rejeita — um `.catch(...)` em volta de
  // `notify(...)`, em QUALQUER chamador, continua nunca disparando. O que
  // MUDOU: o VALOR resolvido agora carrega o resultado real (`false` na
  // falha, `true` no sucesso), então um chamador que precisa saber se a
  // entrega chegou lê o retorno em vez de depender de `.then/.catch` (que
  // nunca detectava nada — era o bug real: o `avisado` do QA sempre `true`).
  // `onDeliveryFailure` continua existindo, à parte, só para quem quer LOGAR
  // sem mudar o fluxo.
  it('achado Baixo 6: falha de entrega chama onDeliveryFailure, resolve false, e notify() continua nunca rejeitando', async () => {
    const erroDeEntrega = new Error('Telegram: bot inválido ou destino apagado')
    const f = vi.fn(async () => {
      throw erroDeEntrega
    }) as unknown as typeof fetch
    const onDeliveryFailure = vi.fn()

    const notify = buildTelegramNotifier({
      botToken: 'tok',
      chatId: '42',
      fetchImpl: f,
      onDeliveryFailure,
    })!

    await expect(notify('aviso que não vai chegar')).resolves.toBe(false)
    expect(onDeliveryFailure).toHaveBeenCalledWith(erroDeEntrega)
  })

  it('sem onDeliveryFailure: falha de entrega segue sem lançar, mas resolve false (não mais undefined)', async () => {
    const f = vi.fn(async () => {
      throw new Error('Telegram: bot inválido')
    }) as unknown as typeof fetch

    const notify = buildTelegramNotifier({ botToken: 'tok', chatId: '42', fetchImpl: f })!

    await expect(notify('aviso')).resolves.toBe(false)
  })

  // `fetch` só rejeita em falha de REDE — bot token revogado, bot bloqueado
  // pelo destino ou chat apagado são o cenário mais comum na vida real
  // ("bot inválido, destino apagado" do comentário acima) e o Telegram
  // responde com um HTTP de erro (401/403/400), NÃO com uma rejeição.
  it('Telegram responde HTTP de erro (bot inválido/destino apagado): resolve false, chama onDeliveryFailure, nunca rejeita', async () => {
    const f = vi.fn(
      async () => new Response('{"ok":false}', { status: 401 })
    ) as unknown as typeof fetch
    const onDeliveryFailure = vi.fn()

    const notify = buildTelegramNotifier({
      botToken: 'tok-revogado',
      chatId: '42',
      fetchImpl: f,
      onDeliveryFailure,
    })!

    await expect(notify('aviso que a API rejeitou')).resolves.toBe(false)
    expect(onDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('401') })
    )
  })

  it('entrega com sucesso: resolve true, onDeliveryFailure NUNCA é chamado', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const onDeliveryFailure = vi.fn()

    const notify = buildTelegramNotifier({
      botToken: 'tok',
      chatId: '42',
      fetchImpl: f,
      onDeliveryFailure,
    })!

    await expect(notify('aviso que chega')).resolves.toBe(true)
    expect(onDeliveryFailure).not.toHaveBeenCalled()
  })
})
