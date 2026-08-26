import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { encryptCredential } from '../lib/credential-crypto.js'
import { identidadeDaConta } from '../services/credencial-do-dev-do-cliente.js'

/**
 * BYOK (D34) no ponto REAL de wiring: a vigília tem que falar com a conta em
 * que a sessão NASCEU, não com a conta do dono da instância.
 *
 * O defeito que este arquivo existe para impedir é caro e silencioso: a sessão
 * é criada com a chave do cliente, e todo o acompanhamento seguinte (consultar
 * estado, aprovar plano, pedir retomada, mandar retrabalho, arquivar) sai com a
 * chave do dono. O fornecedor devolve 404 em tudo — e como esses caminhos
 * degradam para `null` de propósito, nada estoura: a vigília simplesmente passa
 * a ler "sem avanço" numa sessão que está progredindo, e a trata como
 * abandonada. A vaga real na conta que o cliente paga nunca é devolvida.
 *
 * Mesma costura real dos outros arquivos `*-real-seam`: registra o
 * `schedulerPlugin` de VERDADE e deixa o `setInterval` de produção disparar o
 * tique. Nada de vigília reimplementada.
 */

const CHAVE_DO_CLIENTE = 'chave-da-conta-do-cliente'
const CHAVE_DO_DONO = 'chave-da-conta-do-dono'
const CONTA_DO_CLIENTE = identidadeDaConta(CHAVE_DO_CLIENTE)

const PROJETO = {
  id: 'proj_byok',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: null,
  runtimeConfig: null,
  isActive: true,
  devAccountId: CONTA_DO_CLIENTE,
  encryptedDevApiKey: encryptCredential(CHAVE_DO_CLIENTE),
} as const

const JULES_API = 'https://jules.googleapis.com/v1alpha'

const SESSAO_DO_CLIENTE = {
  id: 'sess_byok',
  projectId: PROJETO.id,
  issueNumber: 21,
  sessionName: 'sessions/do-cliente-21',
  state: 'IN_PROGRESS',
  answeredHash: null,
  pullRequestNumber: null,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  stateCheckedAt: null,
  reworkNoticePending: null,
  reworkNoticeAttempts: 0,
  pendingSince: null,
  mergeCommitSha: null,
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
  // O carimbo que muda tudo: esta sessão nasceu na conta do CLIENTE.
  devAccountId: CONTA_DO_CLIENTE,
} as const

function buildFakePrisma(sessoes: unknown[]) {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 99),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findFirst: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(
        async (args: { where?: { mergeCommitSha?: unknown }; distinct?: unknown }) => {
          if (args?.where?.mergeCommitSha) return []
          if (args?.distinct) return [{ projectId: PROJETO.id }]
          return sessoes
        }
      ),
      findUnique: vi.fn(async () => ({ devAccountId: CONTA_DO_CLIENTE })),
      update: vi.fn(async () => undefined),
    },
  }
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'JULES_API_KEY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

describe('BYOK: a vigília fala com a conta em que a sessão nasceu (real seam)', () => {
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
    // A conta do DONO está configurada e funcionando — é justamente por isso
    // que o teste tem valor: se o produto usar a chave errada, ele usa ESTA.
    process.env['JULES_API_KEY'] = CHAVE_DO_DONO
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

  test('a consulta de estado sai com a chave DO CLIENTE, nunca com a do dono', async () => {
    const chavesUsadas: string[] = []
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const chave = (init?.headers as Record<string, string> | undefined)?.['X-Goog-Api-Key']
      if (chave) chavesUsadas.push(chave)
      if (String(url) === `${JULES_API}/${SESSAO_DO_CLIENTE.sessionName}`) {
        return new Response(
          JSON.stringify({ state: 'IN_PROGRESS', outputs: [], updateTime: null }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma([SESSAO_DO_CLIENTE])
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(chavesUsadas.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    expect(chavesUsadas).toContain(CHAVE_DO_CLIENTE)
    // A prova que importa: a chave do dono NUNCA aparece numa sessão do cliente.
    expect(chavesUsadas).not.toContain(CHAVE_DO_DONO)
  })
})
