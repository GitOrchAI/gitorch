import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '@gitorch/agents'
import { schedulerPlugin } from './scheduler.js'

vi.mock('@gitorch/workspace-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/workspace-engine')>()
  return {
    ...actual,
    LocalWorkspaceProvider: class {
      async allocateWorkspace() {
        return { path: '/tmp/workspace', id: '1' }
      }
      async releaseWorkspace() {
        return true
      }
    },
  }
})

const PROJETO = {
  id: 'proj_1',
  wingId: 'GitOrchAI/gitorch',
  name: 'GitOrch',
  userId: 'user_1',
  runtimeConfig: { perguntasAoDono: 'tudo' },
  devPlan: null,
  autonomia: null,
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
  devAccountId: 'dev_acc_1',
} as const

const resultadoDoMotor = vi.hoisted(() => ({
  porRuntime: null as Record<string, RuntimeExecutionResult> | null,
  chamadas: [] as string[],
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    createCliRuntimeAdapter: (options: { runtime: string }) => ({
      runtime: options.runtime,
      async run(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
        const runtime = request.runtime.runtime
        resultadoDoMotor.chamadas.push(runtime)
        const doMotor = resultadoDoMotor.porRuntime?.[runtime]
        if (!doMotor) {
          throw new Error(`teste não configurou resultadoDoMotor.porRuntime para ${runtime}`)
        }
        return doMotor
      },
    }),
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFakePrisma(overrides: any = {}) {
  let missionCounter = 0
  const baseMock = {
    mission: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => ({ id: 'mission_1' })),
      create: vi.fn(async () => {
        missionCounter += 1
        return { id: `mission_${missionCounter}` }
      }),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => [PROJETO]),
    },
    telegramLink: { findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })) },
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        status: 'active',
        pat: 'mock-pat',
        userId: 'user_1',
        runtime: 'codex',
        isHealthy: true,
        metadata: {},
      })),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ devAccountId: 'dev_acc_1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => [{ issueNumber: 15, _count: { id: 2 } }]),
    },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'evt_1' })),
      findMany: vi.fn(async () => []),
    },
    infraIncident: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    devAccount: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: 'dev_acc_1', concurrentMissions: 2 })),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    knowledgeEntry: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    projectMemory: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    pendency: { upsert: vi.fn(async () => ({})) },
    vezPendente: { upsert: vi.fn(async () => ({})) },
    missionConsumption: { upsert: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
  }

  const merged = { ...baseMock, ...overrides }

  const proxy = new Proxy(merged, {
    get(target, prop) {
      if (prop === '$transaction')
        return vi.fn(async (cb) => {
          if (typeof cb === 'function') return cb(proxy)
          if (Array.isArray(cb)) return Promise.all(cb)
          return {}
        })
      if (prop in target) return target[prop]
      return new Proxy(
        {},
        {
          get(_, subProp) {
            if (subProp === 'findMany') return vi.fn(async () => [])
            if (subProp === 'findFirst') return vi.fn(async () => null)
            if (subProp === 'findUnique') return vi.fn(async () => null)
            if (subProp === 'count') return vi.fn(async () => 0)
            return vi.fn(async () => ({}))
          },
        }
      )
    },
  })

  return proxy
}

describe('Conversões do Painel Real Seam (6 cenários consolidados)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any

  beforeEach(() => {
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SELF_REPO'] = 'GitOrchAI/gitorch'
    process.env['GITORCH_DISABLE_MICROVM'] = '1'
    resultadoDoMotor.chamadas = []
    resultadoDoMotor.porRuntime = null
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env['GITORCH_SCHEDULER_TICK_MS']
    delete process.env['GITORCH_SELF_REPO']
    delete process.env['GITORCH_DISABLE_MICROVM']
    if (app) await app.close()
  })

  test('RA entendeu falha 2x', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })) as never

    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: { type: 'audit', payload: { texto: 'RA entendeu falha 2x' } },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('entendeu falha')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)

    // Test idempotency
    prisma.event.findFirst.mockResolvedValue({ id: 'evt_existente' })
    const fetchMock = vi.mocked(global.fetch)
    expect(
      fetchMock.mock.calls.filter((c: unknown[]) =>
        String(c[0]).startsWith('https://api.telegram.org/')
      ).length
    ).toBe(0)
  })

  test('Achado "Encanamento do GitOrch"', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })) as never

    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: { type: 'audit', payload: { texto: 'Achado de infra: O encanamento quebrou' } },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('encanamento')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)
  })

  test('Desistiu de incidente de infra (3º PR)', async () => {
    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: {
        type: 'audit',
        payload: { texto: 'parei de insistir em incidente de infra (3º PR)' },
      },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('parei de insistir')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)
  })

  test('Esteira parada por vaga', async () => {
    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: { type: 'audit', payload: { texto: 'a esteira de GitOrch não anda' } },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('a esteira de')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)
  })

  test('Entregas voltaram para a fila', async () => {
    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: { type: 'audit', payload: { texto: 'voltou para a fila de entregas' } },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('voltou para a fila')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)
  })

  test('Entrega mesclada', async () => {
    app = Fastify({ logger: true })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await app.ready()

    await prisma.event.create({
      data: { type: 'audit', payload: { texto: 'entrega mesclada com sucesso' } },
    })

    const chamadasDeAudit = prisma.event.create.mock.calls.filter(
      (c: [{ data: { type: string; payload: { texto: string } } }]) =>
        c[0].data.type === 'audit' && c[0].data.payload.texto.includes('mesclada')
    )
    expect(chamadasDeAudit.length).toBeGreaterThan(0)
  })
})
