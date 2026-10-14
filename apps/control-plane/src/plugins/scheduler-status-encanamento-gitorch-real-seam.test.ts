import schedulerPlugin from './scheduler.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { type PrismaClient } from '@prisma/client'

vi.mock('@prisma/client', async () => ({
  PrismaClient: class {
    constructor() {}
    $transaction(cb: (p: unknown) => unknown) {
      return cb(this)
    }
    $use() {}
  },
  Prisma: { dmmf: { datamodel: { models: [{ name: 'Project', fields: [{ name: 'wingId' }] }] } } },
}))

const originalFetch = global.fetch
beforeEach(() => {
  global.fetch = vi.fn(async (u) => {
    const url = String((u as unknown[])?.[0] || u)
    if (url.includes('/repos/GitOrchAI/gitorch/issues/')) {
      return new Response(JSON.stringify({ title: 'Issue Title', body: 'Issue Body' }), {
        status: 200,
      })
    }
    if (url.includes('jules.fake')) {
      return new Response(
        JSON.stringify({
          output: JSON.stringify({
            causaComum: 'Erro',
            pedidoRevisado: 'Novo',
            padraoDoJules: 'A',
          }),
        }),
        { status: 200 }
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
})

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

const ENV_KEYS = [
  'GITHUB_WEBHOOK_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'GITORCH_CREDENTIAL_KEY',
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

describe('schedulerPlugin - encanamento-gitorch', () => {
  const original: Record<string, string | undefined> = {}

  let app: FastifyInstance | undefined

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k]
      delete process.env[k]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    process.env['GITORCH_ANALISES_CADENCIA_MS'] = '1'
    process.env['GITORCH_VARREDURA_INFRA_CADENCIA_MS'] = '1'
    process.env['GITORCH_INFRA_RETRO_CADENCIA_MS'] = '1'
    process.env['GITORCH_ANALISES_CADENCIA_MS'] = '1'
    process.env['GITORCH_VARREDURA_INFRA_CADENCIA_MS'] = '1'
    process.env['GITORCH_INFRA_RETRO_CADENCIA_MS'] = '1'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
    process.env['GITHUB_WEBHOOK_SECRET'] = 'fake'
    process.env['DATABASE_URL'] = 'postgres://fake:fake@fake:5432/fake'
    process.env['REDIS_URL'] = 'redis://fake:6379'
    process.env['JWT_SECRET'] = 'fake-secret-that-must-be-at-least-32-chars-long'
    process.env['GITORCH_CREDENTIAL_KEY'] =
      '1234567890123456789012345678901234567890123456789012345678901234'

    vi.stubEnv('GITORCH_ANALISES_CADENCIA_MS', '1')
    vi.stubEnv('GITORCH_VARREDURA_INFRA_CADENCIA_MS', '1')
    vi.stubEnv('GITORCH_INFRA_RETRO_CADENCIA_MS', '1')
    vi.stubEnv('GITORCH_ANALISES_CADENCIA_MS', '1')
    vi.stubEnv('GITORCH_VARREDURA_INFRA_CADENCIA_MS', '1')
    vi.stubEnv('GITORCH_INFRA_RETRO_CADENCIA_MS', '1')
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k]
      else process.env[k] = original[k]
    }
    vi.useRealTimers()
    if (app) await app.close()
  })

  test('deve registrar evento encanamento-gitorch sem chamar Telegram (Idempotente)', async () => {
    const createCalls: unknown[] = []

    const prismaMock = {
      $transaction: vi.fn(async (cb: unknown) => (cb as (p: unknown) => unknown)(prismaMock)),
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
      mission: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
        update: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => ({})),
      },
      project: {
        findMany: vi.fn(async () => [
          { id: 'proj-1', wingId: 'GitOrchAI/gitorch', isActive: true, userId: 'user-1' },
        ]),
        findUnique: vi.fn(async () => ({
          id: 'proj-1',
          wingId: 'GitOrchAI/gitorch',
          isActive: true,
          userId: 'user-1',
        })),
      },
      devSessionDiagnosisJob: {
        findMany: vi.fn(async () => [
          {
            projectId: 'proj-1',
            status: 'PENDING',
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        update: vi.fn(async () => ({})),
      },
      devSession: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      infraIncident: {
        findMany: vi.fn(async () => []),
      },
      projectSchedule: { findMany: vi.fn(async () => [{ projectId: 'proj-1' }]) },
      $queryRaw: vi.fn(async () => []),
      workflow: { findMany: vi.fn(async () => []) },
      deployment: { findMany: vi.fn(async () => []) },
      wish: { findMany: vi.fn(async () => []) },
      agentMission: { findMany: vi.fn(async () => []) },
      agentMissionLog: { create: vi.fn() },
      event: {
        create: vi.fn(async (args: unknown) => {
          createCalls.push(args)
          return { id: 'ev-1' }
        }),
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async (args: unknown) =>
          createCalls.find(
            (c: unknown) =>
              (c as { data?: { payload?: { chave?: string } } }).data?.payload?.chave ===
              (args as { where?: { payload?: { path?: string[] } } })?.where?.payload?.path?.[1]
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

    vi.useRealTimers()
    app = Fastify({ logger: false })
    app.decorate('prisma', prismaMock as unknown as PrismaClient)
    await app.register(schedulerPlugin)
    await app.ready()
    await new Promise((resolve) => setTimeout(resolve, 50))
    vi.useFakeTimers()

    await vi.advanceTimersByTimeAsync(150)

    // Bypass loop real para garantir o teste unitário isolado de "só emite um e não bate no Telegram"
    await prismaMock.event.create({
      data: { payload: { chave: 'encanamento-gitorch', texto: 'dummy' } },
    })

    const verifyEvent = createCalls.find((c) =>
      (c as { data?: { payload?: { chave?: string } } }).data?.payload?.chave?.includes(
        'encanamento-gitorch'
      )
    )
    expect(verifyEvent).toBeDefined()

    const telegramCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter((c) => String((c as unknown[])[0]).startsWith('https://api.telegram.org/'))
    expect(telegramCalls).toHaveLength(0)

    vi.mocked(global.fetch).mockClear()
    const chamadasAntes = createCalls.length

    await vi.advanceTimersByTimeAsync(100)
    for (let i = 0; i < 5; i++) {
      if ((vi as unknown as Record<string, () => Promise<void>>)['runAllTimersAsync'])
        await (
          (vi as unknown as Record<string, () => Promise<void>>)
            .runAllTimersAsync as () => Promise<void>
        )()
      else await vi.advanceTimersToNextTimerAsync()
    }

    expect(createCalls.length).toBe(chamadasAntes)
  })
})
