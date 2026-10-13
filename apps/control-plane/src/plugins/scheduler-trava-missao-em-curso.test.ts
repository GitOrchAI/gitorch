import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { BuildAgentMissionInput, RuntimeExecutionResult } from '@gitorch/agents'

// "O que roda termina": a trava de entrega só fecha a porta de ENTRADA. Uma
// missão que já estava `running` quando a trava foi ligada conclui do jeito
// normal, com o estado final gravado, e nunca é cancelada nem marcada como
// falha por causa da trava.
//
// Caminho REAL (`app.triggerAgentMission` → `runTrigger` → execução da missão),
// com o motor trocado por um dublê que fica parado até o teste soltá-lo. A
// sincronia é por promessa (o motor avisa que começou; o teste solta o motor),
// nunca por pausa fixa.
const motor = vi.hoisted(() => ({
  comecou: null as null | (() => void),
  soltar: null as null | Promise<void>,
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    AgentOrchestrator: class {
      constructor(_options: unknown) {}
      events() {
        return { subscribe: vi.fn() }
      }
      async runMission(_input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
        motor.comecou?.()
        await motor.soltar
        return {
          missionId: 'irrelevante',
          runtime: 'antigravity',
          exitCode: 0,
          durationMs: 1,
          output:
            '## Revisão de QA\n\nTestei o PR #42 ponta a ponta: build verde.\n\n### Veredito\n\nAprovado.',
          stderr: '',
        }
      }
    },
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  devPlan: null,
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
} as const

function buildFakePrisma(estado: { ligada: boolean }) {
  const gravacoes: Array<{ where: unknown; data: Record<string, unknown> }> = []
  const registrar = async (args: { where: unknown; data: Record<string, unknown> }) => {
    gravacoes.push(args)
    return { count: 1 }
  }
  const prisma = {
    travaDeEntrega: {
      findUnique: vi.fn(async () =>
        estado.ligada
          ? { id: 'entrega', ligada: true, desde: new Date(), motivo: 'm', ligadaPor: 'p' }
          : null
      ),
    },
    mission: {
      updateMany: vi.fn(registrar),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        await registrar(args)
        return { id: 'mission_1' }
      }),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ payload: {} })),
      create: vi.fn(async () => ({ id: 'mission_1' })),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => ({ motoresEsgotadosAvisadoEm: null })),
      update: vi.fn(async () => ({})),
    },
    telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
    devSession: { count: vi.fn(async () => 0) },
  }
  return { prisma, gravacoes }
}

const ENV_KEYS = ['GITORCH_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']

describe('a trava de entrega não mexe no que já está rodando', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    vi.restoreAllMocks()
  })

  test('missão em curso quando a trava liga conclui com o estado final gravado', async () => {
    const estado = { ligada: false }
    const fake = buildFakePrisma(estado)
    const comecou = new Promise<void>((resolve) => (motor.comecou = resolve))
    let soltar!: () => void
    motor.soltar = new Promise<void>((resolve) => (soltar = resolve))

    const app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)
    try {
      const disparo = await app.triggerAgentMission('qa', 'proj_1')
      expect(disparo.triggered).toBe(true)

      // A missão está no meio do trabalho: liga a trava agora.
      await comecou
      estado.ligada = true
      const antes = fake.gravacoes.length

      soltar()
      await vi.waitFor(
        () =>
          expect(
            fake.gravacoes.some(
              (g) =>
                g.data['status'] === 'completed' &&
                (g.where as { status?: string }).status === 'running'
            )
          ).toBe(true),
        { timeout: 4000, interval: 5 }
      )

      const depois = fake.gravacoes.slice(antes)
      const estados = depois.map((g) => g.data['status']).filter((s) => s !== undefined)
      expect(estados).not.toContain('cancelled')
      expect(estados).not.toContain('failed')
      expect(estados).toContain('completed')
    } finally {
      soltar()
      await app.close()
    }
  })
})
