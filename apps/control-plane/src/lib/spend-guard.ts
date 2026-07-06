// Controle de gasto (BYOK): o agente roda no LLM do CLIENTE (Claude, Codex ou
// Antigravity). Se rodar solto, estoura a conta dele → cancelamento com raiva.
// Este guarda decide, ANTES de disparar uma missão, se dá pra rodar sem
// arriscar a quota do motor nem o orçamento de tokens do plano.
// Ver docs/business/pricing-strategy.md ("proteção de gasto de token").

export type QuotaHealth = 'ok' | 'low' | 'critical' | 'unknown'

// Frações de saúde da quota quando o total é conhecido.
const LOW_FRACTION = 0.15
const CRITICAL_FRACTION = 0.05
// Limiares absolutos (tokens) quando só se conhece o restante, não o total.
const LOW_ABSOLUTE = 50_000

/**
 * Saúde da quota restante de um motor. `null`/desconhecido → 'unknown' (nunca
 * bloqueia por falta de dado; melhor rodar do que travar o cliente à toa).
 */
export function quotaHealth(
  remaining: number | null | undefined,
  total?: number | null | undefined
): QuotaHealth {
  if (remaining == null) return 'unknown'
  if (remaining <= 0) return 'critical'
  if (total != null && total > 0) {
    const frac = remaining / total
    if (frac <= CRITICAL_FRACTION) return 'critical'
    if (frac <= LOW_FRACTION) return 'low'
    return 'ok'
  }
  return remaining < LOW_ABSOLUTE ? 'low' : 'ok'
}

/** Quota crítica bloqueia rodar (protege a conta do cliente de estourar). */
export function shouldBlockForQuota(health: QuotaHealth): boolean {
  return health === 'critical'
}

/** Quota baixa não bloqueia, mas merece alerta ao dono. */
export function shouldAlertForQuota(health: QuotaHealth): boolean {
  return health === 'low' || health === 'critical'
}

/** Já gastou o orçamento de tokens do período? Sem orçamento definido = sem trava. */
export function withinTokenBudget(spent: number, budget?: number | null): boolean {
  if (budget == null || budget <= 0) return true
  return spent < budget
}

export interface SpendCheck {
  quotaRemaining?: number | null
  quotaTotal?: number | null
  tokensSpent: number
  tokenBudget?: number | null
}

/**
 * Decisão combinada: pode disparar a próxima missão? Junta a saúde da quota do
 * motor com o orçamento de tokens do plano. Retorna o motivo do bloqueio para
 * telemetria/alerta.
 */
export function canRunMission(check: SpendCheck): {
  ok: boolean
  reason?: 'engine-quota-critical' | 'token-budget'
  health: QuotaHealth
} {
  const health = quotaHealth(check.quotaRemaining, check.quotaTotal)
  if (shouldBlockForQuota(health)) {
    return { ok: false, reason: 'engine-quota-critical', health }
  }
  if (!withinTokenBudget(check.tokensSpent, check.tokenBudget)) {
    return { ok: false, reason: 'token-budget', health }
  }
  return { ok: true, health }
}
