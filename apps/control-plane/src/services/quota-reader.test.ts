import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseQuotaText, makeAntigravityQuotaReader, readClaudeQuota } from './quota-reader.js'

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
  it('Claude lê da env', async () => {
    process.env['GITORCH_CLAUDE_QUOTA_REMAINING'] = '42000'
    process.env['GITORCH_CLAUDE_QUOTA_TOTAL'] = '100000'
    expect(await readClaudeQuota('/tmp')).toEqual({ remaining: 42000, total: 100000 })
  })
  it('Claude sem env → unknown', async () => {
    expect(await readClaudeQuota('/tmp')).toEqual({ remaining: null, total: null })
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
