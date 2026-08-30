import { describe, expect, it } from 'vitest'
import { INTERVALO_DE_RELEITURA_MIN, cotasAReler, precisaRelerCota } from './cotas-a-reler.js'

const AGORA = new Date('2026-08-30T12:00:00.000Z')
const minutosAtras = (n: number) => new Date(AGORA.getTime() - n * 60 * 1000)

const conectado = (quotaRefreshedAt: Date | string | null, runtime = 'claude') => ({
  userId: 'u1',
  runtime,
  status: 'connected',
  quotaRefreshedAt,
})

describe('precisaRelerCota', () => {
  it('lê o motor que nunca teve cota lida — o caso que ficava vazio para sempre', () => {
    expect(precisaRelerCota(conectado(null), AGORA)).toBe(true)
  })

  it('não relê o que acabou de ser lido', () => {
    expect(precisaRelerCota(conectado(minutosAtras(1)), AGORA)).toBe(false)
  })

  it('relê quando passou o intervalo', () => {
    expect(precisaRelerCota(conectado(minutosAtras(INTERVALO_DE_RELEITURA_MIN)), AGORA)).toBe(true)
    expect(precisaRelerCota(conectado(minutosAtras(INTERVALO_DE_RELEITURA_MIN + 5)), AGORA)).toBe(
      true
    )
  })

  it('não relê um minuto antes da hora', () => {
    expect(precisaRelerCota(conectado(minutosAtras(INTERVALO_DE_RELEITURA_MIN - 1)), AGORA)).toBe(
      false
    )
  })

  it('carimbo ilegível conta como "não sei quando li" e manda ler', () => {
    expect(precisaRelerCota(conectado('nao-e-data'), AGORA)).toBe(true)
  })

  it('aceita carimbo em texto', () => {
    expect(precisaRelerCota(conectado(minutosAtras(2).toISOString()), AGORA)).toBe(false)
    expect(precisaRelerCota(conectado(minutosAtras(90).toISOString()), AGORA)).toBe(true)
  })

  it('ignora conexão que não está conectada — gasto puro sem número no fim', () => {
    for (const status of ['error', 'revoked', 'expired', 'pending', 'stale', 'needs_reconnect']) {
      expect(precisaRelerCota({ ...conectado(null), status }, AGORA)).toBe(false)
    }
  })
})

describe('cotasAReler', () => {
  it('devolve só as vencidas, preservando os dados de cada conexão', () => {
    const lista = [
      conectado(null, 'claude'),
      conectado(minutosAtras(2), 'codex'),
      conectado(minutosAtras(120), 'antigravity'),
      { ...conectado(null, 'antigravity'), status: 'error' },
    ]
    expect(cotasAReler(lista, AGORA).map((c) => c.runtime)).toEqual(['claude', 'antigravity'])
  })

  it('lista vazia não quebra', () => {
    expect(cotasAReler([], AGORA)).toEqual([])
  })
})
