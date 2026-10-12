import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'

// A varredura de tarefa entregue, no seam REAL (tique -> varredura -> GitHub na
// rede mockada). O que está em jogo:
//
//  - o fechamento passa pela guarda de autonomia DO PROJETO: se o nível que a
//    guarda enxerga não deixa escrever, nenhuma escrita sai, mesmo que a
//    varredura tenha lido outro nível;
//  - `cuidar` fecha e depois registra; `sugerir` não escreve no GitHub e
//    pergunta ao dono; `so_olhar` só registra no painel;
//  - erro de banco ao ler o projeto não vira "projeto inativo" calado.

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

function buildFakePrisma(args: {
  /** O que a varredura lê ao abrir o projeto. */
  autonomiaDaVarredura: string
  /** O que a guarda de autonomia enxerga ao decidir a escrita. */
  autonomiaDaGuarda: string
  falharAoLerOProjeto?: boolean
}) {
  const eventos: Array<{ chave: string; texto: string }> = []
  const prisma = {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async (a?: { select?: Record<string, unknown> }) => {
        if (a?.select && 'autonomia' in a.select) {
          if (args.falharAoLerOProjeto) throw new Error('banco indisponível')
          return {
            wingId: 'acme/api',
            isActive: true,
            autonomia: args.autonomiaDaVarredura,
            userId: 'user_1',
          }
        }
        return null
      }),
      // A guarda descobre o nível pelo repositório.
      findMany: vi.fn(async (a?: { where?: Record<string, unknown> }) =>
        a?.where && 'wingId' in a.where ? [{ id: 'proj_1', autonomia: args.autonomiaDaGuarda }] : []
      ),
      findFirst: vi.fn(async () => null),
    },
    devSession: {
      findMany: vi.fn(async (a?: { where?: Record<string, unknown> }) =>
        a?.where && 'OR' in a.where
          ? [
              {
                issueNumber: 7,
                pullRequestNumber: 42,
                mergeCommitSha: 'abcdef1234567890',
                closedReason: 'merged',
                projectId: 'proj_1',
                updatedAt: HA_UMA_HORA,
                closedAt: HA_UMA_HORA,
              },
            ]
          : []
      ),
      update: vi.fn(async () => undefined),
    },
    repoItem: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: { data: { payload: { chave: string; texto: string } } }) => {
        eventos.push(a.data.payload)
        return {}
      }),
    },
    agentQuestion: { findFirst: vi.fn(async () => null) },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
  }
  return { prisma, eventos }
}

describe('varredura de tarefa entregue: autonomia e guarda (real seam)', () => {
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

  function githubFalso() {
    const chamadas: Array<{ metodo: string; url: string; corpo: string | null }> = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const metodo = init?.method ?? 'GET'
      chamadas.push({ metodo, url: u, corpo: typeof init?.body === 'string' ? init.body : null })
      if (metodo === 'GET' && /\/repos\/acme\/api\/issues\/7$/.test(u)) {
        return new Response(
          JSON.stringify({
            state: 'open',
            title: 'Registrar o comando',
            updated_at: '2026-08-20T10:00:00Z',
          }),
          { status: 200 }
        )
      }
      if (metodo === 'GET' && /\/issues\/7\/comments/.test(u)) {
        return new Response('[]', { status: 200 })
      }
      return new Response(metodo === 'GET' ? '[]' : '{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const escritasNaTarefa = () =>
      chamadas.filter((c) => c.metodo !== 'GET' && /\/issues\/7(\/comments)?$/.test(c.url))
    return { chamadas, escritasNaTarefa }
  }

  async function subir(prisma: unknown, asked?: ReturnType<typeof vi.fn>) {
    app = Fastify({ logger: { level: 'silent' } })
    const infoSpy = vi.spyOn(app.log, 'info')
    const warnSpy = vi.spyOn(app.log, 'warn')
    app.decorate('prisma', prisma as never)
    if (asked) app.decorate('agentQuestionService', { ask: asked } as never)
    await app.register(schedulerPlugin)
    const logs = (spy: typeof infoSpy | typeof warnSpy) =>
      spy.mock.calls.map((c) => String(typeof c[0] === 'string' ? c[0] : c[1]))
    return {
      infos: () => logs(infoSpy),
      avisos: () => logs(warnSpy),
    }
  }

  test('cuidar: fecha a tarefa e DEPOIS publica o registro seco, e anota no painel', async () => {
    const { prisma, eventos } = buildFakePrisma({
      autonomiaDaVarredura: 'cuidar',
      autonomiaDaGuarda: 'cuidar',
    })
    const gh = githubFalso()
    await subir(prisma)
    await vi.waitFor(() => expect(gh.escritasNaTarefa().length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
      interval: 10,
    })
    const [primeira, segunda] = gh.escritasNaTarefa()
    expect(primeira).toMatchObject({ metodo: 'PATCH' })
    expect(JSON.parse(primeira!.corpo ?? '{}')).toMatchObject({ state: 'closed' })
    expect(segunda).toMatchObject({ metodo: 'POST' })
    const comentario = (JSON.parse(segunda!.corpo ?? '{}') as { body: string }).body
    expect(comentario).toContain('Entregue pelo PR #42. Para desfazer: reabrir esta issue.')
    expect(comentario).not.toMatch(/mãos do produto|auto-merge|alguém clicando/)
    await vi.waitFor(() => expect(eventos.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
      interval: 10,
    })
    expect(eventos[0]!.texto).toContain('Entregue pelo PR #42. Para desfazer: reabrir esta issue.')
  })

  test('o fechamento passa pela guarda: se ela enxerga só-olhar, NENHUMA escrita sai', async () => {
    // A varredura leu "cuidar" ao abrir o projeto, mas a guarda de autonomia,
    // que decide na hora da chamada, enxerga "só olhar". Se o fechamento
    // escapasse da guarda (um `fetch` cru), o PATCH sairia.
    const { prisma } = buildFakePrisma({
      autonomiaDaVarredura: 'cuidar',
      autonomiaDaGuarda: 'so_olhar',
    })
    const gh = githubFalso()
    const logs = await subir(prisma)
    await vi.waitFor(
      () =>
        expect(
          logs.infos().filter((m) => m.includes('autonomia não permite')).length
        ).toBeGreaterThanOrEqual(2),
      { timeout: 5000, interval: 10 }
    )
    expect(gh.chamadas.some((c) => /\/issues\/7$/.test(c.url) && c.metodo === 'GET')).toBe(true)
    expect(gh.escritasNaTarefa()).toEqual([])
  })

  test('sugerir: não escreve no GitHub e pergunta ao dono uma vez, com a chave da suspeita', async () => {
    const { prisma } = buildFakePrisma({
      autonomiaDaVarredura: 'sugerir',
      autonomiaDaGuarda: 'sugerir',
    })
    const gh = githubFalso()
    const ask = vi.fn(async () => ({}))
    await subir(prisma, ask)
    await vi.waitFor(() => expect(ask).toHaveBeenCalled(), { timeout: 5000, interval: 10 })
    const [dono, projeto, pergunta] = ask.mock.calls[0] as unknown as [
      string,
      string,
      { text: string; dedupKey: string },
    ]
    expect(dono).toBe('user_1')
    expect(projeto).toBe('proj_1')
    expect(pergunta.dedupKey.startsWith('suspeita-resolvida:acme/api:7:')).toBe(true)
    expect(pergunta.text).toContain('PR #42')
    expect(gh.escritasNaTarefa()).toEqual([])
  })

  test('so_olhar: só registra no painel; nenhuma escrita, nenhuma pergunta', async () => {
    const { prisma, eventos } = buildFakePrisma({
      autonomiaDaVarredura: 'so_olhar',
      autonomiaDaGuarda: 'so_olhar',
    })
    const gh = githubFalso()
    const ask = vi.fn(async () => ({}))
    await subir(prisma, ask)
    await vi.waitFor(() => expect(eventos.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
      interval: 10,
    })
    expect(eventos[0]!.chave).toBe('tarefa-entregue-so-olhar:acme/api#7')
    expect(eventos[0]!.texto).toContain('só olhar')
    expect(gh.escritasNaTarefa()).toEqual([])
    expect(ask).not.toHaveBeenCalled()
  })

  test('erro de banco ao ler o projeto: registra e pula o projeto, sem tratar como inativo calado', async () => {
    const { prisma } = buildFakePrisma({
      autonomiaDaVarredura: 'cuidar',
      autonomiaDaGuarda: 'cuidar',
      falharAoLerOProjeto: true,
    })
    const gh = githubFalso()
    const logs = await subir(prisma)
    await vi.waitFor(
      () =>
        expect(
          logs.avisos().filter((m) => m.includes('não conseguiu ler o projeto')).length
        ).toBeGreaterThanOrEqual(1),
      { timeout: 5000, interval: 10 }
    )
    expect(gh.chamadas.some((c) => /\/issues\/7(\/|$)/.test(c.url))).toBe(false)
  })
})
