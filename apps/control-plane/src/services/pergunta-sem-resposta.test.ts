import { describe, it, expect } from 'vitest'
import { deveTentarResponderDeNovo } from './pergunta-sem-resposta.js'
import { MAX_NUDGES } from './jules-session-loop.js'

describe('deveTentarResponderDeNovo — a pergunta que ficou sem resposta', () => {
  it('pergunta NOVA: responde, sem discussão', () => {
    expect(deveTentarResponderDeNovo({ hashDaPergunta: 'p1', answeredHash: null, nudges: 0 })).toBe(
      true
    )
  })

  it('outra pergunta depois da primeira: responde a nova', () => {
    expect(deveTentarResponderDeNovo({ hashDaPergunta: 'p2', answeredHash: 'p1', nudges: 1 })).toBe(
      true
    )
  })

  it('MESMA pergunta e ainda esperando: tenta de novo — era aqui que a sessão morria', () => {
    // O defeito real: a marca era gravada ANTES de a resposta existir. Quando
    // a missão que responde falhava, a pergunta ficava marcada para sempre e a
    // vigília nunca mais tentava. Treze sessões presas assim, a mais antiga
    // havia sete dias.
    expect(deveTentarResponderDeNovo({ hashDaPergunta: 'p1', answeredHash: 'p1', nudges: 1 })).toBe(
      true
    )
  })

  it('para no teto: não vira laço infinito gastando motor', () => {
    expect(
      deveTentarResponderDeNovo({
        hashDaPergunta: 'p1',
        answeredHash: 'p1',
        nudges: MAX_NUDGES,
      })
    ).toBe(false)
  })

  it('acima do teto também para', () => {
    expect(
      deveTentarResponderDeNovo({
        hashDaPergunta: 'p1',
        answeredHash: 'p1',
        nudges: MAX_NUDGES + 5,
      })
    ).toBe(false)
  })

  it('o teto vale para a MESMA pergunta, nunca para uma nova', () => {
    // Uma conversa longa e legítima (o dev pergunta, recebe, pergunta outra
    // coisa) não pode ser confundida com uma pergunta que não foi respondida.
    expect(
      deveTentarResponderDeNovo({
        hashDaPergunta: 'p9',
        answeredHash: 'p1',
        nudges: MAX_NUDGES + 10,
      })
    ).toBe(true)
  })
})
