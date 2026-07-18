// Resolução do plano ativo do wizard — lógica pura, fora do React (mesma
// decisão de engine-status.ts/submit-flow.ts/telegram-link.ts: o app web não
// tem jsdom/testing-library, então o que precisa de teste mora aqui).
//
// O bug real (18/07): quem entrava no wizard com ?plan=pro (vindo da
// landing), logava com GitHub, e voltava do OAuth como 'free'. A causa raiz
// era dupla — o backend não carregava o plano no `state` assinado nem no
// redirect final, E o front só lia a URL uma vez, no primeiro mount. Como o
// login OAuth é uma navegação de página INTEIRA (não SPA), todo estado em
// memória React morre e volta do zero — só sobra o que estiver na URL de
// retorno ou em storage.
//
// Prioridade de resolução: URL (o sinal mais recente — inclusive o que a API
// devolve no redirect pós-login) > sessionStorage (sobrevive à ida e volta do
// GitHub mesmo se a URL de retorno não carregar a query) > 'free' (piso
// seguro, nunca assume plano pago sem prova).

export const VALID_PLANS = ['free', 'solo', 'pro', 'team'] as const
export type Plan = (typeof VALID_PLANS)[number]

// sessionStorage (não localStorage): a intenção de plano é da SESSÃO de
// onboarding atual, não deve sobreviver indefinidamente nem vazar para uma
// visita futura desligada deste fluxo.
export const PLAN_STORAGE_KEY = 'gitorch_plan'

function isValidPlan(value: string | null | undefined): value is Plan {
  return !!value && (VALID_PLANS as readonly string[]).includes(value)
}

/** Extrai e valida `?plan=` de uma querystring bruta (com ou sem "?" inicial). */
export function planFromSearch(search: string): Plan | null {
  const params = new URLSearchParams(search)
  const raw = params.get('plan')
  return isValidPlan(raw) ? raw : null
}

/**
 * Resolve o plano ativo. `stored` é o valor lido do sessionStorage (ou
 * `null`/`undefined` se ausente). Nunca devolve um valor fora de VALID_PLANS.
 */
export function resolvePlan(search: string, stored: string | null | undefined): Plan {
  const fromUrl = planFromSearch(search)
  if (fromUrl) return fromUrl
  if (isValidPlan(stored)) return stored
  return 'free'
}
