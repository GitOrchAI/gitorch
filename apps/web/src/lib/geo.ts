// Detecção de país do visitante, no cliente. O Funnel não repassa o IP do
// cliente pro backend, então quem decide a faixa/moeda é o navegador: pelo IP
// real (geo-IP), caindo no idioma só se TODOS os provedores falharem. Usado
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

function parseJson(body: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// Provedores keyless com CORS. Vários de propósito: se um estiver com o limite
// grátis estourado (ipapi.co dá 429 fácil), outro responde. Não depender de um.
const PROVIDERS: Array<{ url: string; pick: (body: string) => string | undefined }> = [
  { url: 'https://api.country.is/', pick: (b) => parseJson(b)?.['country'] as string | undefined },
  {
    url: 'https://ipwho.is/?fields=country_code',
    pick: (b) => parseJson(b)?.['country_code'] as string | undefined,
  },
  { url: 'https://ipapi.co/country/', pick: (b) => b },
]

async function fromProvider(p: (typeof PROVIDERS)[number], signal: AbortSignal): Promise<string> {
  const body = await fetch(p.url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`http ${r.status}`)
    return r.text()
  })
  const cc = (p.pick(body) ?? '').trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(cc)) return cc
  throw new Error('país inválido')
}

export async function detectCountry(): Promise<string | undefined> {
  // Corrida entre os provedores: o primeiro válido vence. Timeout curto pra não
  // travar a UI; se todos falharem, cai no idioma do navegador.
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const cc = await Promise.any(PROVIDERS.map((p) => fromProvider(p, ctrl.signal)))
    clearTimeout(timer)
    ctrl.abort() // cancela os perdedores
    if (/^[A-Z]{2}$/.test(cc)) return cc
  } catch {
    // todos os provedores fora (limite/bloqueio/timeout) — cai no locale
  }
  return localeCountry()
}
