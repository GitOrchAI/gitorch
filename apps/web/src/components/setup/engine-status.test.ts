import { describe, it, expect } from 'vitest'
import { modelCount, parseTokenResponse } from './engine-status'

describe('modelCount', () => {
  it('conta o tamanho de uma lista de modelos (o que a liveness/SSE entrega)', () => {
    expect(modelCount(['gpt-5', 'gpt-5-mini', 'o4'])).toBe(3)
  })

  it('lista vazia é 0 (motor conectou mas não expôs catálogo ainda)', () => {
    expect(modelCount([])).toBe(0)
  })

  it('passa um número adiante (já normalizado pelo refetch)', () => {
    expect(modelCount(7)).toBe(7)
  })

  it('undefined/null/string/NaN -> undefined (não renderiza a linha)', () => {
    expect(modelCount(undefined)).toBeUndefined()
    expect(modelCount(null)).toBeUndefined()
    expect(modelCount('gpt-5')).toBeUndefined()
    expect(modelCount(Number.NaN)).toBeUndefined()
  })
})

describe('parseTokenResponse', () => {
  const fallback = 'Não deu para conectar.'

  it('connected:true + status connected -> connected com contagem de modelos e quota', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: ['a', 'b'], quotaRemaining: 42 } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: 2, quota: 42 })
  })

  it('quota ausente vira null (provider sem quota) sem quebrar', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: [] } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: 0, quota: null })
  })

  it('anti-fachada: liveness reprovou (status error) -> error com a causa real, nunca connected', () => {
    const state = parseTokenResponse(
      {
        connected: false,
        status: { status: 'error', lastError: 'motor não respondeu à validação' },
      },
      fallback
    )
    expect(state).toEqual({ phase: 'error', message: 'motor não respondeu à validação' })
  })

  it('erro 400 da rota (error de topo) -> error com essa mensagem', () => {
    const state = parseTokenResponse({ error: 'token de claude inválido: vazio' }, fallback)
    expect(state).toEqual({ phase: 'error', message: 'token de claude inválido: vazio' })
  })

  it('sem causa nenhuma -> cai no fallback localizado', () => {
    expect(parseTokenResponse(null, fallback)).toEqual({ phase: 'error', message: fallback })
    expect(parseTokenResponse({ connected: false, status: { status: 'error' } }, fallback)).toEqual(
      {
        phase: 'error',
        message: fallback,
      }
    )
  })
})
