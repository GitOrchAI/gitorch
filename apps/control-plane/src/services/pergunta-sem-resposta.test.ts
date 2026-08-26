import { describe, it, expect } from 'vitest'
import {
  decidirSobreAPergunta,
  lerMarca,
  marcarDesistencia,
  marcarRespondida,
  marcarTentativa,
  MAX_TENTATIVAS_DE_RESPOSTA,
} from './pergunta-sem-resposta.js'

/**
 * Encadeia ciclos DE VERDADE, como o relógio faz de dez em dez minutos.
 *
 * A revisão que achou os defeitos da primeira versão só os viu porque fez
 * isso: cada teste antigo chamava a decisão UMA vez, com um estado fixo, e por
 * isso passavam 100% verdes enquanto o produto oscilava para sempre em
 * produção. Teste que não pode falhar não prova nada.
 */
function rodarCiclos(hashes: string[]): {
  respostas: number[]
  desistencias: number
  nadas: number
  marcaFinal: string | null
} {
  let marca: string | null = null
  const respostas: number[] = []
  let desistencias = 0
  let nadas = 0

  for (const hash of hashes) {
    const d = decidirSobreAPergunta({ hashDaPergunta: hash, marca })
    if (d.acao === 'responder') {
      respostas.push(d.tentativa)
      // A resposta NÃO saiu — é o cenário que prendia as sessões.
      marca = marcarTentativa(hash, d.tentativa)
    } else if (d.acao === 'desistir') {
      desistencias += 1
      marca = marcarDesistencia(hash, d.tentativas)
    } else {
      nadas += 1
    }
  }
  return { respostas, desistencias, nadas, marcaFinal: marca }
}

describe('a mesma pergunta, ciclo após ciclo, sem resposta nenhuma', () => {
  const MESMA = Array.from({ length: 10 }, () => 'pergunta-1')

  it('tenta até o teto e PARA — nada de oscilar entre tentar e desistir', () => {
    const r = rodarCiclos(MESMA)
    expect(r.respostas).toEqual([1, 2, 3])
    expect(r.respostas.length).toBe(MAX_TENTATIVAS_DE_RESPOSTA)
  })

  it('o dono é avisado UMA vez, não a cada dois ciclos', () => {
    expect(rodarCiclos(MESMA).desistencias).toBe(1)
  })

  it('depois de desistir, nenhum motor é gasto de novo nessa pergunta', () => {
    const r = rodarCiclos(MESMA)
    // 3 tentativas + 1 desistência + 6 ciclos que não fazem nada = 10.
    expect(r.nadas).toBe(10 - MAX_TENTATIVAS_DE_RESPOSTA - 1)
  })

  it('e vinte ciclos depois continua parado — o defeito era exatamente não parar', () => {
    const r = rodarCiclos(Array.from({ length: 30 }, () => 'pergunta-1'))
    expect(r.respostas.length).toBe(MAX_TENTATIVAS_DE_RESPOSTA)
    expect(r.desistencias).toBe(1)
  })
})

describe('conversa longa e legítima: cada pergunta tem o SEU teto', () => {
  it('quatro perguntas diferentes seguidas: todas respondidas na primeira tentativa', () => {
    const r = rodarCiclos(['p1', 'p2', 'p3', 'p4'])
    expect(r.respostas).toEqual([1, 1, 1, 1])
    expect(r.desistencias).toBe(0)
  })

  it('o desgaste das anteriores NÃO é herdado pela pergunta nova', () => {
    // Três tentativas na p1 (sem resposta), e então o dev pergunta outra coisa.
    const r = rodarCiclos(['p1', 'p1', 'p1', 'p2', 'p2'])
    // A p2 recomeça do 1 — não cai no teto por culpa da p1.
    expect(r.respostas).toEqual([1, 2, 3, 1, 2])
    expect(r.desistencias).toBe(0)
  })

  it('mesmo depois de desistir de uma, a pergunta seguinte é tentada normalmente', () => {
    const r = rodarCiclos(['p1', 'p1', 'p1', 'p1', 'p2'])
    expect(r.desistencias).toBe(1)
    expect(r.respostas).toEqual([1, 2, 3, 1])
  })
})

describe('a resposta que SAI encerra o assunto', () => {
  it('marcada como respondida: nunca mais tenta, nem gasta motor', () => {
    const d = decidirSobreAPergunta({
      hashDaPergunta: 'p1',
      marca: marcarRespondida('p1'),
    })
    expect(d.acao).toBe('nada')
  })

  it('respondida a p1 não silencia a p2', () => {
    const d = decidirSobreAPergunta({
      hashDaPergunta: 'p2',
      marca: marcarRespondida('p1'),
    })
    expect(d).toEqual({ acao: 'responder', tentativa: 1 })
  })
})

describe('lerMarca', () => {
  it('lê de volta o que foi gravado', () => {
    expect(lerMarca(marcarTentativa('abc', 2))).toEqual({
      situacao: 'tentando',
      hash: 'abc',
      tentativas: 2,
    })
  })

  it('marca de formato antigo ou desconhecido vira "nunca vi" — e o produto tenta, não desiste', () => {
    expect(lerMarca('hash-cru-de-antes')).toBeNull()
    expect(lerMarca(null)).toBeNull()
    expect(lerMarca('situacao-inventada:1:abc')).toBeNull()
    expect(lerMarca('tentando:nao-e-numero:abc')).toBeNull()
    // E o efeito prático: é tratada como pergunta nova, nunca como desistida.
    expect(decidirSobreAPergunta({ hashDaPergunta: 'abc', marca: 'hash-cru-de-antes' })).toEqual({
      acao: 'responder',
      tentativa: 1,
    })
  })

  it('hash com dois-pontos dentro sobrevive à ida e volta', () => {
    expect(lerMarca(marcarTentativa('a:b:c', 1))?.hash).toBe('a:b:c')
  })
})
