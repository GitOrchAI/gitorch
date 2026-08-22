import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Importante 4 (leva C) — "a resolução do quadro desiste em silêncio".
//
// `resolverEntregaDoBoard` (scheduler.ts) tem duas saídas antecipadas: sem
// `pullRequestNumber` na linha, e sem `githubToken`. A segunda sempre avisou
// (`app.log.warn`); a primeira saía com um `return` mudo. Sessões mescladas
// ANTES desta parte do produto existir (achadas pelo recuo pela issue de
// origem) podem ter `pullRequestNumber` nulo — tarefa e card ficam
// intocados, sem NENHUM rastro de que isso aconteceu ou por quê.
//
// Este arquivo prova, pelo "real seam" de sempre, que o ramo agora avisa —
// e que ele SAI antes de tentar qualquer escrita no GitHub (comentário,
// fechamento, card).
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'acme/9' } },
  isActive: true,
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

function buildFakePrisma(sessaoInicial: Record<string, unknown>) {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let sessaoAtual: Record<string, unknown> = { ...sessaoInicial }
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
        if (args?.where?.mergeCommitSha) {
          return sessaoAtual['closedAt'] === null ? [sessaoAtual] : []
        }
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        sessaoAtual = { ...sessaoAtual, ...args.data }
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

// `pullRequestNumber: null` — o cenário de uma sessão mesclada ANTES de
// `registrarMescla` também gravar o número do PR (achada pelo recuo pela
// issue de origem, Importante 4 da revisão da branch anterior).
function sessaoSemPr(over: Record<string, unknown> = {}) {
  return {
    id: 'sess_1',
    projectId: 'proj_1',
    issueNumber: 5,
    sessionName: 'sessions/abc',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: new Date(),
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: 'deadbeef',
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    closedAt: null,
    ...over,
  }
}

describe('resolverEntregaDoBoard sem pullRequestNumber (Importante 4) — não sai mais em silêncio', () => {
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
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
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

  test('sem número do PR: loga um aviso nomeando a sessão, e nunca tenta comentar/fechar a issue nem mover o card', async () => {
    // Repositório sem mecanismo de publicação — "sem-publicacao" na
    // primeira leitura, sem esperar janela nenhuma, e `entregue: true`
    // (merge já é a entrega): o caminho mais curto até
    // `resolverEntregaDoBoard` ser chamado.
    const escritasNoGithub: string[] = []
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response(JSON.stringify({ environments: [] }), { status: 200 })
        }
        if (u.endsWith('/repos/acme/api/actions/workflows')) {
          return new Response(JSON.stringify({ workflows: [] }), { status: 200 })
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response('{"ok":true}', { status: 200 })
        }
        // QUALQUER escrita no GitHub (comentar, fechar, GraphQL do board)
        // não deveria acontecer — `resolverEntregaDoBoard` sai antes disso.
        if (method !== 'GET') escritasNoGithub.push(`${method} ${u}`)
        if (u.endsWith('/graphql')) escritasNoGithub.push(`GRAPHQL ${u}`)
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessaoSemPr())
    app = Fastify({ logger: { level: 'silent' } })
    const warnSpy = vi.spyOn(app.log, 'warn')
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // A sessão fecha normalmente (o veredito de publicação não depende do
    // PR) — só a parte de tarefa/card do board é que fica de fora.
    await vi.waitFor(
      () => {
        const fechouSessao = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechouSessao).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    // SEM a correção, este ramo saía com um `return` mudo — nenhum
    // `app.log.warn` citando a sessão.
    const avisou = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('sem número do PR na sessão sessions/abc')
    )
    expect(avisou).toBe(true)

    // E nenhuma escrita no GitHub foi tentada — a saída acontece ANTES de
    // qualquer coisa que precisasse do número do PR.
    expect(escritasNoGithub).toHaveLength(0)
  })
})
