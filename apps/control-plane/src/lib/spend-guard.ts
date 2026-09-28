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
  orgId: string
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
  const currentlyReserved = reservedTokensByOrg.get(check.orgId) || 0
  const totalSpent = check.tokensSpent + currentlyReserved
  if (!withinTokenBudget(totalSpent, check.tokenBudget)) {
    return { ok: false, reason: 'token-budget', health }
  }
  return { ok: true, health }
}

/** Mock memory store to store reserved tokens during execution since actual token expenditure is settled asynchronously */
const reservedTokensByOrg = new Map<string, number>()

export class GuestQuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuestQuotaExceededError'
  }
}

export class QuotaExcedidaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExcedidaError'
  }
}

export const TOKENS_RESERVE_ESTIMATE = 10000

export function canExecuteMission(
  orgId: string,
  tokensNeeded: number,
  tokenBudget: number | null,
  tokensSpent: number
): boolean {
  if (tokenBudget == null || tokenBudget <= 0) return true
  const currentlyReserved = reservedTokensByOrg.get(orgId) || 0
  return tokensSpent + currentlyReserved + tokensNeeded <= tokenBudget
}

export function verificarQuotaPreExecucao(
  orgId: string,
  tokensNeeded: number,
  tokenBudget?: number | null,
  tokensSpent?: number,
  quotaRemaining?: number | null,
  quotaTotal?: number | null,
  onAlert?: (msg: string) => void
): void {
  const budget = tokenBudget ?? null
  const spent = tokensSpent ?? 0

  const health = quotaHealth(quotaRemaining, quotaTotal)
  if (shouldAlertForQuota(health) && onAlert) {
    onAlert(`Quota ${health} no motor para a org ${orgId}`)
  }

  if (!canExecuteMission(orgId, tokensNeeded, budget, spent)) {
    if (onAlert) {
      onAlert(`Quota excedida: uso de tokens atingiu o orcamento na org ${orgId}`)
    }
    throw new QuotaExcedidaError('Quota excedida')
  }
}

export function reserveMissionTokens(orgId: string, tokensNeeded: number): void {
  const currentlyReserved = reservedTokensByOrg.get(orgId) || 0
  reservedTokensByOrg.set(orgId, currentlyReserved + tokensNeeded)
}

export function settleMissionTokens(orgId: string, reservedAmount: number): void {
  // Reduces the reserved amount upon actual settling. Actual ledger addition should be done in DB logic.
  const currentlyReserved = reservedTokensByOrg.get(orgId) || 0
  const newReserved = Math.max(0, currentlyReserved - reservedAmount)
  if (newReserved === 0) {
    reservedTokensByOrg.delete(orgId)
  } else {
    reservedTokensByOrg.set(orgId, newReserved)
  }
}

export function releaseMissionTokens(orgId: string, tokens: number): void {
  settleMissionTokens(orgId, tokens)
}

export function _resetSpendGuardReservationsForTesting(): void {
  reservedTokensByOrg.clear()
}

export const revokedGuests = new Set<string>()

export function revokeGuestAccess(guestId: string, reason: string): void {
  revokedGuests.add(guestId)
  console.log(`Guest ${guestId} revoked: ${reason}`)
}

export function isGuestRevoked(guestId: string): boolean {
  return revokedGuests.has(guestId)
}

export function clearRevokedGuests(): void {
  revokedGuests.clear()
}

export async function checkGuestQuotaAvailable(guestId: string, projectId: string): Promise<void> {
  const { prisma } = await import('../plugins/prisma.js')
  const invitation = await prisma.projectInvitation.findUnique({
    where: { id: guestId },
  })
  if (!invitation || !invitation.executionLimits) return

  const limits = invitation.executionLimits as { maxQuota?: number; maxStepsPerMission?: number }
  if (limits.maxQuota == null || limits.maxQuota <= 0) return

  const usedQuota = await prisma.mission.count({
    where: {
      projectId: projectId,
      payload: {
        path: ['guestId'],
        equals: guestId,
      },
    },
  })

  const appEmit = (globalThis as unknown as { appEmitter?: { emit: Function } }).appEmitter
  if (appEmit && limits.maxQuota > 0) {
    const fraction = usedQuota / limits.maxQuota
    if (fraction >= 1) {
      appEmit.emit('telemetry:guest_quota_alert', {
        guestId,
        projectId,
        fraction,
        used: usedQuota,
        limit: limits.maxQuota,
      })
    } else if (fraction >= 0.8) {
      appEmit.emit('telemetry:guest_quota_alert', {
        guestId,
        projectId,
        fraction,
        used: usedQuota,
        limit: limits.maxQuota,
      })
    }
  }

  if (usedQuota >= limits.maxQuota) {
    throw new GuestQuotaExceededError(`Quota excedida para o convidado ${guestId}`)
  }
}

export async function assertGuestQuotaAvailable(guestId: string, projectId: string): Promise<void> {
  const { prisma } = await import('../plugins/prisma.js')
  const invitation = await prisma.projectInvitation.findUnique({
    where: { id: guestId },
  })
  if (!invitation || !invitation.executionLimits) return

  const limits = invitation.executionLimits as { maxQuota?: number; maxStepsPerMission?: number }
  if (limits.maxQuota == null || limits.maxQuota <= 0) return

  const usedQuota = await prisma.mission.count({
    where: {
      projectId: projectId,
      payload: {
        path: ['guestId'],
        equals: guestId,
      },
    },
  })

  const appEmit = (globalThis as unknown as { appEmitter?: { emit: Function } }).appEmitter
  if (appEmit && limits.maxQuota > 0) {
    const fraction = usedQuota / limits.maxQuota
    if (fraction >= 1) {
      appEmit.emit('telemetry:guest_quota_alert', {
        guestId,
        projectId,
        fraction,
        used: usedQuota,
        limit: limits.maxQuota,
      })
    } else if (fraction >= 0.8) {
      appEmit.emit('telemetry:guest_quota_alert', {
        guestId,
        projectId,
        fraction,
        used: usedQuota,
        limit: limits.maxQuota,
      })
    }
  }

  if (usedQuota >= limits.maxQuota) {
    throw new QuotaExcedidaError(`Quota excedida para o convidado ${guestId}`)
  }
}
