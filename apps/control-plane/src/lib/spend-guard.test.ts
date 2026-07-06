import { describe, expect, it } from 'vitest'
import {
  quotaHealth,
  shouldBlockForQuota,
  shouldAlertForQuota,
  withinTokenBudget,
  canRunMission,
} from './spend-guard.js'

describe('quotaHealth', () => {
  it('desconhecido quando não há dado', () => {
    expect(quotaHealth(null)).toBe('unknown')
    expect(quotaHealth(undefined)).toBe('unknown')
  })
  it('crítico quando zerou', () => {
    expect(quotaHealth(0)).toBe('critical')
    expect(quotaHealth(-5)).toBe('critical')
  })
  it('usa fração quando o total é conhecido', () => {
    expect(quotaHealth(4, 100)).toBe('critical') // 4% <= 5%
    expect(quotaHealth(10, 100)).toBe('low') // 10% <= 15%
    expect(quotaHealth(50, 100)).toBe('ok')
  })
  it('usa limiar absoluto sem total', () => {
    expect(quotaHealth(10_000)).toBe('low')
    expect(quotaHealth(200_000)).toBe('ok')
  })
})

describe('bloqueio e alerta', () => {
  it('só crítico bloqueia', () => {
    expect(shouldBlockForQuota('critical')).toBe(true)
    expect(shouldBlockForQuota('low')).toBe(false)
    expect(shouldBlockForQuota('unknown')).toBe(false)
    expect(shouldBlockForQuota('ok')).toBe(false)
  })
  it('baixo e crítico alertam', () => {
    expect(shouldAlertForQuota('low')).toBe(true)
    expect(shouldAlertForQuota('critical')).toBe(true)
    expect(shouldAlertForQuota('ok')).toBe(false)
  })
})

describe('withinTokenBudget', () => {
  it('sem orçamento não trava', () => {
    expect(withinTokenBudget(999999, null)).toBe(true)
    expect(withinTokenBudget(999999, 0)).toBe(true)
  })
  it('trava ao atingir o orçamento', () => {
    expect(withinTokenBudget(90, 100)).toBe(true)
    expect(withinTokenBudget(100, 100)).toBe(false)
    expect(withinTokenBudget(150, 100)).toBe(false)
  })
})

describe('canRunMission', () => {
  it('bloqueia por quota crítica do motor', () => {
    const r = canRunMission({ quotaRemaining: 0, tokensSpent: 0 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('engine-quota-critical')
  })
  it('bloqueia por orçamento de tokens estourado', () => {
    const r = canRunMission({ quotaRemaining: 1_000_000, tokensSpent: 100, tokenBudget: 100 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('token-budget')
  })
  it('libera quando quota ok e dentro do orçamento', () => {
    const r = canRunMission({ quotaRemaining: 1_000_000, tokensSpent: 10, tokenBudget: 100 })
    expect(r.ok).toBe(true)
    expect(r.health).toBe('ok')
  })
  it('quota desconhecida não bloqueia', () => {
    const r = canRunMission({ quotaRemaining: null, tokensSpent: 0 })
    expect(r.ok).toBe(true)
    expect(r.health).toBe('unknown')
  })
})
