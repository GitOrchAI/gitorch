import { describe, it, expect } from 'vitest'
import {
  analisarCustoDaOrdem,
  ordemQueMinimizaEspera,
  MIN_PEDIDOS_PARA_AVALIAR,
  LIMIAR_PONTOS_MINIMOS,
  LIMIAR_RAZAO,
  type PedidoNaFila,
} from './custo-da-ordem'

// A CAIXA DO FLUXOGRAMA (leva 2, "A logica da leva 2", aprovado 30/08):
//   losango: "Sua ordem custa caro? { perda / tamanho }"
//   SIM -> "Avisa você: 'Y entregaria N antes. Quer trocar?'"
//   NAO -> "Segue sua ordem — você sempre decide"
//
// Decisões do dono (01/09), que fecham a conta:
//  1. perda = quanto os OUTROS pedidos ficam esperando por causa da ordem
//     escolhida — a conta clássica de fila. Um item grande e pouco urgente na
//     frente faz todo mundo atrás esperar. "Tamanho" é o peso do próprio
//     ESCALA_DE_PESO (1,2,3,5,8,13) que o produto já tem — nada de campo novo
//     para o dono preencher.
//  2. só avisa quando a diferença for GRANDE — limiar documentado e ajustável.

describe('ordemQueMinimizaEspera — a ordem que minimiza a espera de todo mundo', () => {
  it('ordena por peso crescente (regra clássica de fila: o menor primeiro)', () => {
    const fila: PedidoNaFila[] = [
      { pedido: 101, peso: 13 },
      { pedido: 102, peso: 1 },
      { pedido: 103, peso: 2 },
    ]
    expect(ordemQueMinimizaEspera(fila).map((p) => p.pedido)).toEqual([102, 103, 101])
  })

  it('empate de peso preserva a ordem original entre os empatados (estável)', () => {
    const fila: PedidoNaFila[] = [
      { pedido: 501, peso: 13 },
      { pedido: 502, peso: 1 },
      { pedido: 503, peso: 1 },
    ]
    expect(ordemQueMinimizaEspera(fila).map((p) => p.pedido)).toEqual([502, 503, 501])
  })

  it('já ótima permanece igual', () => {
    const fila: PedidoNaFila[] = [
      { pedido: 1, peso: 1 },
      { pedido: 2, peso: 3 },
      { pedido: 3, peso: 8 },
    ]
    expect(ordemQueMinimizaEspera(fila).map((p) => p.pedido)).toEqual([1, 2, 3])
  })
})

describe('analisarCustoDaOrdem — poucos pedidos não têm o que otimizar', () => {
  it(`com menos de ${MIN_PEDIDOS_PARA_AVALIAR} pedidos, fica em silêncio mesmo com um caso gritante`, () => {
    // 13 na frente de 1 é o pior caso possível — e mesmo assim, com só 2
    // pedidos na fila, o dono já vê a ordem inteira de relance. Não há
    // otimização de fila que ajude quem só tem dois itens.
    const fila: PedidoNaFila[] = [
      { pedido: 601, peso: 13 },
      { pedido: 602, peso: 1 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(false)
    expect(analise.candidato).toBeNull()
    expect(analise.motivo).toMatch(new RegExp(String(MIN_PEDIDOS_PARA_AVALIAR)))
  })

  it('fila vazia também fica em silêncio, sem explodir', () => {
    const analise = analisarCustoDaOrdem([])
    expect(analise.custaCaro).toBe(false)
    expect(analise.candidato).toBeNull()
  })
})

describe('analisarCustoDaOrdem — a ordem já ótima nunca custa caro', () => {
  it('pesos em ordem crescente: nenhum pedido tem perda', () => {
    const fila: PedidoNaFila[] = [
      { pedido: 1, peso: 1 },
      { pedido: 2, peso: 3 },
      { pedido: 3, peso: 8 },
      { pedido: 4, peso: 13 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(false)
    expect(analise.candidato).toBeNull()
  })
})

describe('analisarCustoDaOrdem — o caso caro de verdade (a caixa do desenho)', () => {
  it('item grande de peso 13 na frente de dois itens pequenos: aponta o pedido, com o número', () => {
    // Fila escolhida pelo dono: #101 (peso 13) primeiro, depois #102 (peso 1)
    // e #103 (peso 2). Na ordem ATUAL, #102 espera 13 pontos antes de
    // começar — o tamanho inteiro de #101 — para entregar um pedido que é
    // treze vezes menor. Na ordem ÓTIMA (menor peso primeiro), #102 não
    // esperaria nada.
    const fila: PedidoNaFila[] = [
      { pedido: 101, peso: 13 },
      { pedido: 102, peso: 1 },
      { pedido: 103, peso: 2 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(true)
    if (!analise.custaCaro) throw new Error('esperava custaCaro true')
    expect(analise.candidato).toEqual({
      pedido: 102,
      peso: 1,
      esperaAtual: 13,
      esperaOtima: 0,
      perda: 13,
      razao: 13,
    })
  })

  it('empate de razão entre dois candidatos: escolhe o de menor número de pedido', () => {
    const fila: PedidoNaFila[] = [
      { pedido: 501, peso: 13 },
      { pedido: 502, peso: 1 },
      { pedido: 503, peso: 1 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(true)
    if (!analise.custaCaro) throw new Error('esperava custaCaro true')
    expect(analise.candidato.pedido).toBe(502)
    expect(analise.candidato.razao).toBe(13)
  })
})

describe('analisarCustoDaOrdem — diferença pequena é silêncio (limiar de ruído)', () => {
  it(`razão abaixo de ${LIMIAR_RAZAO} não interrompe o dono`, () => {
    // 5, 3, 8 — perto do ótimo (3, 5, 8). O único candidato (#302, razão
    // 1,67) fica abaixo do limiar de razão: é fila normal, não vale
    // interromper.
    const fila: PedidoNaFila[] = [
      { pedido: 301, peso: 5 },
      { pedido: 302, peso: 3 },
      { pedido: 303, peso: 8 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(false)
    expect(analise.candidato).toBeNull()
  })

  it(`perda abaixo de ${LIMIAR_PONTOS_MINIMOS} pontos não interrompe, mesmo com razão alta`, () => {
    // 2, 1, 1 — a razão bate o limiar (2) mas a perda é só 2 pontos: menos
    // que o menor degrau "com corpo" da escala (o produto usa 1 e 2 para
    // ajuste fino, não para itens de verdade — ver ESCALA_DE_PESO). Avisar
    // por 2 pontos é ruído.
    const fila: PedidoNaFila[] = [
      { pedido: 401, peso: 2 },
      { pedido: 402, peso: 1 },
      { pedido: 403, peso: 1 },
    ]
    const analise = analisarCustoDaOrdem(fila)
    expect(analise.custaCaro).toBe(false)
    expect(analise.candidato).toBeNull()
  })
})
