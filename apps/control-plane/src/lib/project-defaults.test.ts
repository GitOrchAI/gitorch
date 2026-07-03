import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_SCHEDULES, ensureDefaultSchedules } from './project-defaults.js'

function fakePrisma(existingRoles: string[] = []) {
  const created: Array<Record<string, unknown>> = []
  return {
    created,
    projectSchedule: {
      count: vi.fn(async ({ where }: { where: { agentRole: string } }) =>
        existingRoles.includes(where.agentRole) ? 1 : 0
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return data
      }),
    },
  }
}

describe('ensureDefaultSchedules', () => {
  test('cria a agenda padrão com lastTriggeredAt em now (sem storm no 1º tick)', async () => {
    const prisma = fakePrisma()
    const now = new Date('2026-01-10T12:34:00Z')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await ensureDefaultSchedules(prisma as any, 'proj_1', now)

    expect(count).toBe(DEFAULT_SCHEDULES.length)
    for (const data of prisma.created) {
      expect(data['lastTriggeredAt']).toBe(now)
      expect(data['projectId']).toBe('proj_1')
    }
  })

  test('é idempotente por papel: só cria o que falta', async () => {
    const prisma = fakePrisma(['ra', 'po'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(count).toBe(1)
    expect(prisma.created.map((d) => d['agentRole'])).toEqual(['sm'])
  })

  test('não cria nada quando todas as agendas já existem', async () => {
    const prisma = fakePrisma(['ra', 'po', 'sm'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(count).toBe(0)
    expect(prisma.created).toHaveLength(0)
  })
})
