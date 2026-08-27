import { describe, it, expect } from 'vitest'
import { comecarPeloMaisAntigo, ordemDoJulgamento } from './ordem-do-julgamento.js'

const pr = (n: number) => ({ number: n })
// Do mais antigo (1) ao mais novo (5), como a busca entrega.
const LISTA = [pr(1), pr(2), pr(3), pr(4), pr(5)]
const numeros = (l: Array<{ number: number }>) => l.map((p) => p.number)

describe('ordemDoJulgamento — ninguém morre de fome na fila', () => {
  it('acordada dos antigos: o que espera há mais tempo vem primeiro', () => {
    expect(numeros(ordemDoJulgamento(LISTA, true))).toEqual([1, 2, 3, 4, 5])
  })

  it('acordada dos novos: quem acabou de entregar tem resposta rápida', () => {
    expect(numeros(ordemDoJulgamento(LISTA, false))).toEqual([5, 4, 3, 2, 1])
  })

  it('as duas pontas chegam ao primeiro lugar — nenhuma fica em segundo para sempre', () => {
    // Era exatamente esse o defeito: o laço para no PRIMEIRO que precisa de
    // parecer, então quem nunca é primeiro nunca é julgado. Com um PR novo
    // entrando a cada acordada, o antigo esperava dias.
    expect(numeros(ordemDoJulgamento(LISTA, true))[0]).toBe(1)
    expect(numeros(ordemDoJulgamento(LISTA, false))[0]).toBe(5)
  })

  it('não perde nem repete ninguém, nas duas pontas', () => {
    for (const ponta of [true, false]) {
      const ordem = ordemDoJulgamento(LISTA, ponta)
      expect(ordem).toHaveLength(LISTA.length)
      expect(new Set(numeros(ordem)).size).toBe(LISTA.length)
    }
  })

  it('não mexe na lista que recebeu', () => {
    const original = [...LISTA]
    ordemDoJulgamento(LISTA, false)
    expect(LISTA).toEqual(original)
  })

  it('lista vazia e lista de um sobrevivem', () => {
    expect(ordemDoJulgamento([], true)).toEqual([])
    expect(numeros(ordemDoJulgamento([pr(7)], false))).toEqual([7])
  })
})

describe('comecarPeloMaisAntigo — a ponta alterna a cada acordada', () => {
  it('minutos seguidos dão pontas diferentes', () => {
    const a = comecarPeloMaisAntigo(new Date('2026-08-26T10:10:00Z'))
    const b = comecarPeloMaisAntigo(new Date('2026-08-26T10:11:00Z'))
    expect(a).not.toBe(b)
  })

  it('ao longo de uma hora, as duas pontas aparecem em partes iguais', () => {
    const antigos = Array.from({ length: 60 }, (_, m) =>
      comecarPeloMaisAntigo(new Date(Date.UTC(2026, 7, 26, 10, m)))
    ).filter(Boolean).length
    expect(antigos).toBe(30)
  })
})
