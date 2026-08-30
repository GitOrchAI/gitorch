import { describe, expect, it, test, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseQuotaText,
  readClaudeQuota,
  makeClaudeQuotaReader,
  parseClaudeRateLimitHeaders,
  parseCodexRateLimitsFromJsonl,
  writeCodexQuotaFile,
  readCodexQuota,
  codexQuotaFilePath,
  rateLimitsDaRecusa,
} from './quota-reader.js'

afterEach(() => {
  delete process.env['GITORCH_CLAUDE_QUOTA_REMAINING']
  delete process.env['GITORCH_CLAUDE_QUOTA_TOTAL']
  delete process.env['GITORCH_ANTIGRAVITY_QUOTA_REMAINING']
  delete process.env['GITORCH_CODEX_QUOTA_REMAINING']
  delete process.env['GITORCH_CODEX_QUOTA_TOTAL']
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

// A quota REAL do Antigravity (via /usage no chat TUI sob PTY, com onboarding
// e pior-caso entre grupos) tem seus próprios testes em
// antigravity-quota-reader.test.ts — `makeAntigravityQuotaReader` (que rodava
// `agy usage` via execFile, sem TTY) foi REMOVIDO 21/07 por nunca ter
// funcionado (ver o comentário de remoção em quota-reader.ts e
// docs/operations/engine-collection-real-steps.md).

// Evento REAL observado ao vivo 21/07 (docs/operations/engine-collection-real-
// steps.md): plano free do dono, sem janela secundária (~5h).
const REAL_RATE_LIMITS_LINE =
  '{"allowed":true,"limit_reached":false,"primary":{"used_percent":7,"window_minutes":10080,"reset_after_seconds":482917,"reset_at":1785085248},"secondary":null}'

describe('parseCodexRateLimitsFromJsonl', () => {
  it('parseia a linha real (plano free, secondary null)', () => {
    const event = parseCodexRateLimitsFromJsonl(REAL_RATE_LIMITS_LINE)
    expect(event).toEqual({
      allowed: true,
      limit_reached: false,
      primary: {
        used_percent: 7,
        window_minutes: 10080,
        reset_after_seconds: 482917,
        reset_at: 1785085248,
      },
      secondary: null,
    })
  })

  // CASO CRÍTICO (achado ao vivo 21/07): a fonte REAL do rate_limits do Codex.
  // O evento NÃO sai no stdout do `--json` — vem no STDERR, com RUST_LOG=trace,
  // numa linha de trace do tungstenite (WebSocket) com o JSON EMBUTIDO no fim,
  // precedido de timestamp + nível + target + "Received message". O parser tem
  // que extrair o JSON a partir do 1º `{`, não só tentar a linha inteira.
  it('extrai o rate_limits da LINHA DE TRACE real (JSON embutido, prefixo de log)', () => {
    const traceLine =
      '2026-07-21T15:22:50.214727Z TRACE tungstenite::protocol: Received message ' +
      '{"type":"codex.rate_limits","plan_type":"free","rate_limits":{"allowed":true,' +
      '"limit_reached":false,"primary":{"used_percent":8,"window_minutes":10080,' +
      '"reset_after_seconds":437878,"reset_at":1785085247},"secondary":null},' +
      '"code_review_rate_limits":null}'
    const event = parseCodexRateLimitsFromJsonl(traceLine)
    expect(event?.primary?.used_percent).toBe(8)
    expect(event?.primary?.window_minutes).toBe(10080)
    expect(event?.primary?.reset_at).toBe(1785085247)
    expect(event?.secondary).toBeNull()
  })

  it('varre STDOUT+STDERR concatenados (centenas de linhas de trace) e acha a certa', () => {
    const noise = Array.from(
      { length: 200 },
      (_, i) => `2026-07-21T15:22:${i}Z TRACE opentelemetry_sdk: Metrics.InstrumentCreated ${i}`
    ).join('\n')
    const traceLine =
      '2026-07-21T15:22:50Z TRACE tungstenite::protocol: Received message ' +
      '{"type":"codex.rate_limits","rate_limits":{"allowed":true,"limit_reached":false,' +
      '"primary":{"used_percent":42,"window_minutes":10080,"reset_at":1785085247},"secondary":null}}'
    const combined = `{"type":"agent_message","message":"ok"}\n${noise}\n${traceLine}\n${noise}`
    const event = parseCodexRateLimitsFromJsonl(combined)
    expect(event?.primary?.used_percent).toBe(42)
  })

  it('parseia com secondary preenchido (plano pago hipotético)', () => {
    const line = JSON.stringify({
      allowed: true,
      limit_reached: false,
      primary: { used_percent: 12, window_minutes: 10080, reset_at: 1785085248 },
      secondary: { used_percent: 55, window_minutes: 300, reset_at: 1700000000 },
    })
    const event = parseCodexRateLimitsFromJsonl(line)
    expect(event?.primary?.used_percent).toBe(12)
    expect(event?.secondary).toEqual({
      used_percent: 55,
      window_minutes: 300,
      reset_at: 1700000000,
    })
  })

  it('acha o evento aninhado num envelope (ex.: {"msg":{"rate_limits":{...}}})', () => {
    const line = JSON.stringify({
      id: '1',
      msg: {
        type: 'token_count',
        rate_limits: {
          allowed: true,
          limit_reached: false,
          primary: { used_percent: 7, window_minutes: 10080, reset_at: 1785085248 },
          secondary: null,
        },
      },
    })
    const event = parseCodexRateLimitsFromJsonl(line)
    expect(event?.primary?.used_percent).toBe(7)
  })

  it('múltiplas linhas: acha a certa, ignora ruído e JSON inválido', () => {
    const stdout = [
      '{"type":"item.started","item":{"id":"x"}}',
      'não é json — linha de log solta',
      REAL_RATE_LIMITS_LINE,
      '{"type":"item.completed"}',
    ].join('\n')
    const event = parseCodexRateLimitsFromJsonl(stdout)
    expect(event?.primary?.used_percent).toBe(7)
  })

  it('nenhuma linha tem rate_limits -> null (nunca lança)', () => {
    const stdout = ['{"type":"item.started"}', '{"type":"item.completed"}'].join('\n')
    expect(parseCodexRateLimitsFromJsonl(stdout)).toBeNull()
  })

  it('stdout vazio -> null', () => {
    expect(parseCodexRateLimitsFromJsonl('')).toBeNull()
  })
})

describe('writeCodexQuotaFile + readCodexQuota (arquivo real em disco)', () => {
  async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-quota-'))
    try {
      await fn(home)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }

  it('grava o arquivo achatado (primary no topo, secondary null)', async () => {
    await withTempHome(async (home) => {
      const event = parseCodexRateLimitsFromJsonl(REAL_RATE_LIMITS_LINE)
      expect(event).not.toBeNull()
      await writeCodexQuotaFile(home, event!)

      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw)).toEqual({
        used_percent: 7,
        window_minutes: 10080,
        reset_at: 1785085248,
        secondary: null,
      })
    })
  })

  it('grava o arquivo com secondary aninhado quando presente', async () => {
    await withTempHome(async (home) => {
      await writeCodexQuotaFile(home, {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 12, window_minutes: 10080, reset_at: 1785085248 },
        secondary: { used_percent: 55, window_minutes: 300, reset_at: 1700000000 },
      })
      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw)).toEqual({
        used_percent: 12,
        window_minutes: 10080,
        reset_at: 1785085248,
        secondary: { used_percent: 55, window_minutes: 300, reset_at: 1700000000 },
      })
    })
  })

  it('readCodexQuota lê o arquivo e mapeia primary->week, secondary null->session null', async () => {
    await withTempHome(async (home) => {
      const event = parseCodexRateLimitsFromJsonl(REAL_RATE_LIMITS_LINE)
      await writeCodexQuotaFile(home, event!)

      const reading = await readCodexQuota(home)
      expect(reading).toEqual({
        remaining: null,
        total: null,
        weekPercentUsed: 7,
        weekResetsAt: new Date(1785085248 * 1000).toISOString(),
        sessionPercentUsed: null,
        sessionResetsAt: null,
      })
    })
  })

  it('readCodexQuota mapeia secondary->session quando presente', async () => {
    await withTempHome(async (home) => {
      await writeCodexQuotaFile(home, {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 12, window_minutes: 10080, reset_at: 1785085248 },
        secondary: { used_percent: 55, window_minutes: 300, reset_at: 1700000000 },
      })

      const reading = await readCodexQuota(home)
      expect(reading).toEqual({
        remaining: null,
        total: null,
        weekPercentUsed: 12,
        weekResetsAt: new Date(1785085248 * 1000).toISOString(),
        sessionPercentUsed: 55,
        sessionResetsAt: new Date(1700000000 * 1000).toISOString(),
      })
    })
  })

  it('sem o arquivo (warmup nunca rodou/falhou) -> tudo null, nunca lança', async () => {
    await withTempHome(async (home) => {
      const reading = await readCodexQuota(home)
      expect(reading).toEqual({
        remaining: null,
        total: null,
        sessionPercentUsed: null,
        sessionResetsAt: null,
        weekPercentUsed: null,
        weekResetsAt: null,
      })
    })
  })

  it('arquivo com JSON inválido -> tudo null, nunca lança', async () => {
    await withTempHome(async (home) => {
      await fs.mkdir(path.join(home, '.codex'), { recursive: true })
      await fs.writeFile(codexQuotaFilePath(home), '{ isso não é json válido', 'utf8')

      const reading = await readCodexQuota(home)
      expect(reading).toEqual({
        remaining: null,
        total: null,
        sessionPercentUsed: null,
        sessionResetsAt: null,
        weekPercentUsed: null,
        weekResetsAt: null,
      })
    })
  })

  it('GITORCH_CODEX_QUOTA_REMAINING/TOTAL vencem tudo — nunca lê o arquivo', async () => {
    await withTempHome(async (home) => {
      process.env['GITORCH_CODEX_QUOTA_REMAINING'] = '5'
      process.env['GITORCH_CODEX_QUOTA_TOTAL'] = '10'
      // Nem grava o arquivo — se o código tentasse ler, cairia no fallback null.
      expect(await readCodexQuota(home)).toEqual({ remaining: 5, total: 10 })
    })
  })
})

describe('a cota que vem DENTRO da recusa por teto de conta', () => {
  // MEDIDO AO VIVO em 30/08/2026: com a conta do dono em 100% usada, o servidor
  // recusa o turno com 429 ANTES de mandar o evento `rate_limits`. O leitor
  // devolvia nulo — o produto ficava cego exatamente no momento em que a cota
  // acabou, que é quando ele mais precisa enxergar. E o número da verdade
  // estava na própria recusa, sendo jogado fora.
  //
  // Esta é a mensagem REAL capturada do stderr do codex 0.142.5.
  const RECUSA_REAL = JSON.stringify({
    type: 'error',
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      plan_type: 'free',
      resets_at: 1789970409,
    },
    status_code: 429,
    headers: {
      'X-Codex-Primary-Used-Percent': '100',
      'X-Codex-Secondary-Used-Percent': '0',
      'X-Codex-Primary-Window-Minutes': '43200',
      'X-Codex-Primary-Reset-At': '1789970410',
      'X-Codex-Plan-Type': 'free',
    },
  })

  it('a recusa vira cota: 100% usado, com a janela e a virada', () => {
    const r = rateLimitsDaRecusa(JSON.parse(RECUSA_REAL))
    expect(r?.primary?.used_percent).toBe(100)
    expect(r?.primary?.window_minutes).toBe(43200)
    expect(r?.primary?.reset_at).toBe(1789970410)
  })

  it('o leitor de JSONL agora enxerga a recusa na linha de trace', () => {
    // O formato real: a linha do stderr tem texto antes do JSON.
    const linha = `2026-08-30T00:12:00Z TRACE tungstenite::protocol: Received message ${RECUSA_REAL}`
    const r = parseCodexRateLimitsFromJsonl(linha)
    expect(r?.primary?.used_percent).toBe(100)
  })

  it('resposta que NÃO é recusa por teto continua devolvendo nulo', () => {
    expect(rateLimitsDaRecusa({ status_code: 500, headers: {} })).toBeNull()
    expect(rateLimitsDaRecusa({ type: 'error' })).toBeNull()
    expect(rateLimitsDaRecusa(null)).toBeNull()
  })

  it('recusa SEM os cabeçalhos devolve nulo — nunca um zero inventado', () => {
    // Sem número, nulo honesto é melhor que um zero que parece cota cheia.
    expect(rateLimitsDaRecusa({ status_code: 429, headers: {} })).toBeNull()
  })

  it('o evento normal continua tendo prioridade sobre a recusa', () => {
    // Quando os dois aparecem, o evento é a fonte melhor.
    const normal = JSON.stringify({
      rate_limits: { primary: { used_percent: 7 }, secondary: null },
    })
    const r = parseCodexRateLimitsFromJsonl(`${normal}\n${RECUSA_REAL}`)
    expect(r?.primary?.used_percent).toBe(7)
  })
})
