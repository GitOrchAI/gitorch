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
import { precificarSpan } from '@gitorch/cadence'
import type { PrismaClient } from '@prisma/client'
import { incrementGuestUsedQuota } from '../plugins/prisma.js'

export async function atualizarSaldoDaOrdem(
  span: { usage: { promptTokens: number; completionTokens: number } },
  runtime: string,
  missionId: string,
  prisma: PrismaClient
): Promise<void> {
  const cost = precificarSpan(span.usage, runtime)
  const tokens = span.usage.promptTokens + span.usage.completionTokens
  if (tokens > 0) {
    // Log tracking for cost calculation
    console.debug(
      `[consumption] Mission ${missionId} on ${runtime} consumed ${tokens} tokens (Cost: $${cost.toFixed(4)})`
    )
    await prisma.mission.update({
      where: { id: missionId },
      data: {
        tokensUsed: { increment: tokens },
      },
    })
  }
}

export async function recordGuestConsumption(
  guestId: string,
  projectId: string,
  stepMetrics: { usage: { promptTokens: number; completionTokens: number }; runtime: string }
): Promise<number> {
  const tokens = stepMetrics.usage.promptTokens + stepMetrics.usage.completionTokens
  if (tokens <= 0) return 0

  const cost = precificarSpan(stepMetrics.usage, stepMetrics.runtime)
  console.debug(
    `[consumption] Guest ${guestId} on project ${projectId} consumed ${tokens} tokens (Cost: $${cost.toFixed(4)})`
  )

  const updated = await incrementGuestUsedQuota(guestId, tokens)

  const limits = updated.executionLimits as { maxQuota?: number } | null
  if (limits?.maxQuota && limits.maxQuota > 0) {
    return updated.usedQuota / limits.maxQuota
  }
  return 0
}

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
