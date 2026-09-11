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

/** Nome da variável de ambiente que sobrescreve o cap de delegação por ciclo. */
export const ENV_CAP_POR_CICLO = 'GITORCH_SM_CAP_POR_CICLO'

/**
 * Override manual do cap de delegação por acordada, por variável de
 * ambiente — para operar um projeto específico fora do teto de simultâneas
 * do plano sem mexer em código.
 *
 * Ausente ou em branco: sem override, quem chama usa o padrão do plano.
 * Inválido (não é inteiro positivo): NUNCA lança e NUNCA usa o valor
 * quebrado — avisa via `onWarn` e devolve `undefined`, para que o chamador
 * caia no padrão do plano em vez de travar (ou pior, liberar) a esteira por
 * uma env mal configurada.
 */
export function capPorCicloDoAmbiente(
  env: NodeJS.ProcessEnv,
  onWarn?: (mensagem: string) => void
): number | undefined {
  const bruto = env[ENV_CAP_POR_CICLO]
  if (bruto === undefined || bruto.trim() === '') return undefined
  const n = Number(bruto)
  if (!Number.isInteger(n) || n <= 0) {
    onWarn?.(
      `plano-do-dev: ${ENV_CAP_POR_CICLO}="${bruto}" inválido (precisa ser inteiro positivo) — ` +
        'usando o padrão do plano'
    )
    return undefined
  }
  return n
}
