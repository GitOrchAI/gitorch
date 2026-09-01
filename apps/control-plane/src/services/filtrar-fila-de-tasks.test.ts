import { describe, it, expect } from 'vitest'
import { filtrarFilaDeTasks, type ItemDoQuadroParaFiltrar } from './filtrar-fila-de-tasks.js'

// A CAIXA QUE FALTAVA (D9, 01/09): medido no quadro real GitOrchAI #2 (124
// itens), 48 eram fase, épico, feature ou incidente — tipos que o produto
// NUNCA atribui peso, por desenho (só TASK recebe `## Peso`, ver
// backlog-executor.ts). A regra antiga ("todo item da fila precisa de peso")
// esperava por algo estruturalmente impossível: a D1 ("Sua ordem custa
// caro?") nunca disparava. Este arquivo prova que só TASK entra na conta —
// identificada pelo marcador que o backlog-executor JÁ grava no corpo
// (`gitorch:node:<wish>:task:<i>`), nunca por título.

function item(over: Partial<ItemDoQuadroParaFiltrar> = {}): ItemDoQuadroParaFiltrar {
  return { pedido: 1, peso: null, corpo: null, ...over }
}

const CORPO_DE_TASK = (wish: number, i: number) =>
  `## Peso\n\n<!-- gitorch:node:${wish}:task:${i} -->`
const CORPO_DE_FASE = (wish: number, i: number) => `<!-- gitorch:node:${wish}:phase:${i} -->`
const CORPO_DE_EPICO = (wish: number, i: number) => `<!-- gitorch:node:${wish}:epic:${i} -->`
const CORPO_DE_FEATURE = (wish: number, i: number) => `<!-- gitorch:node:${wish}:feature:${i} -->`
const CORPO_DE_INCIDENTE = (id: string) => `<!-- gitorch:incident:${id} -->`

describe('filtrarFilaDeTasks — só TASK entra na conta', () => {
  it('descarta fase, épico, feature e incidente; considera só as tasks', () => {
    const itens: ItemDoQuadroParaFiltrar[] = [
      item({ pedido: 1, peso: null, corpo: CORPO_DE_FASE(100, 0) }),
      item({ pedido: 2, peso: null, corpo: CORPO_DE_EPICO(100, 0) }),
      item({ pedido: 3, peso: null, corpo: CORPO_DE_FEATURE(100, 0) }),
      item({ pedido: 4, peso: null, corpo: CORPO_DE_INCIDENTE('abc123') }),
      item({ pedido: 5, peso: 3, corpo: CORPO_DE_TASK(100, 0) }),
      item({ pedido: 6, peso: 8, corpo: CORPO_DE_TASK(100, 1) }),
    ]

    const resultado = filtrarFilaDeTasks(itens)

    expect(resultado).toEqual({
      fila: [
        { pedido: 5, peso: 3 },
        { pedido: 6, peso: 8 },
      ],
    })
  })

  it('item sem marcador nenhum (criado à mão pelo cliente no quadro): fora da conta, nunca trava a fila', () => {
    const itens: ItemDoQuadroParaFiltrar[] = [
      item({ pedido: 1, peso: null, corpo: 'Uma issue qualquer, sem marcador nenhum.' }),
      item({ pedido: 2, peso: 5, corpo: CORPO_DE_TASK(100, 0) }),
    ]

    const resultado = filtrarFilaDeTasks(itens)

    expect(resultado).toEqual({ fila: [{ pedido: 2, peso: 5 }] })
  })
})

describe('filtrarFilaDeTasks — a prudência do peso continua de pé', () => {
  it('nenhuma task no quadro: silêncio, mas com o motivo explícito (não é "não consegui calcular")', () => {
    const itens: ItemDoQuadroParaFiltrar[] = [
      item({ pedido: 1, peso: null, corpo: CORPO_DE_FASE(100, 0) }),
      item({ pedido: 2, peso: null, corpo: CORPO_DE_EPICO(100, 0) }),
    ]

    const resultado = filtrarFilaDeTasks(itens)

    expect(resultado).toEqual({ fila: null, motivo: 'sem-task-nenhuma' })
  })

  it('quadro totalmente vazio: mesmo motivo de "sem task nenhuma"', () => {
    expect(filtrarFilaDeTasks([])).toEqual({ fila: null, motivo: 'sem-task-nenhuma' })
  })

  it('task sem peso conhecido: NUNCA inventa — silêncio com a contagem e os pedidos exatos', () => {
    const itens: ItemDoQuadroParaFiltrar[] = [
      item({ pedido: 10, peso: 3, corpo: CORPO_DE_TASK(100, 0) }),
      item({ pedido: 11, peso: null, corpo: CORPO_DE_TASK(100, 1) }),
      item({ pedido: 12, peso: null, corpo: CORPO_DE_TASK(100, 2) }),
      // agrupador junto, sem peso: não deve contar nem para o total nem para "semPeso"
      item({ pedido: 13, peso: null, corpo: CORPO_DE_FASE(100, 1) }),
    ]

    const resultado = filtrarFilaDeTasks(itens)

    expect(resultado).toEqual({
      fila: null,
      motivo: 'sem-peso',
      totalDeTasks: 3,
      semPeso: [11, 12],
    })
  })

  it('peso fora da ESCALA_DE_PESO (campo mexido à mão fora do produto): silêncio, com o motivo e os pedidos', () => {
    const itens: ItemDoQuadroParaFiltrar[] = [
      item({ pedido: 20, peso: 3, corpo: CORPO_DE_TASK(100, 0) }),
      item({ pedido: 21, peso: 4, corpo: CORPO_DE_TASK(100, 1) }), // 4 não está em [1,2,3,5,8,13]
    ]

    const resultado = filtrarFilaDeTasks(itens)

    expect(resultado).toEqual({
      fila: null,
      motivo: 'peso-fora-da-escala',
      totalDeTasks: 2,
      pedidos: [21],
    })
  })
})
