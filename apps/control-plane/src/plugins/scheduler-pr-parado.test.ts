import Fastify from 'fastify'
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// MOCK ES MODULES BEFORE IMPORTS
vi.mock('../services/github-json.js', () => ({
  ghJson: vi.fn().mockResolvedValue({ mergeable: true, html_url: 'url' }),
}))
vi.mock('../services/project-credential.js', () => ({
  lerCredencialQueAlcancaOProjeto: vi.fn().mockResolvedValue('token_valido'),
  lerCredencialDoProjeto: vi.fn().mockResolvedValue('token_valido'),
}))

function defaultParaMetodo(nome: string): unknown {
  if (/^find(Many)/.test(nome)) return async () => []
  if (/^(findFirst|findUnique)$/.test(nome)) return async () => null
  if (/^count$/.test(nome)) return async () => 0
  if (/^aggregate$/.test(nome)) return async () => ({ _sum: {}, _count: 0 })
  if (/^updateMany$/.test(nome)) return async () => ({ count: 0 })
  if (/^(update|upsert|create)$/.test(nome)) return async () => ({})
  return async () => undefined
}

function autoModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      return defaultParaMetodo(prop)
    },
  })
}

function buildFakePrisma(respostaDesejada: string) {
  const updateManyCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let processado = false
  const fakeEvent = autoModel({
    create: vi.fn(async () => ({})),
  })

  const prisma = new Proxy(
    {
      agentQuestion: autoModel({
        findMany: vi.fn(async () => {
          if (processado) return []
          return [
            {
              id: 'q1',
              status: 'answered',
              dedupKey: 'cuida-deste-pedido:owner/repo:42',
              answer: respostaDesejada,
              project: {
                id: 'p1',
                wingId: 'owner/repo',
                userId: 'u1',
                encryptedClientToken: 'token',
                autonomia: 'mesclar_e_liberar',
              },
            },
          ]
        }),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateManyCalls.push(args)
          if (args.data['status'] === 'processed') {
            processado = true
          }
          return { count: 1 }
        }),
      }),
      event: fakeEvent,
      vezPendente: autoModel({ findMany: vi.fn(async () => []) }),
      mission: autoModel({ findMany: vi.fn(async () => []) }),
      projectSchedule: autoModel({ findMany: vi.fn(async () => []) }),
      _updateManyCalls: updateManyCalls,
      _processado: () => processado,
    },
    {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof typeof target]
        return autoModel()
      },
    }
  )
  return prisma as unknown as Record<string, unknown> & {
    _updateManyCalls: unknown[]
    _processado: () => boolean
  }
}

const ENV_KEYS = ['NODE_ENV', 'GITORCH_SCHEDULER_TICK_MS', 'GITORCH_GITHUB_TOKEN']

describe('varrerRespostasPrParado real seam', () => {
  const original: Record<string, string | undefined> = {}
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token'

    // Real timers allowed scheduler-duvidas-escaladas-antes-do-fechamento-real-seam.test.ts to pass,
    // because GITORCH_SCHEDULER_TICK_MS is 15. The interval will tick within the vi.waitFor 3000ms limit!
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    vi.clearAllMocks()
    vi.resetModules()
  })

  test('processa resposta "pr-parado-fechar", altera status e chama endpoint do github', async () => {
    const prisma = buildFakePrisma('pr-parado-fechar')

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('cortex', {} as never)
    app.decorate('engineConnections', {} as never)
    app.log = {
      error: (e: Error) => {
        throw e
      },
      warn: console.warn,
      info: console.info,
    } as never

    // Evaluate the module locally after setting NODE_ENV to trigger interval creation
    const pluginModule = await import('./scheduler.js')
    await app.register(pluginModule.default)

    await vi.waitFor(
      () => {
        expect(
          (prisma as { _processado: () => boolean; _updateManyCalls: unknown[] })._processado()
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    expect(
      (prisma as { _processado: () => boolean; _updateManyCalls: unknown[] })._updateManyCalls
        .length
    ).toBeGreaterThan(0)
    const processedCall = (
      prisma as {
        _processado: () => boolean
        _updateManyCalls: { data: Record<string, unknown> }[]
      }
    )._updateManyCalls.find((c) => c.data['status'] === 'processed')
    expect(processedCall).toBeDefined()

    const githubJson = await import('../services/github-json.js')
    expect(githubJson.ghJson).toHaveBeenCalled()
    const patchCall = (githubJson.ghJson as import('vitest').Mock).mock.calls.find(
      (c: unknown[]) => c[2] === 'PATCH' && (c[3] as string).includes('pulls/42')
    )
    expect(patchCall).toBeDefined()
    expect(patchCall![4]).toMatchObject({ state: 'closed' })
  })

  test('processa resposta "pr-parado-mesclar", altera status e chama endpoint do github', async () => {
    const prisma = buildFakePrisma('pr-parado-mesclar')

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('cortex', {} as never)
    app.decorate('engineConnections', {} as never)
    app.log = {
      error: (e: Error) => {
        throw e
      },
      warn: console.warn,
      info: console.info,
    } as never
    const pluginModule = await import('./scheduler.js')
    await app.register(pluginModule.default)

    await vi.waitFor(
      () => {
        expect(
          (prisma as { _processado: () => boolean; _updateManyCalls: unknown[] })._processado()
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    const githubJson = await import('../services/github-json.js')
    expect(githubJson.ghJson).toHaveBeenCalled()
    const mergeCall = (githubJson.ghJson as import('vitest').Mock).mock.calls.find(
      (c: unknown[]) => c[2] === 'PUT' && (c[3] as string).includes('pulls/42/merge')
    )
    expect(mergeCall).toBeDefined()
  })

  test('processa resposta "pr-parado-pedir-ajuste", altera status e chama get no github para o QA assumir', async () => {
    const prisma = buildFakePrisma('pr-parado-pedir-ajuste')
    const agentQuestionServiceMock = {
      marcarAssumida: vi.fn().mockResolvedValue(undefined),
    }

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('cortex', {} as never)
    app.decorate('engineConnections', {} as never)
    app.log = {
      error: (e: Error) => {
        throw e
      },
      warn: console.warn,
      info: console.info,
    } as never
    app.decorate('agentQuestionService', agentQuestionServiceMock as never)
    const pluginModule = await import('./scheduler.js')
    await app.register(pluginModule.default)

    await vi.waitFor(
      () => {
        expect(
          (prisma as { _processado: () => boolean; _updateManyCalls: unknown[] })._processado()
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // No `marcarAssumida` call here, `pedirAjuste` calls `ghJson` to get the PR head ref to find the session.
    const githubJson = await import('../services/github-json.js')
    const getCall = (githubJson.ghJson as import('vitest').Mock).mock.calls.find(
      (c: unknown[]) => c[2] === 'GET' && (c[3] as string).includes('pulls/42')
    )
    expect(getCall).toBeDefined()
  })
})
