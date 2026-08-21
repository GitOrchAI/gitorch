import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Importante 3 da revisão final da branch — "uma falha persistente vira
// laço de 60 segundos": `deployCheckedAt` só era gravado no caminho de
// SUCESSO da varredura de publicação. Os dois caminhos de ERRO (sem
// credencial do GitHub; uma exceção no meio da leitura) pulavam o carimbo
// inteiramente — e `sessoesParaAcompanharPublicacao` (pos-merge.ts) trata
// carimbo nulo ou antigo como "vencido agora", então uma falha PERSISTENTE
// (projeto suspenso, instalação revogada, 403 do GitHub) virava reexame a
// cada tique do relógio (~1min, muito mais rápido que a cadência de dez
// minutos) — e sob limite de taxa do GitHub, o próprio laço alimentava o
// limite que o derrubou.
//
// Este arquivo prova, pelo "real seam" (mesmo padrão do resto desta família
// de testes), que os DOIS caminhos de erro agora carimbam `deployCheckedAt`
// mesmo sem conseguir um veredito — sem nunca gravar `deployState` junto
// (uma falha de leitura não é um veredito).
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
} as const

const SESSAO_MESCLADA = {
  id: 'sess_1',
  projectId: 'proj_1',
  issueNumber: 5,
  sessionName: 'sessions/abc',
  state: 'COMPLETED',
  answeredHash: null,
  pullRequestNumber: 7,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  stateCheckedAt: new Date(),
  pendingSince: null,
  mergeCommitSha: 'deadbeef',
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
} as const

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

function buildFakePrisma() {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) return [SESSAO_MESCLADA]
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

describe('varrerPublicacoes — Importante 3 (a cadência avança mesmo numa falha)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  test('sem credencial do GitHub (instalação revogada/projeto suspenso): carimba a cadência, não grava veredito', async () => {
    // De propósito: NENHUM token — nem GITORCH_GITHUB_TOKEN, nem
    // GITHUB_APP_ID/PRIVATE_KEY (já ausentes por padrão) — para
    // `mintInstallationToken` devolver `null` e o laço cair no ramo de
    // "sem credencial".
    const fetchMock = vi.fn(
      async (_url: Parameters<typeof fetch>[0]) => new Response('{}', { status: 200 })
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const carimbou = prisma._updateCalls.some((c) => c.data['deployCheckedAt'] !== undefined)
        expect(carimbou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    const chamada = prisma._updateCalls.find((c) => c.data['deployCheckedAt'] !== undefined)
    // A cadência avança, mas NENHUM veredito é gravado — não sabemos nada
    // ainda, só que a leitura falhou.
    expect(chamada?.data).not.toHaveProperty('deployState')
    expect(chamada?.where).toEqual({ sessionName: 'sessions/abc' })

    // Nenhuma chamada de rede real para o GitHub aconteceu — a falha é ANTES
    // de qualquer leitura, na credencial.
    const chamadasAoGithub = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/repos/acme/api')
    )
    expect(chamadasAoGithub).toHaveLength(0)
  })

  test('exceção no meio da leitura (403 do GitHub): carimba a cadência mesmo assim, não grava veredito', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      // `ghGet` lança quando a resposta não é `ok` — é isto que força o
      // caminho pelo `catch` por sessão em `varrerPublicacoes`.
      if (u.endsWith('/repos/acme/api/environments')) {
        return new Response('{"message":"rate limited"}', { status: 403 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const carimbou = prisma._updateCalls.some((c) => c.data['deployCheckedAt'] !== undefined)
        expect(carimbou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    const chamada = prisma._updateCalls.find((c) => c.data['deployCheckedAt'] !== undefined)
    expect(chamada?.data).not.toHaveProperty('deployState')
    expect(chamada?.where).toEqual({ sessionName: 'sessions/abc' })
  })
})
