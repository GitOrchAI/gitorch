import { describe, expect, test, vi } from 'vitest'
import { CRON_ANTIGO_DO_SM, DEFAULT_SCHEDULES, ensureDefaultSchedules } from './project-defaults.js'

function fakePrisma(existingRoles: string[] = [], cronPorPapel: Record<string, string> = {}) {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<{ id: string; cron: string }> = []
  // linhas existentes ganham um id previsível (`sched_<papel>`) para o
  // update mockado poder ser conferido pelo teste.
  const linhas = new Map(
    existingRoles.map((role) => [
      role,
      { id: `sched_${role}`, agentRole: role, cron: cronPorPapel[role] ?? CRON_ANTIGO_DO_SM },
    ])
  )
  return {
    created,
    updated,
    projectSchedule: {
      count: vi.fn(async ({ where }: { where: { agentRole: string } }) =>
        linhas.has(where.agentRole) ? 1 : 0
      ),
      findFirst: vi.fn(async ({ where }: { where: { agentRole: string } }) => {
        const linha = linhas.get(where.agentRole)
        return linha ? { id: linha.id, cron: linha.cron } : null
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { cron: string } }) => {
        updated.push({ id: where.id, cron: data.cron })
        return { id: where.id, cron: data.cron }
      }),
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

    expect(count).toBe(2)
    expect(prisma.created.map((d) => d['agentRole'])).toEqual(['sm', 'qa'])
  })

  test('projeto antigo, criado antes de o QA ter agenda, ganha a agenda que falta', async () => {
    // O caso REAL desta VM: os dois projetos em produção nasceram quando a
    // agenda padrão tinha só ra/po/sm. Sem esta idempotência por papel, a
    // correção do QA só valeria para projeto novo — ou seja, para ninguém.
    const prisma = fakePrisma(['ra', 'po', 'sm'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(count).toBe(1)
    expect(prisma.created.map((d) => d['agentRole'])).toEqual(['qa'])
  })

  test('não cria nada quando todas as agendas já existem', async () => {
    const prisma = fakePrisma(['ra', 'po', 'sm', 'qa'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(count).toBe(0)
    expect(prisma.created).toHaveLength(0)
  })

  test('DJ-T3: SM com o cron LEGADO exato migra para */15 * * * *', async () => {
    const prisma = fakePrisma(['ra', 'po', 'sm', 'qa'], { sm: CRON_ANTIGO_DO_SM })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(prisma.updated).toEqual([{ id: 'sched_sm', cron: '*/15 * * * *' }])
  })

  test('DJ-T3: SM com cron CUSTOMIZADO (ajuste manual do dono) não é pisado', async () => {
    const cronDoDono = '0 9 * * *'
    const prisma = fakePrisma(['ra', 'po', 'sm', 'qa'], { sm: cronDoDono })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(prisma.updated).toHaveLength(0)
  })

  test('DJ-T3: SM que já está no padrão novo não gera update', async () => {
    const prisma = fakePrisma(['ra', 'po', 'sm', 'qa'], { sm: '*/15 * * * *' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(prisma.updated).toHaveLength(0)
  })

  test('DJ-T3: papéis que não são SM nunca chamam findFirst/update', async () => {
    const prisma = fakePrisma(['ra', 'po'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureDefaultSchedules(prisma as any, 'proj_1')

    expect(prisma.projectSchedule.findFirst).not.toHaveBeenCalled()
    expect(prisma.projectSchedule.update).not.toHaveBeenCalled()
  })
})

describe('DEFAULT_SCHEDULES', () => {
  test('RA roda 2x/dia (06h/18h)', () => {
    const raSchedule = DEFAULT_SCHEDULES.find((s) => s.agentRole === 'ra')
    expect(raSchedule).toBeDefined()
    expect(raSchedule?.cron).toBe('0 6,18 * * *')
  })

  test('QA tem agenda própria, de 8 em 8 horas', () => {
    // Sem isto o QA só acorda por acaso — aviso de verificação do GitHub ou
    // entrega ainda aberta — e um pull request verde de dias atrás nunca é
    // julgado. docs/agents/quality-assurance.md §4.3 manda 8h.
    const qa = DEFAULT_SCHEDULES.find((s) => s.agentRole === 'qa')
    expect(qa).toBeDefined()
    expect(qa?.cron).toBe('0 0,8,16 * * *')
  })

  test('nenhum papel colide de horário com outro', () => {
    const horas = (cron: string) => (cron.split(' ')[1] ?? '').split(',')
    const vistos = new Map<string, string>()
    for (const s of DEFAULT_SCHEDULES) {
      for (const h of horas(s.cron)) {
        expect(vistos.has(h)).toBe(false)
        vistos.set(h, s.agentRole)
      }
    }
  })
})
