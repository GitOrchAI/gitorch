import { describe, expect, it } from 'vitest'
import { tierForCountry, tierRichness, cardTierIsCoherent } from './geo-pricing.js'

describe('tierForCountry', () => {
  it('mapeia países ricos para A', () => {
    expect(tierForCountry('US')).toBe('A')
    expect(tierForCountry('DE')).toBe('A')
    // Eurozona corrigida de B→A na revisão /autoplan
    expect(tierForCountry('ES')).toBe('A')
    expect(tierForCountry('PT')).toBe('A')
    expect(tierForCountry('GR')).toBe('A')
    expect(tierForCountry('SA')).toBe('A') // Arábia Saudita adicionada
  })

  it('mapeia Brasil e emergentes-médios para B', () => {
    expect(tierForCountry('BR')).toBe('B')
    expect(tierForCountry('MX')).toBe('B')
    expect(tierForCountry('PL')).toBe('B')
  })

  it('mapeia land-grab para C, incluindo Turquia/Argentina', () => {
    expect(tierForCountry('IN')).toBe('C')
    expect(tierForCountry('ID')).toBe('C')
    expect(tierForCountry('NG')).toBe('C')
    expect(tierForCountry('TR')).toBe('C')
    expect(tierForCountry('AR')).toBe('C')
  })

  it('país desconhecido/ausente cai em A (nunca dá barato por omissão)', () => {
    expect(tierForCountry(undefined)).toBe('A')
    expect(tierForCountry(null)).toBe('A')
    expect(tierForCountry('')).toBe('A')
    expect(tierForCountry('ZZ')).toBe('A')
    expect(tierForCountry('CN')).toBe('A') // China excluída de desconto
  })

  it('aceita minúsculas e espaços', () => {
    expect(tierForCountry(' br ')).toBe('B')
    expect(tierForCountry('in')).toBe('C')
  })
})

describe('cardTierIsCoherent (anti-abuso VPN)', () => {
  it('rico pagando preço rico é coerente', () => {
    expect(cardTierIsCoherent('US', 'A')).toBe(true)
  })

  it('pobre pagando preço rico é coerente (paga a mais, tudo bem)', () => {
    expect(cardTierIsCoherent('IN', 'A')).toBe(true)
    expect(cardTierIsCoherent('BR', 'A')).toBe(true)
  })

  it('rico tentando pagar preço pobre NÃO é coerente (bloqueia)', () => {
    expect(cardTierIsCoherent('US', 'C')).toBe(false)
    expect(cardTierIsCoherent('DE', 'B')).toBe(false)
  })

  it('cartão de país desconhecido é tratado como rico (A) → só paga preço A', () => {
    expect(cardTierIsCoherent(null, 'A')).toBe(true)
    expect(cardTierIsCoherent(null, 'C')).toBe(false)
  })

  it('richness ordena A>B>C', () => {
    expect(tierRichness('A')).toBeGreaterThan(tierRichness('B'))
    expect(tierRichness('B')).toBeGreaterThan(tierRichness('C'))
  })
})
