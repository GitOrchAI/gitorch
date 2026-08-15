// Os tetos do dev assíncrono, por plano declarado.
//
// Declarado e não consultado porque a API do Jules NÃO tem endpoint de cota —
// verificado na documentação oficial. Havia uma função `getJulesQuota` chamando
// `GET /quota`, que sempre respondeu 404 e caiu no próprio catch devolvendo
// nada: o produto achava que media a cota e nunca mediu.
//
// Fonte dos números: jules.google/docs/usage-limits.

export type PlanoDoDev = 'free' | 'pro' | 'ultra'

export interface TetosDoDev {
  tetoConcorrentes: number
  tetoDiario: number
}

const TETOS: Record<PlanoDoDev, TetosDoDev> = {
  free: { tetoConcorrentes: 3, tetoDiario: 15 },
  pro: { tetoConcorrentes: 15, tetoDiario: 100 },
  ultra: { tetoConcorrentes: 60, tetoDiario: 300 },
}

/**
 * Plano desconhecido ou ausente resolve no gratuito de propósito: errar para
 * baixo só atrasa a esteira; errar para cima queima a cota do cliente.
 */
export function tetosDoPlanoDoDev(plano: string | null | undefined): TetosDoDev {
  const chave = (plano ?? '').trim().toLowerCase()
  return TETOS[chave as PlanoDoDev] ?? TETOS.free
}
