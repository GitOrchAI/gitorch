import { describe, it, expect } from 'vitest'
import {
  decidirSobreAPergunta,
  lerMarca,
  marcarDesistencia,
  marcarEscalada,
  marcarRespondida,
  marcarTentativa,
  MAX_TENTATIVAS_DE_RESPOSTA,
  JANELA_DE_TENTATIVA_EM_VOO_MS,
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

describe('a pergunta ESCALADA ao dono: nem respondida, nem tentada de novo', () => {
  // L4-T3: escalar ao dono não é "responder" — ninguém respondeu ainda, é o
  // dono que vai decidir. Mas também não pode voltar a ser tentada a cada
  // ciclo do QA: a pergunta já subiu, e subir de novo a cada acordada
  // spammaria o dono com a MESMA pergunta (agent_question dedupada por
  // dedupKey, mas o formulário do QA/RA rodaria de novo à toa, gastando
  // motor por nada).
  it('marcarEscalada grava com o prefixo "escalada:"', () => {
    expect(marcarEscalada('p1').startsWith('escalada:')).toBe(true)
  })

  it('lerMarca entende a marca de escalada e devolve o hash certo', () => {
    expect(lerMarca(marcarEscalada('abc'))).toEqual({
      situacao: 'escalada',
      hash: 'abc',
      tentativas: 0,
    })
  })

  it('decidirSobreAPergunta: mesma pergunta escalada → nada (não tenta de novo)', () => {
    const d = decidirSobreAPergunta({
      hashDaPergunta: 'p1',
      marca: marcarEscalada('p1'),
    })
    expect(d.acao).toBe('nada')
  })

  it('escalar a p1 não silencia uma p2 nova', () => {
    const d = decidirSobreAPergunta({
      hashDaPergunta: 'p2',
      marca: marcarEscalada('p1'),
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

describe('reserva EM VOO não é tentativa gasta', () => {
  const HASH = 'abc123'
  const AGORA = new Date('2026-08-27T01:00:00Z')

  it('a corrida real das tarefas #248 e #3799: o segundo ciclo NÃO sobe o contador', () => {
    // O ciclo A gravou `tentando:1` há trinta segundos e ainda está no motor.
    // Antes, o ciclo B lia isso como "a tentativa 1 já aconteceu" e subia para
    // 2 — e aí a devolução do ciclo A, condicional à marca dele, não valia.
    const decisao = decidirSobreAPergunta({
      hashDaPergunta: HASH,
      marca: marcarTentativa(HASH, 1),
      marcadaEm: new Date(AGORA.getTime() - 30_000),
      agora: AGORA,
    })
    expect(decisao).toEqual({
      acao: 'nada',
      motivo: 'já tem uma tentativa em voo para esta pergunta',
    })
  })

  it('reserva VELHA volta a subir o contador — senão a pergunta trava para sempre', () => {
    // Ciclo que morreu sem devolver (processo reiniciado no meio). Sem isto,
    // trocaríamos um jeito de perder trabalho por outro.
    const decisao = decidirSobreAPergunta({
      hashDaPergunta: HASH,
      marca: marcarTentativa(HASH, 1),
      marcadaEm: new Date(AGORA.getTime() - JANELA_DE_TENTATIVA_EM_VOO_MS - 1_000),
      agora: AGORA,
    })
    expect(decisao).toEqual({ acao: 'responder', tentativa: 2 })
  })

  it('mesmo em voo, uma pergunta NOVA sempre é atendida do zero', () => {
    // O teto nunca é herdado entre perguntas diferentes — a guarda de voo não
    // pode virar um jeito de calar um diálogo legítimo.
    const decisao = decidirSobreAPergunta({
      hashDaPergunta: 'pergunta-nova',
      marca: marcarTentativa(HASH, 1),
      marcadaEm: new Date(AGORA.getTime() - 30_000),
      agora: AGORA,
    })
    expect(decisao).toEqual({ acao: 'responder', tentativa: 1 })
  })

  it('sem o carimbo, o comportamento é o de antes (compatível com quem não passa o dado)', () => {
    expect(
      decidirSobreAPergunta({ hashDaPergunta: HASH, marca: marcarTentativa(HASH, 1) })
    ).toEqual({ acao: 'responder', tentativa: 2 })
  })

  it('carimbo no futuro (relógio torto) não trava a pergunta', () => {
    const decisao = decidirSobreAPergunta({
      hashDaPergunta: HASH,
      marca: marcarTentativa(HASH, 1),
      marcadaEm: new Date(AGORA.getTime() + 60_000),
      agora: AGORA,
    })
    expect(decisao).toEqual({ acao: 'responder', tentativa: 2 })
  })

  it('com motor caído, três ciclos em voo NUNCA chegam a desistir', () => {
    // A aceitação em uma linha: enquanto nenhuma tentativa se CONCLUI, o teto
    // não anda. Antes, três acordadas sobrepostas gastavam as três em minutos.
    let marca: string | null = null
    let marcadaEm: Date | null = null
    for (let i = 0; i < 3; i += 1) {
      const d = decidirSobreAPergunta({
        hashDaPergunta: HASH,
        marca,
        marcadaEm,
        agora: new Date(AGORA.getTime() + i * 1_000),
      })
      if (d.acao === 'responder') {
        marca = marcarTentativa(HASH, d.tentativa)
        marcadaEm = new Date(AGORA.getTime() + i * 1_000)
      }
      expect(d.acao).not.toBe('desistir')
    }
    expect(marca).toBe(marcarTentativa(HASH, 1))
  })
})
