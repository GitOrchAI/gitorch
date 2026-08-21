import { describe, expect, it } from 'vitest'
import { tetoDiarioBloqueia } from './teto-diario.js'

describe('tetoDiarioBloqueia', () => {
  it('segura os papéis de planejamento quando o teto do dia estourou', () => {
    for (const role of ['ra', 'po', 'sm'] as const) {
      expect(tetoDiarioBloqueia({ role, usadasHoje: 24, teto: 24 })).toBe(true)
      expect(tetoDiarioBloqueia({ role, usadasHoje: 25, teto: 24 })).toBe(true)
    }
  })

  it('NUNCA segura o julgamento, nem com o teto estourado', () => {
    // O caso real de 20/08/2026: teto batido às 17h e, das 17h à meia-noite, o
    // log repetiu a cada minuto "Failsafe da instância atingido (24/24);
    // pulando qa". Sete horas sem poder mesclar, com cinco entregas prontas e
    // verificação verde esperando. Decisão do dono (D25, 21/08): julgar é o
    // passo que transforma trabalho em entrega e não pode ser o primeiro a
    // cair quando a cota aperta.
    expect(tetoDiarioBloqueia({ role: 'qa', usadasHoje: 24, teto: 24 })).toBe(false)
    expect(tetoDiarioBloqueia({ role: 'qa', usadasHoje: 999, teto: 24 })).toBe(false)
  })

  it('abaixo do teto, ninguém é segurado', () => {
    for (const role of ['ra', 'po', 'sm', 'qa'] as const) {
      expect(tetoDiarioBloqueia({ role, usadasHoje: 23, teto: 24 })).toBe(false)
    }
  })

  it('teto zero segura os outros papéis e ainda assim libera o julgamento', () => {
    // Instância configurada para não iniciar trabalho novo: o que já foi
    // entregue continua podendo ser julgado e mesclado.
    expect(tetoDiarioBloqueia({ role: 'ra', usadasHoje: 0, teto: 0 })).toBe(true)
    expect(tetoDiarioBloqueia({ role: 'qa', usadasHoje: 0, teto: 0 })).toBe(false)
  })
})
