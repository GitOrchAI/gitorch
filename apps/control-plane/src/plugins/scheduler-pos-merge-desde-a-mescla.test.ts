import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Importante 5 da revisão final da branch — "o relógio da carência vive na
// memória": antes desta correção, `varrerPublicacoes` contava "desde quando
// vemos zero evidência" num Map dentro do fechamento do plugin. Reiniciar o
// processo (e este produto se reimplanta) esvaziava o Map, e a janela de
// tolerância recomeçava do zero para TODA sessão mesclada, mesmo uma que já
// vinha esperando há muito tempo antes do restart — se os restarts vierem
// mais cedo que a janela, o veredito NUNCA chega a final.
//
// Este arquivo prova a correção pelo "real seam" (mesmo padrão de
// `scheduler-pos-merge-achados-real-seam.test.ts`): uma sessão cujo
// `stateCheckedAt` (gravado no instante do merge por `registrarMescla`) já
// está BEM além da janela de tolerância de 30 minutos — simulando uma
// entrega mesclada há tempos — é examinada por um plugin RECÉM-registrado
// (sem estado nenhum em memória, o equivalente exato de um processo que
// acabou de subir depois de um restart). Se o relógio ainda vivesse só em
// memória, a primeira observação deste processo veria "zero evidência,
// contando a partir de agora" e esperaria a janela inteira de novo. Com a
// correção, a PRIMEIRA leitura já enxerga os 40 minutos gravados na linha e
// finaliza na hora.
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

describe('varrerPublicacoes — Importante 5 (o relógio da carência sobrevive a reinício)', () => {
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

  test('sessão mesclada há 40min (bem além da janela de 30min), processo RECÉM-registrado: fecha JÁ NA PRIMEIRA leitura', async () => {
    const quarentaMinutosAtras = new Date(Date.now() - 40 * 60_000)
    const sessao = {
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
      // O merge aconteceu há 40 minutos — muito além dos 30min da janela de
      // tolerância. Um processo RECÉM-subido (este `app`, registrado pela
      // primeira vez neste teste) não tem NENHUM estado em memória sobre
      // esta sessão; só o que está na linha.
      stateCheckedAt: quarentaMinutosAtras,
      reworkNoticePending: null,
      reworkNoticeAttempts: 0,
      pendingSince: null,
      mergeCommitSha: 'deadbeef',
      deployState: null,
      deployCheckedAt: null,
      mergeFailures: 0,
      mergeLastFailedAt: null,
      closedAt: null,
    }

    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.endsWith('/repos/acme/api/environments')) {
        return new Response(JSON.stringify({ environments: [{ name: 'production' }] }), {
          status: 200,
        })
      }
      // Zero evidência: nenhum objeto de deployment para o commit mesclado.
      if (u.includes('/repos/acme/api/deployments?')) {
        return new Response('[]', { status: 200 })
      }
      if (u.startsWith('https://api.telegram.org/')) {
        return new Response('{"ok":true}', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessao)
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Se o relógio ainda vivesse em memória, a sessão jamais fecharia dentro
    // deste timeout (a janela de 30min recomeçaria do zero) — o `waitFor`
    // provaria a falta da correção por timeout, não por asserção.
    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'sem-publicacao' })
  })
})
