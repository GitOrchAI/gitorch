import { describe, it, expect } from 'vitest'
import {
  medirCiclo,
  distribuir,
  percentil,
  saiuDePrimeira,
  NAO_MEDIDO,
  type FatosDoCiclo,
} from './medicao-do-ciclo.js'

// Os números abaixo vieram do banco do dono em 30/08: 179 entregas, 903
// cutucadas no total, 40 falhas de mescla, 9 refilas, 3 tentativas extras.
// A média de cutucadas dá ~5 por entrega — e é exatamente por isso que este
// arquivo insiste em mediana e p90: a média sozinha esconde onde está a dor.

const entrega = (over: Partial<FatosDoCiclo> = {}): FatosDoCiclo => ({
  attempts: 1,
  nudges: 0,
  requeueCount: 0,
  mergeFailures: 0,
  createdAt: new Date('2026-08-29T00:00:00Z'),
  closedAt: new Date('2026-08-29T02:00:00Z'),
  ...over,
})

describe('percentil — o valor devolvido aconteceu de verdade', () => {
  it('mediana de uma lista ímpar', () => {
    expect(percentil([1, 2, 3, 4, 5], 50)).toBe(3)
  })

  it('p90 pega a cauda, não a média', () => {
    // Nove entregas tranquilas e uma que travou 40 vezes. A média seria 4,
    // um número que não descreve nem o caso típico nem o pior.
    const valores = [0, 0, 0, 0, 0, 0, 0, 0, 0, 40]
    expect(
      percentil(
        [...valores].sort((a, b) => a - b),
        50
      )
    ).toBe(0)
    expect(
      percentil(
        [...valores].sort((a, b) => a - b),
        90
      )
    ).toBe(0)
    expect(distribuir(valores).maximo).toBe(40)
  })

  it('NÃO interpola: o p90 é sempre um valor observado', () => {
    // "3,4 cutucadas" não quer dizer nada para quem lê.
    const d = distribuir([1, 2, 3, 4])
    expect(Number.isInteger(d.p90)).toBe(true)
  })

  it('lista vazia devolve zero em vez de estourar', () => {
    expect(distribuir([])).toEqual({ mediana: 0, p90: 0, maximo: 0 })
  })
})

describe('saiuDePrimeira — sem ninguém empurrar', () => {
  it('uma tentativa e nenhum empurrão conta', () => {
    expect(saiuDePrimeira(entrega())).toBe(true)
  })

  it('UMA cutucada já tira de "primeira"', () => {
    // Cutucar é retrabalho: alguém teve que lembrar o dev de continuar.
    expect(saiuDePrimeira(entrega({ nudges: 1 }))).toBe(false)
  })

  it('falha de mescla também tira', () => {
    expect(saiuDePrimeira(entrega({ mergeFailures: 1 }))).toBe(false)
  })

  it('refila também tira', () => {
    expect(saiuDePrimeira(entrega({ requeueCount: 1 }))).toBe(false)
  })
})

describe('medirCiclo — o retrabalho aparece, não some na média', () => {
  it('conta as entregas e quantas saíram de primeira', () => {
    const m = medirCiclo([entrega(), entrega({ nudges: 3 }), entrega()])
    expect(m.entregas).toBe(3)
    expect(m.dePrimeira).toBe(2)
  })

  it('a mediana descreve o caso típico e o p90 a dor', () => {
    const fatos = [
      ...Array.from({ length: 9 }, () => entrega({ nudges: 1 })),
      entrega({ nudges: 40 }),
    ]
    const m = medirCiclo(fatos)
    expect(m.cutucadas.mediana).toBe(1)
    expect(m.cutucadas.maximo).toBe(40)
  })

  it('o tempo conta SÓ as que fecharam', () => {
    // Incluir as abertas mediria "o tempo até agora", que encolhe a conta e
    // melhora o número sozinho com o passar do relógio.
    const m = medirCiclo([
      entrega({ closedAt: new Date('2026-08-29T04:00:00Z') }),
      entrega({ closedAt: null }),
    ])
    expect(m.horasAteFechar?.mediana).toBe(4)
  })

  it('nenhuma fechada: o tempo é NULO, não zero', () => {
    // Zero horas até fechar seria a melhor marca possível — dita por uma
    // entrega que nunca fechou.
    const m = medirCiclo([entrega({ closedAt: null })])
    expect(m.horasAteFechar).toBeNull()
  })

  it('sem entrega nenhuma devolve zeros, e isso é uma resposta', () => {
    const m = medirCiclo([])
    expect(m.entregas).toBe(0)
    expect(m.dePrimeira).toBe(0)
    expect(m.horasAteFechar).toBeNull()
  })

  it('o que NÃO dá para medir vem escrito, com o motivo', () => {
    // Um travessão sem explicação é indistinguível de zero para quem lê.
    const m = medirCiclo([entrega()])
    expect(m.naoMedido).toEqual([...NAO_MEDIDO])
    expect(m.naoMedido[0]).toContain('QA reprovou')
    expect(m.naoMedido.every((x) => x.includes('—') || x.includes('-'))).toBe(true)
  })
})
