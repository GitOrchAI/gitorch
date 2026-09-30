import { describe, it, expect } from 'vitest'
import {
  chaveDaVerificacao,
  criarCacheDeVerificacaoPendente,
  TTL_DA_VERIFICACAO_PENDENTE_MS,
  MAX_ENTRADAS_DO_CACHE_DE_PENDENTES,
} from './cache-de-verificacao-pendente.js'

describe('cache-de-verificacao-pendente', () => {
  it('guarda pendente e devolve dentro do TTL', () => {
    let agora = 1_000
    const cache = criarCacheDeVerificacaoPendente({ agora: () => agora })
    const chave = chaveDaVerificacao('o/r', 10, 'sha-a')
    expect(cache.ler(chave)).toBeUndefined()
    cache.gravar(chave, 'pending')
    agora += TTL_DA_VERIFICACAO_PENDENTE_MS - 1
    expect(cache.ler(chave)).toBe('pending')
  })

  it('guarda desconhecido também', () => {
    const cache = criarCacheDeVerificacaoPendente({ agora: () => 0 })
    const chave = chaveDaVerificacao('o/r', 10, 'sha-a')
    cache.gravar(chave, 'unknown')
    expect(cache.ler(chave)).toBe('unknown')
  })

  it('expira sozinho ao chegar no TTL e sai da memória', () => {
    let agora = 0
    const cache = criarCacheDeVerificacaoPendente({ agora: () => agora })
    const chave = chaveDaVerificacao('o/r', 10, 'sha-a')
    cache.gravar(chave, 'pending')
    agora = TTL_DA_VERIFICACAO_PENDENTE_MS
    expect(cache.ler(chave)).toBeUndefined()
    expect(cache.tamanho()).toBe(0)
  })

  it('o TTL padrão é de 3 minutos', () => {
    expect(TTL_DA_VERIFICACAO_PENDENTE_MS).toBe(3 * 60 * 1000)
  })

  it('head novo, PR diferente ou repositório diferente são chaves diferentes', () => {
    const cache = criarCacheDeVerificacaoPendente({ agora: () => 0 })
    cache.gravar(chaveDaVerificacao('o/r', 10, 'sha-a'), 'pending')
    expect(cache.ler(chaveDaVerificacao('o/r', 10, 'sha-b'))).toBeUndefined()
    expect(cache.ler(chaveDaVerificacao('o/r', 11, 'sha-a'))).toBeUndefined()
    expect(cache.ler(chaveDaVerificacao('o/x', 10, 'sha-a'))).toBeUndefined()
  })

  it('esquecer apaga a entrada', () => {
    const cache = criarCacheDeVerificacaoPendente({ agora: () => 0 })
    const chave = chaveDaVerificacao('o/r', 10, 'sha-a')
    cache.gravar(chave, 'pending')
    cache.esquecer(chave)
    expect(cache.ler(chave)).toBeUndefined()
  })

  it('não cresce além do limite: descarta as mais antigas', () => {
    const cache = criarCacheDeVerificacaoPendente({ agora: () => 0, maxEntradas: 3 })
    for (let n = 1; n <= 10; n++) cache.gravar(chaveDaVerificacao('o/r', n, `sha-${n}`), 'pending')
    expect(cache.tamanho()).toBe(3)
    expect(cache.ler(chaveDaVerificacao('o/r', 1, 'sha-1'))).toBeUndefined()
    expect(cache.ler(chaveDaVerificacao('o/r', 7, 'sha-7'))).toBeUndefined()
    expect(cache.ler(chaveDaVerificacao('o/r', 8, 'sha-8'))).toBe('pending')
    expect(cache.ler(chaveDaVerificacao('o/r', 10, 'sha-10'))).toBe('pending')
  })

  it('regravar a mesma chave a torna a mais nova (não a mais antiga a sair)', () => {
    const cache = criarCacheDeVerificacaoPendente({ agora: () => 0, maxEntradas: 2 })
    const a = chaveDaVerificacao('o/r', 1, 'a')
    const b = chaveDaVerificacao('o/r', 2, 'b')
    const c = chaveDaVerificacao('o/r', 3, 'c')
    cache.gravar(a, 'pending')
    cache.gravar(b, 'pending')
    cache.gravar(a, 'pending')
    cache.gravar(c, 'pending')
    expect(cache.ler(b)).toBeUndefined()
    expect(cache.ler(a)).toBe('pending')
    expect(cache.ler(c)).toBe('pending')
  })

  it('gravar varre as entradas já vencidas antes de contar o limite', () => {
    let agora = 0
    const cache = criarCacheDeVerificacaoPendente({ agora: () => agora, maxEntradas: 50 })
    for (let n = 1; n <= 5; n++) cache.gravar(chaveDaVerificacao('o/r', n, `s${n}`), 'pending')
    agora = TTL_DA_VERIFICACAO_PENDENTE_MS + 1
    cache.gravar(chaveDaVerificacao('o/r', 99, 's99'), 'pending')
    expect(cache.tamanho()).toBe(1)
  })

  it('o limite padrão é finito e positivo', () => {
    expect(MAX_ENTRADAS_DO_CACHE_DE_PENDENTES).toBeGreaterThan(0)
    expect(MAX_ENTRADAS_DO_CACHE_DE_PENDENTES).toBeLessThanOrEqual(1000)
  })
})
