import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  can,
  canAddProject,
  canAddSeat,
  remainingConcurrency,
  generateProjectInvitation,
  validateProjectInvitation,
  type PlanLike,
} from './entitlements.js'
import { prisma } from '../plugins/prisma.js'

vi.mock('../plugins/prisma.js', () => ({
  prisma: {
    projectInvitation: {
      create: vi.fn(),
    },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env['GITORCH_CREDENTIAL_KEY'] = 'a'.repeat(64)
})

const freePlan: PlanLike = {
  features: {
    autoAutonomy: false,
    sensors: false,
    priorityQueue: false,
    persistentMemory: false,
    sso: false,
  },
  maxProjects: 1,
  maxMissionsPerDay: 10,
  maxConcurrentMissions: 1,
  seats: 1,
}
const proPlan: PlanLike = {
  features: {
    autoAutonomy: true,
    sensors: true,
    priorityQueue: true,
    persistentMemory: true,
    sso: false,
  },
  maxProjects: 5,
  maxMissionsPerDay: 90,
  maxConcurrentMissions: 2,
  seats: 1,
}
const teamPlan: PlanLike = {
  features: {
    autoAutonomy: true,
    sensors: true,
    priorityQueue: true,
    persistentMemory: true,
    sso: true,
  },
  maxProjects: 20,
  maxMissionsPerDay: 300,
  maxConcurrentMissions: 4,
  seats: 10,
}

describe('can', () => {
  it('Free nega tudo', () => {
    expect(can(freePlan, 'sensors')).toBe(false)
    expect(can(freePlan, 'autoAutonomy')).toBe(false)
    expect(can(freePlan, 'persistentMemory')).toBe(false)
  })
  it('Pro libera sensores e memória, mas não SSO', () => {
    expect(can(proPlan, 'sensors')).toBe(true)
    expect(can(proPlan, 'persistentMemory')).toBe(true)
    expect(can(proPlan, 'priorityQueue')).toBe(true)
    expect(can(proPlan, 'sso')).toBe(false)
  })
  it('Team libera SSO', () => {
    expect(can(teamPlan, 'sso')).toBe(true)
  })
  it('features ausente/malformado nega por omissão', () => {
    expect(can({ features: undefined }, 'sensors')).toBe(false)
    expect(can({ features: null }, 'sensors')).toBe(false)
    expect(can({ features: [] }, 'sensors')).toBe(false)
    expect(can({ features: 'nope' }, 'sensors')).toBe(false)
  })
})

describe('limites', () => {
  it('canAddProject respeita maxProjects', () => {
    expect(canAddProject(freePlan, 0)).toBe(true)
    expect(canAddProject(freePlan, 1)).toBe(false)
    expect(canAddProject(proPlan, 4)).toBe(true)
    expect(canAddProject(proPlan, 5)).toBe(false)
  })
  it('canAddSeat respeita seats', () => {
    expect(canAddSeat(freePlan, 1)).toBe(false)
    expect(canAddSeat(teamPlan, 9)).toBe(true)
    expect(canAddSeat(teamPlan, 10)).toBe(false)
  })
  it('remainingConcurrency nunca é negativo', () => {
    expect(remainingConcurrency(proPlan, 0)).toBe(2)
    expect(remainingConcurrency(proPlan, 2)).toBe(0)
    expect(remainingConcurrency(proPlan, 5)).toBe(0)
  })
})

describe('invitations', () => {
  it('generateProjectInvitation saves and returns a token', async () => {
    const mockCreate = vi.mocked(prisma.projectInvitation.create).mockResolvedValue({
      id: 'inv-123',
      userId: 'user-1',
      targetProjects: ['p1', 'p2'],
      status: 'pending',
      expiresAt: new Date(Date.now() + 100000),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)

    const expiresAt = new Date(Date.now() + 100000)
    const payload = {
      userId: 'user-1',
      targetProjects: ['p1', 'p2'],
      expiresAt,
      email: 'test@example.com',
    }

    const token = await generateProjectInvitation(payload)

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        targetProjects: ['p1', 'p2'],
        expiresAt,
      },
    })

    const decoded = validateProjectInvitation(token)
    expect(decoded.userId).toBe('user-1')
    expect(decoded.targetProjects).toEqual(['p1', 'p2'])
    expect(decoded.email).toBe('test@example.com')
    expect(new Date(decoded.expiresAt)).toEqual(expiresAt)
    expect(decoded.invitationId).toBe('inv-123')
  })

  it('validateProjectInvitation throws an error when token is expired', async () => {
    vi.mocked(prisma.projectInvitation.create).mockResolvedValue({
      id: 'inv-124',
      userId: 'user-1',
      targetProjects: ['p1'],
      status: 'pending',
      expiresAt: new Date(Date.now() - 10000), // Past date
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)

    const expiresAt = new Date(Date.now() - 10000)
    const payload = {
      userId: 'user-1',
      targetProjects: ['p1'],
      expiresAt,
    }

    const token = await generateProjectInvitation(payload)
    expect(() => validateProjectInvitation(token)).toThrow('Project invitation expired')
  })
})
