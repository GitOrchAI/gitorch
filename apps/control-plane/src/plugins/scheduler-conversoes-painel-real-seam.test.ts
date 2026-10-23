import Fastify from 'fastify'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '@gitorch/agents'

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
}

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
        if (!doMotor)
          throw new Error(`teste não configurou resultadoDoMotor.porRuntime para ${runtime}`)
        return doMotor
      },
    }),
  }
})

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>()
  const mockEnv = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/gitorch',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: '12345678901234567890123456789012',
    GITORCH_CREDENTIAL_KEY: '1234567890123456789012345678901234567890123456789012345678901234',
    NODE_ENV: 'test',
  }
  return {
    ...actual,
    loadEnv: () => mockEnv,
    getEnv: () => mockEnv,
    env: mockEnv,
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
      groupBy: vi.fn(async () => []),
    },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        return { id: 'evt_1' }
      }),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergedBase: any = { ...baseMock }
  for (const k of Object.keys(overrides)) {
    mergedBase[k] = { ...mergedBase[k], ...overrides[k] }
  }
  const modelProxies = new Map()
  mergedBase._modelProxies = modelProxies

  return new Proxy(mergedBase, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      if (prop === 'then') return undefined
      if (prop === '$transaction') return async (cb: (val: unknown) => unknown) => cb(target)

      if (!target._modelProxies.has(prop)) {
        const fakeModel = new Proxy(
          {},
          {
            get(_modelTarget: Record<string, unknown>, modelProp: string) {
              if (modelProp === 'then') return undefined

              if (!_modelTarget[modelProp]) {
                _modelTarget[modelProp] = vi.fn(async () => {
                  if (modelProp === 'findFirst' || modelProp === 'findUnique') return null
                  if (modelProp === 'findMany') return []
                  if (modelProp === 'count') return 0
                  return {}
                })
              }
              return _modelTarget[modelProp]
            },
          }
        )
        target._modelProxies.set(prop, fakeModel)
      }
      return target._modelProxies.get(prop)
    },
  })
}

describe('Conversões do Painel Real Seam (6 cenários consolidados)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any

  beforeEach(() => {
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '20'
    process.env['GITORCH_ANALISES_CADENCIA_MS'] = '1'
    process.env['GITORCH_SELF_REPO'] = 'GitOrchAI/gitorch'
    process.env['GITORCH_DISABLE_MICROVM'] = '1'
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['JULES_API_KEY'] = 'jules-key-de-teste'
    resultadoDoMotor.chamadas = []
    resultadoDoMotor.porRuntime = null
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (app) await app.close()
  })

  test('RA entendeu falha 2x', async () => {
    let callCount = 0
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 0,
        durationMs: 1,
        get output() {
          callCount++
          if (callCount === 1) {
            return JSON.stringify({
              acao: 'resolver',
              causaRaiz: 'O encanamento quebrou',
              comoConsertar: 'Consertar',
              diffSugerido: '',
            })
          }
          return JSON.stringify({
            titulo: 'Consertar o CI',
            corpoDaIssue: 'Encanamento quebrado',
            pedidoRevisado: null,
            causaComum: null,
          })
        },
        stderr: '',
      },
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/issues/55')) {
        return new Response('{"title":"Bug","body":"..."}', { status: 200 })
      }
      return new Response('{"ok":true}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      devSession: {
        findMany: vi.fn(async (args) => {
          if (
            args.where?.closedReason === 'dev-falhou' ||
            args.where?.closedReason?.in?.includes('dev-falhou') ||
            args.where?.issueNumber
          ) {
            return [
              {
                issueNumber: 55,
                closedAt: new Date(),
                analysisDoneAt: null,
                closedReason: 'dev-falhou',
                projectId: 'proj_1',
              },
              {
                issueNumber: 55,
                closedAt: new Date(Date.now() - 10000),
                analysisDoneAt: null,
                closedReason: 'dev-falhou',
                projectId: 'proj_1',
              },
            ]
          }
          return []
        }),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        groupBy: vi.fn(async (_args) => {
          return [{ _count: { _all: 2 }, issueNumber: 55 }]
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ devAccountId: 'dev_acc_1' })),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })

  test('Achado "Encanamento do GitOrch"', async () => {
    let callCount = 0
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 0,
        durationMs: 1,
        get output() {
          callCount++
          if (callCount === 1) {
            return JSON.stringify({
              acao: 'resolver',
              causaRaiz: 'O encanamento quebrou',
              comoConsertar: 'Consertar',
              diffSugerido: '',
            })
          }
          return JSON.stringify({
            titulo: 'Consertar o CI',
            corpoDaIssue: 'Encanamento quebrado',
            pedidoRevisado: null,
            causaComum: null,
          })
        },
        stderr: '',
      },
    }

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/actions/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 123,
                name: 'jules-pr-labeler',
                status: 'completed',
                conclusion: 'failure',
                created_at: new Date().toISOString(),
                path: '.github/workflows/jules-pr-labeler.yml',
              },
            ],
          }),
          { status: 200 }
        )
      }
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/actions/runs/123/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'build',
                status: 'completed',
                conclusion: 'failure',
                steps: [{ name: 'test', conclusion: 'failure' }],
              },
            ],
          }),
          { status: 200 }
        )
      }
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/actions/jobs/')) {
        return new Response('log text encanamento', { status: 200 })
      }
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/issues')) {
        if (init?.method === 'POST') {
          return new Response('{"number":123,"node_id":"abc"}', { status: 200 })
        }
      }
      return new Response('{"ok":true}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      infraIncident: {
        findMany: vi.fn(async () => [
          {
            id: 'inc_1',
            projectId: 'proj_1',
            classe: 'ci-do-cliente',
            identidadeEstavel: 'wf:123',
            issueNumber: 99,
            prNumber: 42,
            clearedAt: null,
            firstSeenAt: new Date(),
            prAttempts: 3,
            escalatedAt: null,
          },
        ]),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        upsert: vi.fn(async () => ({})),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })

  test('Desistiu de incidente de infra (3º PR)', async () => {
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 0,
        durationMs: 1,
        output: JSON.stringify({}),
        stderr: '',
      },
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.github.com/repos/GitOrchAI/gitorch/pulls/42')) {
        return new Response(JSON.stringify({ merged: false, merged_at: null, state: 'closed' }), {
          status: 200,
        })
      }
      return new Response('{"ok":true}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      infraIncident: {
        findMany: vi.fn(async () => [
          {
            id: 'inc_1',
            projectId: 'proj_1',
            classe: 'ci-do-cliente',
            identidadeEstavel: 'wf:123',
            issueNumber: 99,
            prNumber: 42,
            clearedAt: null,
            firstSeenAt: new Date(),
            prAttempts: 2,
            escalatedAt: null,
          },
        ]),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        upsert: vi.fn(async () => ({})),
      },
      devSession: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => ({ devAccountId: 'dev_acc_1' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        groupBy: vi.fn(async (_args) => {
          return [{ _count: { _all: 2 }, issueNumber: 55 }]
        }),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })

  test('Esteira parada por vaga', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.jules.ai/sessions')) {
        const sessoes = Array.from({ length: 15 }).map((_, i) => ({
          name: `sessions/fake_${i}`,
          createTime: new Date(Date.now() - 3600000).toISOString(),
        }))
        return new Response(JSON.stringify({ sessions: sessoes, nextPageToken: 'fake_token' }), {
          status: 200,
        })
      }
      return new Response('{"ok":true}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      project: {
        findFirst: vi.fn(async () => PROJETO),
        findUnique: vi.fn(async () => PROJETO),
        findMany: vi.fn(async () => [PROJETO, { ...PROJETO, id: 'proj_null' }]),
      },
      devSession: {
        findMany: vi.fn(async (args) => {
          if (args.where?.closedAt === null) {
            return [
              {
                sessionName: 'sess_1',
                issueNumber: 1,
                state: 'busy',
                lastProgressAt: new Date(Date.now() - 3600000),
                createdAt: new Date(Date.now() - 3600000),
                closedAt: null,
                answeredHash: null,
                requeueCount: 0,
                projectId: 'proj_1',
              },
              {
                sessionName: 'sess_2',
                issueNumber: 2,
                state: 'busy',
                lastProgressAt: new Date(Date.now() - 3600000),
                createdAt: new Date(Date.now() - 3600000),
                closedAt: null,
                answeredHash: null,
                requeueCount: 0,
                projectId: 'proj_1',
              },
              {
                sessionName: 'sess_3',
                issueNumber: 3,
                state: 'busy',
                lastProgressAt: new Date(Date.now() - 3600000),
                createdAt: new Date(Date.now() - 3600000),
                closedAt: null,
                answeredHash: null,
                requeueCount: 0,
                projectId: 'proj_1',
              },
              {
                sessionName: 'sess_4',
                issueNumber: 4,
                state: 'busy',
                lastProgressAt: new Date(Date.now() - 3600000),
                createdAt: new Date(Date.now() - 3600000),
                closedAt: null,
                answeredHash: null,
                requeueCount: 0,
                projectId: 'proj_1',
              },
            ]
          }
          return []
        }),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => ({
          devAccountId: 'dev_acc_1',
          encryptedDevApiKey: 'mock_key',
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        groupBy: vi.fn(async () => []),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })

  test('Entregas voltaram para a fila', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      devSession: {
        findMany: vi.fn(async (args) => {
          if (args.where?.state || args.where?.closedReason) {
            return [
              {
                sessionName: 'sess_1',
                issueNumber: 10,
                state: 'failed',
                closedReason: 'dev-falhou',
                projectId: 'proj_1',
                pullRequestNumber: null,
              },
            ]
          }
          return []
        }),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => ({ devAccountId: 'dev_acc_1' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        groupBy: vi.fn(async () => []),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })

  test('Entrega mesclada', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({
      devSession: {
        findMany: vi.fn(async (args) => {
          if (args.where?.status === 'merged' || args.where?.OR) {
            return [
              {
                sessionName: 'sess_1',
                issueNumber: 10,
                state: 'merged',
                closedReason: 'merged',
                projectId: 'proj_1',
                pullRequestNumber: 5,
                mergeCommitSha: 'abc1234',
              },
            ]
          }
          return []
        }),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => ({ devAccountId: 'dev_acc_1' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        groupBy: vi.fn(async () => []),
      },
    })
    app.decorate('prisma', prisma as never)
    app.decorate(
      'saveMissionMemory',
      vi.fn(async () => {})
    )
    await app.register((await import('./scheduler.js')).schedulerPlugin)
    await app.ready()

    await app.triggerAgentMission('po', 'proj_1', undefined, 'seguranca')

    await vi.waitFor(
      () => {
        const chamadasDeAudit = (
          prisma.event.create as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any[]) => c[0]?.data?.type === 'audit'
        )
        expect(chamadasDeAudit.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mensagensDeTelegram = (fetchMock as any).mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(mensagensDeTelegram.length).toBe(0)
  })
})
