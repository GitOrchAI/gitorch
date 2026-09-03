import { describe, it, expect } from 'vitest'
import { dedupKeyDeDuvidaDoDev, parseDedupKeyDeDuvidaDoDev } from './dedup-key-de-duvida.js'

/**
 * A2 (fix-up L4-T3): `duvida-dev:<repo>:<issue>:<hash>` era montada em
 * `escalar-duvida-ao-dono.ts` e `reconciliar-duvidas-escaladas.ts`, e
 * parseada em `retomar-sessao-com-resposta.ts` — cada um com sua própria
 * cópia do formato. Uma fonte só: erra o formato (ex.: esquece o `issue`),
 * quem constrói e quem lê divergem sem ninguém notar até a resposta do dono
 * não achar a sessão. `repo` sempre tem `/` (dono/nome do GitHub); `hash`
 * nunca tem `:` (é o separador do próprio formato).
 */
describe('dedupKeyDeDuvidaDoDev', () => {
  it('monta duvida-dev:<repo>:<issue>:<hash>', () => {
    expect(dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 46, hash: 'hash123' })).toBe(
      'duvida-dev:acme/api:46:hash123'
    )
  })

  it('recusa repo sem "/" (não parece um repositório do GitHub)', () => {
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme', issue: 46, hash: 'h' })).toThrow()
  })

  it('recusa issue não inteira positiva', () => {
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 0, hash: 'h' })).toThrow()
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: -1, hash: 'h' })).toThrow()
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 1.5, hash: 'h' })).toThrow()
  })

  it('recusa hash vazio ou contendo ":"', () => {
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 46, hash: '' })).toThrow()
    expect(() => dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 46, hash: 'a:b' })).toThrow()
  })
})

describe('parseDedupKeyDeDuvidaDoDev', () => {
  it('lê de volta exatamente o que dedupKeyDeDuvidaDoDev monta (round-trip)', () => {
    const key = dedupKeyDeDuvidaDoDev({ repo: 'acme/api', issue: 46, hash: 'hash123' })
    expect(parseDedupKeyDeDuvidaDoDev(key)).toEqual({
      repository: 'acme/api',
      issueNumber: 46,
      hash: 'hash123',
    })
  })

  it('prefixo diferente (ex.: automacao:) devolve null — nunca lança', () => {
    expect(parseDedupKeyDeDuvidaDoDev('automacao:acme/api:workflow-x')).toBeNull()
  })

  it('formato mal formado devolve null — nunca lança', () => {
    expect(parseDedupKeyDeDuvidaDoDev('duvida-dev:acme/api:naoenumero:hash')).toBeNull()
    expect(parseDedupKeyDeDuvidaDoDev('duvida-dev:acme:46:hash')).toBeNull() // repo sem '/'
    expect(parseDedupKeyDeDuvidaDoDev('duvida-dev:acme/api:0:hash')).toBeNull() // issue <= 0
    expect(parseDedupKeyDeDuvidaDoDev('duvida-dev:acme/api:46:')).toBeNull() // hash vazio
  })
})
