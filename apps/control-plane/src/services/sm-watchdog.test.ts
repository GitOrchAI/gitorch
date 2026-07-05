import { describe, it, expect } from 'vitest'
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
  it('falha nova do Jules → remove e re-aplica a label + comenta a retentativa', async () => {
    const f = fakeFetch([
      {
        number: 10,
        labels: ['gitorch:task', 'jules'],
        comments: [{ body: JULES_FAIL, created_at: '2026-07-05T10:00:00Z' }],
      },
    ])
    const r = await runSmWatchdog({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    const a = actionsOf(f)
    expect(a.map((x) => x.kind)).toEqual(['unlabel', 'label', 'comment'])
    expect(a[0]!.detail).toBe('jules')
    expect(a[2]!.detail).toContain('1/3')
    expect(r.retried).toEqual([10])
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
    await notify('oi')
    expect(calls[0]).toContain('api.telegram.org/bottok/sendMessage')
  })
})
