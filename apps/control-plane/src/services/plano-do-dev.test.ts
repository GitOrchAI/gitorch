import { describe, it, expect } from 'vitest'
import { tetosDoPlanoDoDev, planoEfetivoDaConta } from './plano-do-dev.js'

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

// DJ-T5b — dados reais: gitorch='pro', patinhas-3d-crafts='pro',
// padrao-executores=NULL, mesma conta (devAccountId nulo). NULO é IGNORADO,
// não vira 'free' — só entre os DECLARADOS vale o mais restritivo.
describe('planoEfetivoDaConta', () => {
  it('nulo ignorado: dois pro e um projeto sem plano ainda é pro', () => {
    expect(planoEfetivoDaConta(['pro', 'pro', null])).toBe('pro')
  })

  it('só nulo, nenhum plano declarado, cai no free', () => {
    expect(planoEfetivoDaConta([null])).toBe('free')
  })

  it('entre declarados, o mais restritivo vence — pro e free vira free', () => {
    expect(planoEfetivoDaConta(['pro', 'free'])).toBe('free')
  })

  it('lista vazia cai no free', () => {
    expect(planoEfetivoDaConta([])).toBe('free')
  })

  it('undefined e string vazia também são ignorados como o nulo', () => {
    expect(planoEfetivoDaConta(['pro', undefined, ''])).toBe('pro')
  })
})
