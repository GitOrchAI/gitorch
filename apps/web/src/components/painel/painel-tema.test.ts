import { describe, it, expect } from 'vitest'
import { lerTema, salvarTema, proximoTema, CHAVE_TEMA } from './painel-tema'

const fakeStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    _m: m,
  }
}

describe('painel-tema', () => {
  it('default é light quando não há nada salvo', () => {
    expect(lerTema(fakeStore())).toBe('light')
  })
  it('lê o valor salvo quando válido', () => {
    expect(lerTema(fakeStore({ [CHAVE_TEMA]: 'dark' }))).toBe('dark')
  })
  it('valor inválido cai no default light (nunca lança)', () => {
    expect(lerTema(fakeStore({ [CHAVE_TEMA]: 'roxo' }))).toBe('light')
  })
  it('store nulo (SSR) devolve light', () => {
    expect(lerTema(null)).toBe('light')
  })
  it('proximoTema alterna', () => {
    expect(proximoTema('light')).toBe('dark')
    expect(proximoTema('dark')).toBe('light')
  })
  it('salvarTema grava a chave certa', () => {
    const s = fakeStore()
    salvarTema(s, 'dark')
    expect(s._m.get(CHAVE_TEMA)).toBe('dark')
  })
  it('salvarTema com store nulo não lança', () => {
    expect(() => salvarTema(null, 'dark')).not.toThrow()
  })
})
