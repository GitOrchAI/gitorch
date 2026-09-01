import { describe, it, expect } from 'vitest'
import { formatarAvisoDeCustoDaOrdem } from './aviso-de-custo-da-ordem.js'
import type { CandidatoDeTroca } from '@gitorch/cadence'

const CANDIDATO: CandidatoDeTroca = {
  pedido: 102,
  peso: 1,
  esperaAtual: 13,
  esperaOtima: 0,
  perda: 13,
  razao: 13,
}

describe('formatarAvisoDeCustoDaOrdem — a frase do losango, com o número', () => {
  it('cita o pedido e o número da antecipação — nunca "considere reordenar" genérico', () => {
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto).toContain('#102')
    expect(texto).toContain('13')
    expect(texto).toContain('Quer trocar?')
  })

  it('deixa claro que a ordem do dono continua valendo até ele decidir', () => {
    // A lei do desenho: "você sempre decide". O texto não pode soar como se
    // o produto já tivesse trocado, nem pedir uma ação obrigatória.
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto.toLowerCase()).toContain('continua valendo')
  })

  it('não fala em "sprints" — o produto não mede velocidade/capacidade por sprint', () => {
    // Decisão registrada em custo-da-ordem.ts: converter para "sprints"
    // fabricaria um número que o produto não sustenta com dado real.
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto.toLowerCase()).not.toContain('sprint')
  })

  it('pluraliza "ponto" corretamente para perda de 1', () => {
    const texto = formatarAvisoDeCustoDaOrdem({ ...CANDIDATO, perda: 1 })
    expect(texto).toContain('1 ponto de peso')
    expect(texto).not.toContain('1 pontos')
  })

  it('usa plural para perda maior que 1', () => {
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto).toContain('13 pontos de peso')
  })
})
