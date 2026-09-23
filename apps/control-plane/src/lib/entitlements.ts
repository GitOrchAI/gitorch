// Entitlements central: uma única função can() decide o que um plano libera.
// Evita `if (plan === 'pro')` espalhado pelo código (dívida). As flags vivem no
// Plan.features (JSON) — ver prisma/seed.ts. Ver docs/business/pricing-strategy.md.
import { prisma } from '../plugins/prisma.js'
import { generateHmacToken, verifyHmacToken } from './credential-crypto.js'
import { approveGuestInDatabase } from '../plugins/prisma.js'
import { DEFAULT_GUEST_DURATION_HOURS } from '../config/constants.js'
import { type GuestMember } from '@gitorch/cadence'

export type Capability =
  | 'autoAutonomy' // agente decide sozinho (vs. dono aprova cada missão)
  | 'sensors' // sensores de produção/incidentes ligados
  | 'priorityQueue' // prioridade na fila de missões
  | 'persistentMemory' // memória do projeto persiste (fosso de retenção)
  | 'sso' // login único / organização

// Forma mínima de um plano para os cálculos (compatível com o model Prisma).
export interface PlanLike {
  features?: unknown
  maxProjects: number
  maxMissionsPerDay: number
  maxConcurrentMissions: number
  seats: number
}

function featureFlag(features: unknown, cap: Capability): boolean {
  if (features && typeof features === 'object' && !Array.isArray(features)) {
    return (features as Record<string, unknown>)[cap] === true
  }
  return false
}

/** O plano libera esta capacidade? Default seguro: false (nega por omissão). */
export function can(plan: Pick<PlanLike, 'features'>, capability: Capability): boolean {
  return featureFlag(plan.features, capability)
}

/** Pode adicionar mais um projeto sem estourar o limite do plano? */
export function canAddProject(plan: PlanLike, currentProjectCount: number): boolean {
  return currentProjectCount < plan.maxProjects
}

/** Pode convidar mais um membro (seats)? */
export function canAddSeat(plan: PlanLike, currentSeatCount: number): boolean {
  return currentSeatCount < plan.seats
}

/** Quantos slots de missão simultânea ainda cabem para este plano. */
export function remainingConcurrency(plan: PlanLike, activeMissions: number): number {
  return Math.max(0, plan.maxConcurrentMissions - activeMissions)
}

/** Pode iniciar mais uma missão hoje sem estourar o limite diário do plano? */
export function canExecuteMissionToday(plan: PlanLike, missionsToday: number): boolean {
  return missionsToday < plan.maxMissionsPerDay
}

import { Prisma } from '@prisma/client'
import type { GuestAgentEngineMapping, GuestExecutionLimits } from '@gitorch/agents'

export interface ProjectInvitationPayload {
  userId: string
  targetProjects: string[]
  expiresAt: Date
  email?: string
  githubLogin?: string
  engineMapping?: GuestAgentEngineMapping
  executionLimits?: GuestExecutionLimits
}

export async function generateProjectInvitation(
  payload: ProjectInvitationPayload
): Promise<string> {
  const data: Prisma.ProjectInvitationUncheckedCreateInput = {
    userId: payload.userId,
    targetProjects: payload.targetProjects,
    expiresAt: payload.expiresAt,
    status: 'PENDING_APPROVAL',
  }

  if (payload.engineMapping) {
    data.engineMapping = payload.engineMapping as Prisma.InputJsonValue
  } else {
    data.engineMapping = Prisma.JsonNull
  }

  if (payload.executionLimits) {
    data.executionLimits = payload.executionLimits as Prisma.InputJsonValue
  } else {
    data.executionLimits = Prisma.JsonNull
  }

  const invitation = await prisma.projectInvitation.create({
    data,
  })

  const tokenPayload = {
    ...payload,
    invitationId: invitation.id,
  }

  // Converter ttl de expiração (ms) em minutos, já que generateHmacToken espera minutos
  const diffInMs = payload.expiresAt.getTime() - Date.now()
  const expirationMinutes = Math.max(1, Math.floor(diffInMs / 60000))

  const token = generateHmacToken(JSON.stringify(tokenPayload), expirationMinutes)
  return token
}

export function validateProjectInvitation(
  token: string
): ProjectInvitationPayload & { invitationId: string } {
  const decrypted = verifyHmacToken(token)
  const parsed = JSON.parse(decrypted)
  const expiresAt = new Date(parsed.expiresAt)

  // VerifyHmacToken already checks expiration on the token level,
  // but we can double check the parsed object payload if needed.
  if (expiresAt < new Date()) {
    throw new Error('Project invitation expired')
  }

  return {
    ...parsed,
    expiresAt,
  }
}

export async function approveGuestMembership(
  projectId: string,
  guestId: string,
  durationHours?: number
) {
  const hours = durationHours ?? DEFAULT_GUEST_DURATION_HOURS
  const validUntil = new Date()
  validUntil.setHours(validUntil.getHours() + hours)

  return approveGuestInDatabase(projectId, guestId, validUntil)
}

export async function updateGuestProjectScope(
  guestId: string,
  allowedProjectIds: string[],
  autonomyLevel: string
): Promise<GuestMember> {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { id: guestId },
  })

  if (!invitation) {
    throw new Error('Guest invitation not found')
  }

  const updated = await prisma.projectInvitation.update({
    where: { id: guestId },
    data: {
      targetProjects: {
        projects: allowedProjectIds,
        autonomyLevel: autonomyLevel,
      },
    },
  })

  return {
    id: updated.id,
    targetProjects: allowedProjectIds,
    autonomyLevel: autonomyLevel,
  }
}
