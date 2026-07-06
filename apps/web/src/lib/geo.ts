// Detecção de país do visitante, no cliente. O Funnel não repassa o IP do
// cliente pro backend, então quem decide a faixa/moeda é o navegador: primeiro
// pelo IP real (geo-IP), caindo no idioma só se o serviço de geo falhar. Usado
// tanto na landing (exibir preço) quanto no wizard (moeda do checkout Stripe).

function localeCountry(): string | undefined {
  if (typeof navigator === 'undefined') return undefined
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const l of langs) {
    const m = /-([A-Za-z]{2})$/.exec(l || '')
    if (m) return m[1].toUpperCase()
  }
  const base = (navigator.language || '').slice(0, 2).toLowerCase()
  return ({ pt: 'BR', es: 'MX', hi: 'IN', id: 'ID', vi: 'VN', en: 'US' } as Record<string, string>)[
    base
  ]
}

export async function detectCountry(): Promise<string | undefined> {
  // Geo-IP com timeout curto: se o serviço demorar, não trava — cai no locale.
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2500)
    const cc = (
      await fetch('https://ipapi.co/country/', { signal: ctrl.signal }).then((r) => r.text())
    ).trim()
    clearTimeout(timer)
    if (/^[A-Z]{2}$/.test(cc)) return cc
  } catch {
    // rede/serviço fora ou timeout — cai no locale
  }
  return localeCountry()
}
