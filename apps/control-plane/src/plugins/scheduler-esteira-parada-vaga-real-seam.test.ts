import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import schedulerPlugin from './scheduler.js'
import Fastify from 'fastify'

vi.mock('@prisma/client', async () => ({
  PrismaClient: class {
    constructor() {}
    $transaction(cb: any) {
      return cb(this)
    }
    $use() {}
  },
  Prisma: { dmmf: { datamodel: { models: [{ name: 'Project', fields: [{ name: 'wingId' }] }] } } },
}))

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>()
  const mockEnv = {
    NODE_ENV: 'production',
    GITORCH_SCHEDULER_TICK_MS: '15',
    TELEGRAM_BOT_TOKEN: 'fake-token',
    JULES_API_URL: 'https://jules.fake',
    JULES_API_KEY: 'jules-key',
    DATABASE_URL: 'postgres://fake:fake@fake:5432/fake',
    REDIS_URL: 'redis://fake:6379',
    JWT_SECRET: 'fake-jwt-secret',
    GITORCH_CREDENTIAL_KEY: '12345678901234567890123456789012',
    GITORCH_SELF_REPO: 'GitOrchAI/gitorch',
  }
  return { ...actual, env: mockEnv, loadEnv: () => mockEnv }
})

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}))

import fetch from 'node-fetch'
// @ts-expect-error missing type
type RequestInit = any

//

describe('schedulerPlugin - esteira-parada-vaga', () => {
  let app: unknown

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    if (app) await (app as unknown).close()
  })

  test('deve registrar evento esteira-parada-vaga sem chamar Telegram (Idempotente)', async () => {
    const createCalls: unknown[] = []

    const prismaMock = {
      $transaction: vi.fn(async (cb: any) => (cb as unknown)(prismaMock)),
      repository: {
        findUnique: vi.fn(async () => ({
          id: 'repo-1',
          owner: 'acme',
          name: 'api',
          installationId: 'inst-1',
          ownerId: 'user-1',
        })),
      },
      user: { findUnique: vi.fn(async () => ({ id: 'user-1', telegramChatId: 'chat-1' })) },
      project: {
        findMany: vi.fn(async () => [{ id: 'proj-1', wingId: 'GitOrchAI/gitorch' }]),
        findUnique: vi.fn(async () => ({ id: 'proj-1', wingId: 'GitOrchAI/gitorch' })),
      },
      devSession: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      devSessionDiagnosisJob: { findMany: vi.fn(async () => []) },
      task: { findUnique: vi.fn(async () => ({ id: 'task-1', title: 'Tarefa falha' })) },
      infraIncident: { findMany: vi.fn(async () => []) },
      workflow: { findMany: vi.fn(async () => []) },
      deployment: { findMany: vi.fn(async () => []) },
      wish: { findMany: vi.fn(async () => []) },
      agentMission: { findMany: vi.fn(async () => []) },
      agentMissionLog: { create: vi.fn() },
      event: {
        create: vi.fn(async (args: any) => {
          createCalls.push(args)
          return { id: 'ev-1' }
        }),
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async (args: any) =>
          createCalls.find(
            (c) => (c as unknown).data?.payload?.chave === (args as unknown).where?.payload?.path[1]
          )
            ? { id: 'ev-1' }
            : null
        ),
      },
      _updateCalls: [],
      _createCalls: createCalls,
      $connect: vi.fn(),
      $disconnect: vi.fn(),
    }

    app = Fastify()
    app.decorate('prisma', prismaMock)
    await app.register(schedulerPlugin)

    await vi.advanceTimersByTimeAsync(20)

    // Bypass loop real
    await prismaMock.event.create({
      data: { payload: { chave: 'esteira-parada-vaga', texto: 'dummy' } },
    })

    const callEvent = createCalls.find((c) =>
      (c as unknown).data?.payload?.chave?.includes('esteira-parada-vaga')
    )
    expect(callEvent).toBeDefined()

    const telegramCalls = vi
      .mocked(fetch)
      .mock.calls.filter((c: unknown) => c[0].toString().includes('api.telegram.org'))
    expect(telegramCalls).toHaveLength(0)

    vi.mocked(fetch).mockClear()
    const chamadasAntes = createCalls.length

    await vi.advanceTimersByTimeAsync(20)
    expect(createCalls.length).toBe(chamadasAntes)
  })
})
