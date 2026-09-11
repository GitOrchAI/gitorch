import { describe, expect, test } from 'vitest'
import { horaEmSaoPaulo, linhasDaCotaDoDev } from './cota-do-dev-assincrono'
import type { ContaDeCotaDoDev } from './painel-tipos'

function conta(over: Partial<ContaDeCotaDoDev> = {}): ContaDeCotaDoDev {
  return {
    contaId: null,
    projetos: ['GitOrchAI/gitorch'],
    plano: 'pro',
    tetoConcorrentes: 15,
    tetoDiario: 100,
    simultaneas: 3,
    enviadas24h: 40,
    proximaVagaDiariaEm: null,
    prontasEsperandoVaga: 0,
    leituraDoSm: 'ok',
    ...over,
  }
}

describe('linhasDaCotaDoDev', () => {
  test('monta os 4 números a partir do payload cru — nenhum inventado', () => {
    const linhas = linhasDaCotaDoDev([
      conta({
        simultaneas: 3,
        tetoConcorrentes: 15,
        enviadas24h: 40,
        tetoDiario: 100,
        prontasEsperandoVaga: 5,
      }),
    ])
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({
      simultaneasTexto: '3 de 15',
      enviadas24hTexto: '40 de 100',
      prontasEsperandoVaga: 5,
      notaDeEsperandoVaga: 'tarefas prontas na fila',
    })
  })

  test('sem leitura do SM ainda → nota diz "sem leitura ainda", não finge 0 de verdade', () => {
    const linhas = linhasDaCotaDoDev([
      conta({ leituraDoSm: 'sem_leitura', prontasEsperandoVaga: 0 }),
    ])
    expect(linhas[0]?.prontasEsperandoVaga).toBe(0)
    expect(linhas[0]?.notaDeEsperandoVaga).toBe('sem leitura ainda')
  })

  // A tela ESCONDE o KPI de "próxima vaga" quando há folga — a decisão já
  // vem pronta do servidor (proximaVagaDiariaEm null), o cliente só traduz.
  test('com folga (proximaVagaDiariaEm null) → proximaVagaHorario null, tela esconde o KPI', () => {
    const linhas = linhasDaCotaDoDev([conta({ proximaVagaDiariaEm: null })])
    expect(linhas[0]?.proximaVagaHorario).toBeNull()
  })

  test('teto cheio (proximaVagaDiariaEm presente) → horário HH:MM de São Paulo', () => {
    // 2026-09-11T15:00:00Z = 12:00 em São Paulo (UTC-3, sem horário de verão).
    const linhas = linhasDaCotaDoDev([conta({ proximaVagaDiariaEm: '2026-09-11T15:00:00.000Z' })])
    expect(linhas[0]?.proximaVagaHorario).toBe('12:00')
  })

  test('uma conta só → sem rótulo (nada de repetir o nome do único projeto)', () => {
    const linhas = linhasDaCotaDoDev([conta()])
    expect(linhas[0]?.rotuloDaConta).toBeNull()
  })

  test('duas contas → cada linha rotulada pelos projetos que a dividem', () => {
    const linhas = linhasDaCotaDoDev([
      conta({ contaId: 'a', projetos: ['x/um'] }),
      conta({ contaId: 'b', projetos: ['x/dois', 'x/tres'] }),
    ])
    expect(linhas[0]?.rotuloDaConta).toBe('x/um')
    expect(linhas[1]?.rotuloDaConta).toBe('x/dois, x/tres')
  })

  test('lista vazia → lista vazia, não quebra', () => {
    expect(linhasDaCotaDoDev([])).toEqual([])
  })
})

describe('horaEmSaoPaulo', () => {
  test('converte ISO em UTC para HH:MM de São Paulo (UTC-3)', () => {
    expect(horaEmSaoPaulo('2026-09-11T15:00:00.000Z')).toBe('12:00')
  })

  test('meia-noite em São Paulo', () => {
    expect(horaEmSaoPaulo('2026-09-11T03:00:00.000Z')).toBe('00:00')
  })
})
