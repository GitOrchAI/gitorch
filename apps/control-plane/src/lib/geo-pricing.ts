// Geo-pricing PPP: mapeia país (ISO 3166-1 alpha-2) para a FAIXA de poder de
// compra usada na precificação. A = rica (paga cheio), B = emergente-média,
// C = land-grab. Regra de ouro anti-abuso: país DESCONHECIDO cai na Faixa A —
// o desconto exige elegibilidade provada; nunca se dá barato por omissão.
//
// Fonte da estratégia: docs/business/pricing-strategy.md (v2, pós-/autoplan).

export type PricingTier = 'A' | 'B' | 'C'

// Faixa A — alta renda. Inclui Eurozona inteira (Espanha/Portugal/Grécia foram
// corrigidos de B→A na revisão) e Golfo rico (+Arábia Saudita).
export const BAND_A = new Set([
  'US',
  'CA',
  'GB',
  'IE',
  'DE',
  'FR',
  'NL',
  'SE',
  'NO',
  'DK',
  'FI',
  'IS',
  'CH',
  'AT',
  'BE',
  'LU',
  'ES',
  'PT',
  'GR',
  'IT',
  'AU',
  'NZ',
  'SG',
  'JP',
  'KR',
  'AE',
  'QA',
  'SA',
  'KW',
  'BH',
  'IL',
  'HK',
])

// Faixa B — renda média / emergente com poder de compra intermediário.
export const BAND_B = new Set([
  'BR',
  'MX',
  'CL',
  'CO',
  'PL',
  'CZ',
  'RO',
  'HU',
  'ZA',
  'MY',
  'TH',
  'CR',
  'UY',
])

// Faixa C — land-grab: alta adoção de IA, renda baixa. Turquia/Argentina caem
// aqui pela fragilidade cambial (movidos de B).
export const BAND_C = new Set([
  'IN',
  'ID',
  'VN',
  'PH',
  'PK',
  'BD',
  'NG',
  'EG',
  'KE',
  'UA',
  'TR',
  'AR',
  'LK',
  'NP',
  'GH',
  'MA',
  'DZ',
  'TN',
])

/**
 * Faixa de preço para um país. `undefined`/desconhecido → 'A' (paga cheio).
 * China (CN) é intencionalmente tratada como A no lançamento (excluída de
 * desconto por compliance; ver doc). Aceita maiúsculas ou minúsculas.
 */
export function tierForCountry(country?: string | null): PricingTier {
  if (!country) return 'A'
  const cc = country.trim().toUpperCase()
  if (BAND_C.has(cc)) return 'C'
  if (BAND_B.has(cc)) return 'B'
  return 'A'
}

/**
 * Ordem de "riqueza" da faixa (A=2 alto ... C=0). Usado no anti-abuso: se o
 * país do CARTÃO é de faixa mais rica que a faixa do preço escolhido, bloqueia
 * ou reprecifica (um rico não pode comprar no preço de um país pobre).
 */
export function tierRichness(tier: PricingTier): number {
  return tier === 'A' ? 2 : tier === 'B' ? 1 : 0
}

/**
 * Coerência país-do-cartão × faixa-do-preço. Retorna true se o cartão pode
 * legitimamente pagar aquele preço, ou seja, o país do cartão é de poder de
 * compra IGUAL OU MENOR que a faixa cobrada (pobre pode pagar preço rico; rico
 * não pode pagar preço pobre).
 */
export function cardTierIsCoherent(
  cardCountry: string | null | undefined,
  chargedTier: PricingTier
): boolean {
  const cardTier = tierForCountry(cardCountry)
  return tierRichness(cardTier) <= tierRichness(chargedTier)
}
