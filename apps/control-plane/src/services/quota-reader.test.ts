import { describe, expect, it, test, vi, afterEach } from 'vitest'
import {
  parseQuotaText,
  makeAntigravityQuotaReader,
  readClaudeQuota,
  makeClaudeQuotaReader,
  parseClaudeRateLimitHeaders,
} from './quota-reader.js'

afterEach(() => {
  delete process.env['GITORCH_CLAUDE_QUOTA_REMAINING']
  delete process.env['GITORCH_CLAUDE_QUOTA_TOTAL']
  delete process.env['GITORCH_ANTIGRAVITY_QUOTA_REMAINING']
})

describe('parseQuotaText', () => {
  it('lê JSON com remaining/total', () => {
    expect(parseQuotaText('{"remaining": 1200, "total": 5000}')).toEqual({
      remaining: 1200,
      total: 5000,
    })
  })
  it('lê chaves alternativas (remaining_tokens/limit)', () => {
    expect(parseQuotaText('{"remaining_tokens": "12,000", "limit": "100000"}')).toEqual({
      remaining: 12000,
      total: 100000,
    })
  })
  it('lê texto solto com regex', () => {
    expect(parseQuotaText('Remaining: 8,500 of total 10000')).toEqual({
      remaining: 8500,
      total: 10000,
    })
  })
  it('vazio/sem número → unknown', () => {
    expect(parseQuotaText('')).toEqual({ remaining: null, total: null })
    expect(parseQuotaText('sem dados aqui')).toEqual({ remaining: null, total: null })
  })
})

describe('override por ambiente', () => {
  it('Claude lê da env (vence o token/fetch reais, nunca chama a API)', async () => {
    process.env['GITORCH_CLAUDE_QUOTA_REMAINING'] = '42000'
    process.env['GITORCH_CLAUDE_QUOTA_TOTAL'] = '100000'
    expect(await readClaudeQuota('/tmp')).toEqual({ remaining: 42000, total: 100000 })
  })
})

/** Fake mínimo de `Headers` — só o `.get()` que o parser usa. */
function fakeHeaders(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => map[name] ?? null }
}

// Valores REAIS observados ao vivo (docs/operations/engine-collection-real-
// steps.md, 21/07): 5h ≈ 99% usado, semana ≈ 40% usado.
describe('parseClaudeRateLimitHeaders', () => {
  it('converte utilization (fração 0..1) em percent (0..100) arredondado', () => {
    const headers = fakeHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
    })
    const result = parseClaudeRateLimitHeaders(headers)
    expect(result.sessionPercentUsed).toBe(99)
    expect(result.weekPercentUsed).toBe(40)
    expect(result.remaining).toBeNull()
    expect(result.total).toBeNull()
  })

  it('arredonda frações não-exatas (0.994 -> 99, 0.401 -> 40)', () => {
    const headers = fakeHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.994',
      'anthropic-ratelimit-unified-7d-utilization': '0.401',
    })
    const result = parseClaudeRateLimitHeaders(headers)
    expect(result.sessionPercentUsed).toBe(99)
    expect(result.weekPercentUsed).toBe(40)
  })

  it('converte o reset unix (segundos) em ISO string', () => {
    const headers = fakeHeaders({
      'anthropic-ratelimit-unified-5h-reset': '1700000000',
      'anthropic-ratelimit-unified-7d-reset': '1700500000',
    })
    const result = parseClaudeRateLimitHeaders(headers)
    expect(result.sessionResetsAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(result.weekResetsAt).toBe(new Date(1700500000 * 1000).toISOString())
  })

  it('headers ausentes -> tudo null (nunca lança)', () => {
    expect(parseClaudeRateLimitHeaders(fakeHeaders({}))).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })

  it('valor não-numérico no header -> null pro campo (nunca NaN, nunca lança)', () => {
    const headers = fakeHeaders({
      'anthropic-ratelimit-unified-5h-utilization': 'não-é-número',
      'anthropic-ratelimit-unified-5h-reset': 'também-não',
    })
    const result = parseClaudeRateLimitHeaders(headers)
    expect(result.sessionPercentUsed).toBeNull()
    expect(result.sessionResetsAt).toBeNull()
  })
})

describe('makeClaudeQuotaReader (API real, fetch/token fake)', () => {
  test('sem token no homeDir -> tudo null, nunca chama fetch', async () => {
    const fetchSpy = vi.fn()
    const reader = makeClaudeQuotaReader(fetchSpy, async () => null)
    await expect(reader('/tmp/gitorch-sem-token-xyz')).resolves.toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('com token -> POST /v1/messages com os headers de auth certos e parseia os headers de rate limit', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: fakeHeaders({
        'anthropic-ratelimit-unified-5h-utilization': '0.99',
        'anthropic-ratelimit-unified-5h-reset': '1700000000',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': '1700500000',
      }),
    })
    const reader = makeClaudeQuotaReader(fetchSpy, async () => 'sk-ant-oat01-fake')
    const result = await reader('/home/x')

    expect(result).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: 99,
      sessionResetsAt: new Date(1700000000 * 1000).toISOString(),
      weekPercentUsed: 40,
      weekResetsAt: new Date(1700500000 * 1000).toISOString(),
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      authorization: 'Bearer sk-ant-oat01-fake',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(init.body as string) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(typeof body.model).toBe('string')
    expect(body.model.length).toBeGreaterThan(0)
  })

  test('resposta sem os headers de rate limit -> tudo null pras janelas, nunca lança', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: fakeHeaders({}) })
    const reader = makeClaudeQuotaReader(fetchSpy, async () => 'sk-ant-oat01-fake')
    await expect(reader('/home/x')).resolves.toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })

  test('resposta não-ok (401/429) ainda lê os headers de rate limit quando presentes', async () => {
    // A Anthropic manda os headers de rate limit mesmo em respostas de erro
    // (ex.: 429 por estourar quota) — não descartamos o dado só por status.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: fakeHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '1' }),
    })
    const reader = makeClaudeQuotaReader(fetchSpy, async () => 'sk-ant-oat01-fake')
    const result = await reader('/home/x')
    expect(result.sessionPercentUsed).toBe(100)
  })

  test('fetch rejeita (rede fora/timeout) -> tudo null, nunca lança', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
    const reader = makeClaudeQuotaReader(fetchSpy, async () => 'sk-ant-oat01-fake')
    await expect(reader('/home/x')).resolves.toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })

  test('GITORCH_CLAUDE_QUOTA_REMAINING/TOTAL vencem tudo — nunca lê token nem chama fetch', async () => {
    process.env['GITORCH_CLAUDE_QUOTA_REMAINING'] = '5'
    process.env['GITORCH_CLAUDE_QUOTA_TOTAL'] = '10'
    const fetchSpy = vi.fn()
    const readToken = vi.fn()
    const reader = makeClaudeQuotaReader(fetchSpy, readToken)
    expect(await reader('/home/x')).toEqual({ remaining: 5, total: 10 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readToken).not.toHaveBeenCalled()
  })
})

describe('Antigravity reader', () => {
  it('parseia a saída do runner', async () => {
    const runner = vi.fn().mockResolvedValue('{"remaining": 900, "total": 1000}')
    const reader = makeAntigravityQuotaReader('agy', ['usage'], runner)
    expect(await reader('/home/x')).toEqual({ remaining: 900, total: 1000 })
    expect(runner).toHaveBeenCalledWith('agy', ['usage'], '/home/x')
  })
  it('runner falhando → unknown (não quebra)', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('agy ausente'))
    const reader = makeAntigravityQuotaReader('agy', ['usage'], runner)
    expect(await reader('/home/x')).toEqual({ remaining: null, total: null })
  })
  it('env vence o runner', async () => {
    process.env['GITORCH_ANTIGRAVITY_QUOTA_REMAINING'] = '77'
    const runner = vi.fn().mockResolvedValue('{"remaining": 1}')
    const reader = makeAntigravityQuotaReader('agy', ['usage'], runner)
    expect((await reader('/home/x')).remaining).toBe(77)
    expect(runner).not.toHaveBeenCalled()
  })
})
