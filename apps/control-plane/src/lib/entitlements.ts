// Entitlements central: uma única função can() decide o que um plano libera.
// Evita `if (plan === 'pro')` espalhado pelo código (dívida). As flags vivem no
// Plan.features (JSON) — ver prisma/seed.ts. Ver docs/business/pricing-strategy.md.
import { prisma } from '../plugins/prisma.js'
import { signInvitationToken, verifyInvitationToken } from './credential-crypto.js'

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

export interface ProjectInvitationPayload {
  userId: string
  targetProjects: string[]
  expiresAt: Date
  email?: string
  githubLogin?: string
}

export async function generateProjectInvitation(
  payload: ProjectInvitationPayload
): Promise<string> {
  const invitation = await prisma.projectInvitation.create({
    data: {
      userId: payload.userId,
      targetProjects: payload.targetProjects,
      expiresAt: payload.expiresAt,
    },
  })

  const tokenPayload = {
    ...payload,
    invitationId: invitation.id,
  }

  const token = signInvitationToken(JSON.stringify(tokenPayload), payload.expiresAt)
  return token
}

export function validateProjectInvitation(
  token: string
): ProjectInvitationPayload & { invitationId: string } {
  const decrypted = verifyInvitationToken(token)
  const parsed = JSON.parse(decrypted)
  const expiresAt = new Date(parsed.expiresAt)

  if (expiresAt < new Date()) {
    throw new Error('Project invitation expired')
  }

  return {
    ...parsed,
    expiresAt,
  }
}
