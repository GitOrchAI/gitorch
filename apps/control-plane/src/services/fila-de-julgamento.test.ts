import { describe, it, expect } from 'vitest'
import { criarFilaDeJulgamento } from './fila-de-julgamento.js'

describe('fila de julgamento pedida pelo SM', () => {
  it('fila vazia não devolve ninguém para acordar', () => {
    const fila = criarFilaDeJulgamento()
    expect(fila.proxima()).toBeUndefined()
    expect(fila.tamanho()).toBe(0)
  })

  it('drena UMA por vez — nada de rajada', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 3)
    expect(fila.proxima()).toBe('p1')
    expect(fila.pendentes('p1')).toBe(2)
    expect(fila.proxima()).toBe('p1')
    expect(fila.proxima()).toBe('p1')
    expect(fila.proxima()).toBeUndefined()
  })

  it('acordada nova do SM sobre as MESMAS entregas não acumula fila', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 3)
    fila.enfileirar('p1', 3)
    expect(fila.pendentes('p1')).toBe(3)
  })

  it('entrega nova além das já enfileiradas aumenta a fila', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 1)
    fila.enfileirar('p1', 3)
    expect(fila.pendentes('p1')).toBe(3)
  })

  it('rodízio: um projeto cheio não deixa o outro esperando para sempre', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 3)
    fila.enfileirar('p2', 1)
    expect([fila.proxima(), fila.proxima(), fila.proxima(), fila.proxima()]).toEqual([
      'p1',
      'p2',
      'p1',
      'p1',
    ])
  })

  it('recusa temporária devolve a vez — a entrega não perde o julgamento', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 1)
    expect(fila.proxima()).toBe('p1')
    expect(fila.pendentes('p1')).toBe(0)
    fila.devolver('p1')
    expect(fila.pendentes('p1')).toBe(1)
    expect(fila.proxima()).toBe('p1')
  })

  it('enfileirar zero não cria fila fantasma', () => {
    const fila = criarFilaDeJulgamento()
    fila.enfileirar('p1', 0)
    expect(fila.tamanho()).toBe(0)
    expect(fila.proxima()).toBeUndefined()
  })
})
