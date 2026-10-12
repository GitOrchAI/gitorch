import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'

// As duas etapas do tique que repetiam a mesma leitura ao GitHub a cada passada
// mesmo depois do primeiro 403 de limite de taxa: a conferência das tarefas
// entregues (`GET /issues/N`) e a varredura da árvore dos planos
// (`GET /issues?labels=...`). Com o freio de cota, a primeira resposta que
// prova limite de taxa para as chamadas daquele dono até o reset, e a etapa
// diz isso numa linha de log em vez de insistir.

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
} as const

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_SCHEDULER_TICK_RAPIDO_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

const HA_UMA_HORA = new Date(Date.now() - 60 * 60_000)

function buildFakePrisma() {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      // A árvore dos planos lista com `accessSuspendedAt: null`; as demais
      // etapas não precisam de projeto nenhum neste teste.
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        args?.where && 'accessSuspendedAt' in args.where
          ? [{ id: PROJETO.id, wingId: PROJETO.wingId }]
          : []
      ),
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      // Só a varredura de tarefas entregues pergunta por `OR: [mergeCommitSha...]`.
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        args?.where && 'OR' in args.where
          ? [7, 8].map((issueNumber) => ({
              issueNumber,
              pullRequestNumber: 100 + issueNumber,
              mergeCommitSha: 'abcdef1234567890',
              closedReason: 'merged',
              projectId: PROJETO.id,
              updatedAt: HA_UMA_HORA,
            }))
          : []
      ),
      update: vi.fn(async () => undefined),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
  }
}

function respostaDeLimiteDeTaxa(): Response {
  return new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
    },
  })
}

describe('freio de cota nas etapas do tique (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    limparFreiosDeCota()
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '20'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    global.fetch = originalFetch
    limparFreiosDeCota()
    vi.restoreAllMocks()
  })

  function urlsChamadas(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map((c) => String(c[0]))
  }

  test('conferência de tarefas entregues: após o 403 de cota não repete GET /issues/N e avisa em log', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/issues/')) return respostaDeLimiteDeTaxa()
      return new Response('[]', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: { level: 'silent' } })
    const infoSpy = vi.spyOn(app.log, 'info')
    app.decorate('prisma', buildFakePrisma() as never)
    await app.register(schedulerPlugin)

    const linhasDoFreio = () =>
      infoSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('varrerTarefasEntregues') && m.includes('freio de cota'))

    // Espera passar de uma passada do tique: com o freio, a segunda passada em
    // diante deve pular e deixar a linha de log.
    await vi.waitFor(() => expect(linhasDoFreio().length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
      interval: 10,
    })

    const leituras = urlsChamadas(fetchMock).filter((u) =>
      /\/repos\/acme\/api\/issues\/\d+$/.test(u)
    )
    // Uma única leitura (a que tomou o 403); a tarefa #8 nem foi tentada.
    expect(leituras).toEqual(['https://api.github.com/repos/acme/api/issues/7'])
  })

  test('árvore dos planos: após o 403 de cota não repete a lista de issues do PO e avisa em log', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/issues?state=open&labels=')) return respostaDeLimiteDeTaxa()
      return new Response('[]', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: { level: 'silent' } })
    const infoSpy = vi.spyOn(app.log, 'info')
    app.decorate('prisma', buildFakePrisma() as never)
    await app.register(schedulerPlugin)

    const linhasDoFreio = () =>
      infoSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('varrerArvoreDosPlanos') && m.includes('freio de cota'))

    await vi.waitFor(() => expect(linhasDoFreio().length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
      interval: 10,
    })

    const listas = urlsChamadas(fetchMock).filter((u) => u.includes('/issues?state=open&labels='))
    expect(listas).toHaveLength(1)
  })

  test('403 de permissão (cota sobrando) NÃO freia: as outras tarefas continuam sendo lidas, e a que falhou não é relida', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/issues/')) {
        return new Response('{"message":"Resource not accessible"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '4000' },
        })
      }
      return new Response('[]', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: { level: 'silent' } })
    const infoSpy = vi.spyOn(app.log, 'info')
    app.decorate('prisma', buildFakePrisma() as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const leituras = urlsChamadas(fetchMock).filter((u) =>
          /\/repos\/acme\/api\/issues\/\d+$/.test(u)
        )
        // Sem freio de cota, a falha de uma tarefa não impede a leitura da outra.
        expect(leituras).toEqual([
          'https://api.github.com/repos/acme/api/issues/7',
          'https://api.github.com/repos/acme/api/issues/8',
        ])
      },
      { timeout: 5000, interval: 10 }
    )
    // E a tarefa que falhou descansa: passadas seguintes não repetem a leitura.
    await new Promise((r) => setTimeout(r, 300))
    const leiturasDepois = urlsChamadas(fetchMock).filter((u) =>
      /\/repos\/acme\/api\/issues\/\d+$/.test(u)
    )
    expect(leiturasDepois).toHaveLength(2)
    const avisosDeFreio = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('freio de cota'))
    expect(avisosDeFreio).toEqual([])
  })
})
