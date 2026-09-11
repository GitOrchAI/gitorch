import { describe, expect, test } from 'vitest'
import { criarFilaDeVagaLiberada } from './acordar-sm.js'

describe('criarFilaDeVagaLiberada', () => {
  test('coalescência: 3 eventos do MESMO projeto no mesmo tique viram 1 disparo', () => {
    const fila = criarFilaDeVagaLiberada()
    fila.acordarSm('proj_1')
    fila.acordarSm('proj_1')
    fila.acordarSm('proj_1')

    expect(fila.tamanho()).toBe(1)
    expect(fila.proxima()).toBe('proj_1')
    // Drenado — nada mais para tirar da fila, mesmo com 3 eventos originais.
    expect(fila.proxima()).toBeUndefined()
  })

  test('projetos diferentes ficam em vezes separadas', () => {
    const fila = criarFilaDeVagaLiberada()
    fila.acordarSm('proj_1')
    fila.acordarSm('proj_2')

    expect(fila.tamanho()).toBe(2)
    expect(fila.proxima()).toBe('proj_1')
    expect(fila.proxima()).toBe('proj_2')
    expect(fila.proxima()).toBeUndefined()
  })

  test('devolver por recusa temporária deixa a vez disponível de novo', () => {
    const fila = criarFilaDeVagaLiberada()
    fila.acordarSm('proj_1')
    expect(fila.proxima()).toBe('proj_1')
    expect(fila.tamanho()).toBe(0)

    fila.devolver('proj_1')
    expect(fila.tamanho()).toBe(1)
    expect(fila.proxima()).toBe('proj_1')
  })

  test('acordarSm depois de já drenado no mesmo tique é um evento NOVO (próximo tique)', () => {
    const fila = criarFilaDeVagaLiberada()
    fila.acordarSm('proj_1')
    fila.proxima()
    fila.acordarSm('proj_1')

    expect(fila.tamanho()).toBe(1)
  })
})
