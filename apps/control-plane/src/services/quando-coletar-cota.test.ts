import { describe, expect, it } from 'vitest'
import { estaNaHoraDeColetarCota, INTERVALO_DE_COLETA_DE_COTA_MS } from './quando-coletar-cota.js'

const AGORA = new Date('2026-08-27T18:00:00Z')

describe('quando coletar a cota', () => {
  it('nunca coletamos: e sempre hora', () => {
    expect(estaNaHoraDeColetarCota(null, AGORA)).toBe(true)
    expect(estaNaHoraDeColetarCota(undefined, AGORA)).toBe(true)
  })

  it('coletado agora ha pouco: nao gasta chamada de novo', () => {
    // A decisao de nao reaquecer a cada missao estava certa pelo motivo dela:
    // reaquecer sempre gastaria a cota do cliente a toa.
    const recente = new Date(AGORA.getTime() - 60_000)
    expect(estaNaHoraDeColetarCota(recente, AGORA)).toBe(false)
  })

  it('passado o intervalo: coleta', () => {
    const velha = new Date(AGORA.getTime() - INTERVALO_DE_COLETA_DE_COTA_MS - 1_000)
    expect(estaNaHoraDeColetarCota(velha, AGORA)).toBe(true)
  })

  it('exatamente no intervalo ja conta', () => {
    const noPonto = new Date(AGORA.getTime() - INTERVALO_DE_COLETA_DE_COTA_MS)
    expect(estaNaHoraDeColetarCota(noPonto, AGORA)).toBe(true)
  })

  it('data no futuro NAO trava a coleta para sempre', () => {
    // Relogio torto ou restauracao de backup. O custo de uma coleta a mais e
    // uma chamada; o de nunca mais coletar e o produto voltar a ser cego.
    const futuro = new Date(AGORA.getTime() + 10 * 60 * 60_000)
    expect(estaNaHoraDeColetarCota(futuro, AGORA)).toBe(true)
  })

  it('quatro coletas por dia, nao uma por missao', () => {
    expect(INTERVALO_DE_COLETA_DE_COTA_MS).toBe(6 * 60 * 60_000)
    expect((24 * 60 * 60_000) / INTERVALO_DE_COLETA_DE_COTA_MS).toBe(4)
  })
})
