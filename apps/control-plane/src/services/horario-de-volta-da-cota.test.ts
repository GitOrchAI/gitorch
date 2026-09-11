import { describe, it, expect } from 'vitest'
import {
  parseHorarioDeVoltaDaCota,
  ehErroDeCota,
  menorHorarioDeVolta,
} from './horario-de-volta-da-cota.js'

const AGORA = new Date('2026-09-10T12:00:00.000Z')

describe('parseHorarioDeVoltaDaCota — texto do provedor vira Date', () => {
  it('"Resets in 8h10m12s" (Antigravity, formato completo)', () => {
    const volta = parseHorarioDeVoltaDaCota(
      'Error: Individual quota reached. Resets in 8h10m12s.',
      AGORA
    )
    expect(volta).toEqual(new Date('2026-09-10T20:10:12.000Z'))
  })

  it('"Resets in 5m11s" (sem horas)', () => {
    const volta = parseHorarioDeVoltaDaCota('quota reached. Resets in 5m11s.', AGORA)
    expect(volta).toEqual(new Date('2026-09-10T12:05:11.000Z'))
  })

  it('"Resets in 45s" (só segundos)', () => {
    const volta = parseHorarioDeVoltaDaCota('quota reached. Resets in 45s.', AGORA)
    expect(volta).toEqual(new Date('2026-09-10T12:00:45.000Z'))
  })

  it('"try again at Sep 21st, 2026 6:00 AM" (Codex, data absoluta — PREMISSA: UTC)', () => {
    const volta = parseHorarioDeVoltaDaCota(
      "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at " +
        'Sep 21st, 2026 6:00 AM (https://chatgpt.com/explore/plus)',
      AGORA
    )
    expect(volta).toEqual(new Date('2026-09-21T06:00:00.000Z'))
  })

  it('data absoluta à tarde (PM) soma 12h corretamente', () => {
    const volta = parseHorarioDeVoltaDaCota('try again at Jan 3rd, 2027 2:30 PM', AGORA)
    expect(volta).toEqual(new Date('2027-01-03T14:30:00.000Z'))
  })

  it('texto sem horário nenhum devolve null', () => {
    expect(parseHorarioDeVoltaDaCota('Error: internal server error', AGORA)).toBeNull()
  })

  it('texto de cota sem NENHUM prazo (provedor não disse quando volta) devolve null', () => {
    expect(
      parseHorarioDeVoltaDaCota(
        'Individual quota reached. Please upgrade your subscription.',
        AGORA
      )
    ).toBeNull()
  })
})

describe('ehErroDeCota — reconhece erro de teto de uso (reaproveita ehTetoDeUsoDaConta)', () => {
  it('"Individual quota reached" (Antigravity, medido em produção)', () => {
    expect(
      ehErroDeCota(
        'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7h22m10s.'
      )
    ).toBe(true)
  })

  it('"usage limit" (Codex, medido em produção)', () => {
    expect(
      ehErroDeCota("You've hit your usage limit. Upgrade to Plus to continue using Codex")
    ).toBe(true)
  })

  it('erro que NÃO é de cota (ex.: banco fora do ar) não casa', () => {
    expect(ehErroDeCota('ECONNREFUSED 127.0.0.1:5432 (banco fora do ar)')).toBe(false)
  })

  it('erro de credencial expirada (login, não cota) não casa', () => {
    expect(
      ehErroDeCota('Your access token could not be refreshed. Please log out and sign in again.')
    ).toBe(false)
  })
})

describe('menorHorarioDeVolta — o motor que volta PRIMEIRO manda no prazo da espera', () => {
  it('devolve o menor entre várias datas', () => {
    const cedo = new Date('2026-09-10T14:00:00.000Z')
    const tarde = new Date('2026-09-10T20:00:00.000Z')
    expect(menorHorarioDeVolta([tarde, cedo])).toEqual(cedo)
  })

  it('lista vazia devolve null (o chamador decide o padrão)', () => {
    expect(menorHorarioDeVolta([])).toBeNull()
  })

  it('uma data só devolve ela mesma', () => {
    const unica = new Date('2026-09-10T14:00:00.000Z')
    expect(menorHorarioDeVolta([unica])).toEqual(unica)
  })
})
