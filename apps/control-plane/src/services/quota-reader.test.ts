import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  parseQuotaText,
  makeAntigravityQuotaReader,
  readClaudeQuota,
  parseClaudeUsageText,
  makeClaudeQuotaReader,
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
  it('Claude lê da env (vence o runner real, nunca chega a rodar `claude`)', async () => {
    process.env['GITORCH_CLAUDE_QUOTA_REMAINING'] = '42000'
    process.env['GITORCH_CLAUDE_QUOTA_TOTAL'] = '100000'
    expect(await readClaudeQuota('/tmp')).toEqual({ remaining: 42000, total: 100000 })
  })
})

// Texto EXATO colado pelo dono, rodando `claude -p "/usage"` ao vivo nesta VM
// (~3.2s, exit 0). Só as 2 primeiras linhas (Current session / Current week)
// refletem a CONTA no servidor da Anthropic — o resto ("What's contributing")
// é histórico LOCAL desta máquina e é ignorado de propósito.
const REAL_USAGE_FIXTURE = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 100% used · resets Jul 21, 3:09am (UTC)',
  'Current week (all models): 41% used · resets Jul 26, 5:59pm (UTC)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.',
  'Behaviors are independent characteristics, not a breakdown.',
].join('\n')

describe('parseClaudeUsageText', () => {
  it('parseia as 2 linhas reais de `claude -p "/usage"` (sessão + semana)', () => {
    expect(parseClaudeUsageText(REAL_USAGE_FIXTURE)).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: 100,
      sessionResetsAt: 'Jul 21, 3:09am (UTC)',
      weekPercentUsed: 41,
      weekResetsAt: 'Jul 26, 5:59pm (UTC)',
    })
  })

  it('tolerante a variação de espaçamento/pontuação (texto humano, não JSON)', () => {
    const result = parseClaudeUsageText(
      'Current session:   57%   used  - resets Aug 1, 12:00pm (UTC)\n' +
        'Current week (all models):9% used·resets Aug 3, 1:15am (UTC)'
    )
    expect(result.sessionPercentUsed).toBe(57)
    expect(result.sessionResetsAt).toBe('Aug 1, 12:00pm (UTC)')
    expect(result.weekPercentUsed).toBe(9)
    expect(result.weekResetsAt).toBe('Aug 3, 1:15am (UTC)')
  })

  it('texto vazio ou sem as linhas esperadas -> tudo null (nunca lança)', () => {
    expect(parseClaudeUsageText('')).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
    expect(parseClaudeUsageText('saída inesperada, sem nada reconhecível')).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })
})

describe('makeClaudeQuotaReader', () => {
  it('parseia a saída real do runner (DI — nunca spawna `claude` de verdade no teste)', async () => {
    const runner = vi.fn().mockResolvedValue(REAL_USAGE_FIXTURE)
    const reader = makeClaudeQuotaReader('claude', ['-p', '/usage'], runner)
    expect(await reader('/home/x')).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: 100,
      sessionResetsAt: 'Jul 21, 3:09am (UTC)',
      weekPercentUsed: 41,
      weekResetsAt: 'Jul 26, 5:59pm (UTC)',
    })
    expect(runner).toHaveBeenCalledWith('claude', ['-p', '/usage'], '/home/x')
  })

  it('runner falhando (binário ausente/timeout) -> tudo null, nunca lança', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('claude ausente no PATH'))
    const reader = makeClaudeQuotaReader('claude', ['-p', '/usage'], runner)
    await expect(reader('/home/x')).resolves.toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })

  it('env vence o runner (override pra teste/staging, mesmo contrato do Antigravity)', async () => {
    process.env['GITORCH_CLAUDE_QUOTA_REMAINING'] = '5'
    process.env['GITORCH_CLAUDE_QUOTA_TOTAL'] = '10'
    const runner = vi.fn()
    const reader = makeClaudeQuotaReader('claude', ['-p', '/usage'], runner)
    expect(await reader('/home/x')).toEqual({ remaining: 5, total: 10 })
    expect(runner).not.toHaveBeenCalled()
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
