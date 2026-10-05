import { describe, expect, it, vi } from 'vitest'
import {
  MAX_ENTRADAS_DO_CACHE_DE_PERMISSAO,
  TTL_DA_PERMISSAO_DE_ADMIN_MS,
  criarCacheDePermissaoDeAdmin,
} from './permissao-de-admin.js'

function relogio(inicio = 1_000_000) {
  let agora = inicio
  return { agora: () => agora, avancar: (ms: number) => (agora += ms) }
}

describe('permissão de administrador do repositório', () => {
  it('só permission === "admin" vale; write, maintain, read e vazio não', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    const respostas: Array<[unknown, boolean]> = [
      [{ permission: 'admin' }, true],
      [{ permission: 'maintain' }, false],
      [{ permission: 'write' }, false],
      [{ permission: 'read' }, false],
      [{ permission: 'none' }, false],
      [{ permission: 'ADMIN' }, false],
      [{ role_name: 'admin' }, false],
      [{}, false],
      [null, false],
      ['admin', false],
    ]
    for (const [i, [resposta, esperado]] of respostas.entries()) {
      const consultar = vi.fn().mockResolvedValue(resposta)
      const r = await cache.autorTemPermissaoDeAdmin('o/r', `pessoa-${i}`, consultar)
      expect(r, JSON.stringify(resposta)).toBe(esperado)
    }
  })

  it('consulta o repositório e o login recebidos, sem inventar outro', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    const consultar = vi.fn().mockResolvedValue({ permission: 'admin' })
    await cache.autorTemPermissaoDeAdmin('org/repo', 'conta-do-dono', consultar)
    expect(consultar).toHaveBeenCalledExactlyOnceWith('org/repo', 'conta-do-dono')
  })

  it('erro na consulta (403, 404, rede) => não é admin, e o erro não vira resposta em cache', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    const consultar = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub GET failed (403)'))
      .mockResolvedValueOnce({ permission: 'admin' })
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)).toBe(false)
    expect(cache.tamanho()).toBe(0)
    // O erro foi passageiro: a próxima consulta enxerga a verdade.
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)).toBe(true)
    expect(consultar).toHaveBeenCalledTimes(2)
  })

  it('login que não é login do GitHub nunca vira consulta nem admin', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    const consultar = vi.fn().mockResolvedValue({ permission: 'admin' })
    for (const login of [
      '',
      '../../orgs/x',
      'a/b',
      'a b',
      'a?x=1',
      '-comeca-com-hifen',
      'a'.repeat(40),
      'sou-admin\n',
    ]) {
      expect(await cache.autorTemPermissaoDeAdmin('o/r', login, consultar), login).toBe(false)
    }
    expect(consultar).not.toHaveBeenCalled()
  })

  it('a segunda pergunta dentro do prazo não consulta de novo; depois do prazo consulta', async () => {
    const r = relogio()
    const cache = criarCacheDePermissaoDeAdmin({ agora: r.agora })
    const consultar = vi.fn().mockResolvedValue({ permission: 'admin' })

    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)).toBe(true)
    r.avancar(TTL_DA_PERMISSAO_DE_ADMIN_MS - 1)
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)).toBe(true)
    expect(consultar).toHaveBeenCalledTimes(1)

    r.avancar(1)
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)).toBe(true)
    expect(consultar).toHaveBeenCalledTimes(2)
  })

  it('o prazo padrão é de 10 minutos', () => {
    expect(TTL_DA_PERMISSAO_DE_ADMIN_MS).toBe(10 * 60 * 1000)
  })

  it('"não é admin" também fica em cache; e rebaixar de admin vale depois do prazo', async () => {
    const r = relogio()
    const cache = criarCacheDePermissaoDeAdmin({ agora: r.agora })
    const consultar = vi
      .fn()
      .mockResolvedValueOnce({ permission: 'write' })
      .mockResolvedValueOnce({ permission: 'admin' })
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'colega', consultar)).toBe(false)
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'colega', consultar)).toBe(false)
    expect(consultar).toHaveBeenCalledTimes(1)
    r.avancar(TTL_DA_PERMISSAO_DE_ADMIN_MS)
    expect(await cache.autorTemPermissaoDeAdmin('o/r', 'colega', consultar)).toBe(true)
  })

  it('a chave é (repositório, login): outro repositório ou outra pessoa consulta de novo; maiúscula não muda o login', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    const consultar = vi.fn().mockResolvedValue({ permission: 'admin' })
    await cache.autorTemPermissaoDeAdmin('o/r', 'Conta-Do-Dono', consultar)
    await cache.autorTemPermissaoDeAdmin('o/r', 'conta-do-dono', consultar)
    expect(consultar).toHaveBeenCalledTimes(1)
    await cache.autorTemPermissaoDeAdmin('o/outro', 'conta-do-dono', consultar)
    await cache.autorTemPermissaoDeAdmin('o/r', 'outra-pessoa', consultar)
    expect(consultar).toHaveBeenCalledTimes(3)
  })

  it('o cache tem limite de entradas: passou disso, as mais antigas saem', async () => {
    const cache = criarCacheDePermissaoDeAdmin({ maxEntradas: 3 })
    const consultar = vi.fn().mockResolvedValue({ permission: 'write' })
    for (const login of ['a1', 'a2', 'a3', 'a4']) {
      await cache.autorTemPermissaoDeAdmin('o/r', login, consultar)
    }
    expect(cache.tamanho()).toBe(3)
    expect(consultar).toHaveBeenCalledTimes(4)
    // a4, a3 e a2 continuam; a1 foi descartada e é consultada de novo.
    await cache.autorTemPermissaoDeAdmin('o/r', 'a4', consultar)
    expect(consultar).toHaveBeenCalledTimes(4)
    await cache.autorTemPermissaoDeAdmin('o/r', 'a1', consultar)
    expect(consultar).toHaveBeenCalledTimes(5)
  })

  it('o limite padrão é 200 entradas', () => {
    expect(MAX_ENTRADAS_DO_CACHE_DE_PERMISSAO).toBe(200)
  })

  it('limpar esvazia o cache', async () => {
    const cache = criarCacheDePermissaoDeAdmin()
    await cache.autorTemPermissaoDeAdmin('o/r', 'a1', vi.fn().mockResolvedValue({}))
    expect(cache.tamanho()).toBe(1)
    cache.limpar()
    expect(cache.tamanho()).toBe(0)
  })
})
