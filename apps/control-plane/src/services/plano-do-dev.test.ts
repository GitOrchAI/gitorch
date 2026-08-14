import { describe, it, expect } from 'vitest'
import { tetosDoPlanoDoDev } from './plano-do-dev.js'

describe('tetosDoPlanoDoDev', () => {
  it('free: 15 por dia, 3 ao mesmo tempo', () => {
    expect(tetosDoPlanoDoDev('free')).toEqual({ tetoConcorrentes: 3, tetoDiario: 15 })
  })
  it('pro: 100 por dia, 15 ao mesmo tempo', () => {
    expect(tetosDoPlanoDoDev('pro')).toEqual({ tetoConcorrentes: 15, tetoDiario: 100 })
  })
  it('ultra: 300 por dia, 60 ao mesmo tempo', () => {
    expect(tetosDoPlanoDoDev('ultra')).toEqual({ tetoConcorrentes: 60, tetoDiario: 300 })
  })
  it('não declarado cai no plano gratuito — o padrão seguro', () => {
    expect(tetosDoPlanoDoDev(null)).toEqual({ tetoConcorrentes: 3, tetoDiario: 15 })
    expect(tetosDoPlanoDoDev(undefined)).toEqual({ tetoConcorrentes: 3, tetoDiario: 15 })
  })
  it('valor desconhecido cai no gratuito em vez de estourar a cota alheia', () => {
    expect(tetosDoPlanoDoDev('enterprise')).toEqual({ tetoConcorrentes: 3, tetoDiario: 15 })
  })
  it('aceita maiúsculas', () => {
    expect(tetosDoPlanoDoDev('PRO')).toEqual({ tetoConcorrentes: 15, tetoDiario: 100 })
  })
})
