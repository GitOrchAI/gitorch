// Medição de consumo por diferença de quota (ideia do owner): fotografa a quota
// restante do motor ANTES da missão e DEPOIS; a diferença é o que a missão
// gastou. Não depende do LLM reportar tokens — usa a quota que já lemos.

export interface Consumption {
  quotaBefore: number | null
  quotaAfter: number | null
  tokensUsed: number | null
}

/**
 * Consumo = antes − depois, quando ambos são conhecidos e a diferença é
 * positiva (a quota só cai com uso). Qualquer dado ausente ou variação
 * negativa (ex.: reset diário da quota no meio) → tokensUsed null (honesto,
 * não inventa número).
 */
export function computeConsumption(
  quotaBefore: number | null | undefined,
  quotaAfter: number | null | undefined
): Consumption {
  const before = quotaBefore ?? null
  const after = quotaAfter ?? null
  let tokensUsed: number | null = null
  if (before != null && after != null) {
    const delta = before - after
    tokensUsed = delta >= 0 ? delta : null
  }
  return { quotaBefore: before, quotaAfter: after, tokensUsed }
}

import {
  getGuestConsumptionCostKey,
  getGuestConsumptionTokensKey,
} from '../plugins/rate-limit-keys.js'
import { createRedisClient } from '../plugins/redis.js'
const redis = createRedisClient()
import { calcularCustoDeCI, MetricasDeExecucaoCI } from '@gitorch/cadence'

import { GuestQuota } from '@gitorch/cadence'

export async function fetchGuestConsumption(
  guestId: string,
  projectId: string,
  quota?: GuestQuota
): Promise<{
  consumedTokens: number
  consumedCost: number
  proportionTokens?: number
  proportionCost?: number
}> {
  const costKey = getGuestConsumptionCostKey(guestId, projectId)
  const tokensKey = getGuestConsumptionTokensKey(guestId, projectId)
  try {
    const costStr = await redis.get(costKey)
    const tokensStr = await redis.get(tokensKey)
    const consumedCost = costStr ? parseFloat(costStr) : 0
    const consumedTokens = tokensStr ? parseInt(tokensStr, 10) : 0

    const result: {
      consumedTokens: number
      consumedCost: number
      proportionTokens?: number
      proportionCost?: number
    } = { consumedCost, consumedTokens }

    if (quota) {
      result.proportionTokens = quota.maxTokens > 0 ? consumedTokens / quota.maxTokens : 0
      if (quota.maxCost !== undefined) {
        result.proportionCost = quota.maxCost > 0 ? consumedCost / quota.maxCost : 0
      }
    }

    return result
  } catch (e) {
    console.warn(`Failed to fetch guest consumption for ${guestId} in redis:`, e)
    return { consumedCost: 0, consumedTokens: 0 }
  }
}

export async function recordGuestConsumption(
  guestId: string,
  projectId: string,
  metrics: MetricasDeExecucaoCI,
  tokensUsed: number
): Promise<void> {
  const costKey = getGuestConsumptionCostKey(guestId, projectId)
  const tokensKey = getGuestConsumptionTokensKey(guestId, projectId)
  const cost = calcularCustoDeCI(metrics)
  try {
    await redis.incrbyfloat(costKey, cost)
    await redis.incrby(tokensKey, tokensUsed)
  } catch (e) {
    console.warn(`Failed to update guest consumption for ${guestId} in redis:`, e)
  }
}
