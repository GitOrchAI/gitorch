import { describe, it, expect } from 'vitest'
import { classificar, erroPara, deveMostrarSelo, frase } from './painel-estados'

describe('painel-estados', () => {
  it('classifica ok quando não há regra de vazio', () => {
    expect(classificar({ bruto: [1, 2] }).estado).toBe('ok')
  })
  it('classifica vazio quando a regra diz que está vazio', () => {
    const r = classificar({ bruto: [] as number[], vazio: (d: number[]) => d.length === 0 })
    expect(r.estado).toBe('vazio')
    expect(r.dados).toEqual([])
  })
  it('erroPara normaliza qualquer coisa em indisponivel + Error', () => {
    const r = erroPara('caiu a rede')
    expect(r.estado).toBe('indisponivel')
    expect(r.erro).toBeInstanceOf(Error)
    expect(r.erro.message).toBe('caiu a rede')
  })
  it('erroPara preserva um Error que já veio pronto', () => {
    const original = new Error('403')
    expect(erroPara(original).erro).toBe(original)
  })
  it('o selo só aparece em modo demo', () => {
    expect(deveMostrarSelo(true)).toBe(true)
    expect(deveMostrarSelo(false)).toBe(false)
  })
  it('a frase de indisponível cita o que falhou', () => {
    expect(frase('indisponivel', 'o ritmo da semana')).toBe(
      'Não deu para carregar o ritmo da semana agora.'
    )
  })
  it('a frase de vazio é vazia (a tela põe a própria)', () => {
    expect(frase('vazio', 'x')).toBe('')
  })
  it('a frase de carregando é a do handoff', () => {
    expect(frase('carregando', 'x')).toBe('Carregando…')
  })
})
