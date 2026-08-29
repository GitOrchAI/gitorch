import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS } from '../services/publicacao.js'

// Item 1 da revisão pós-Leva A ("o teto que criamos cobre UM estado; os
// vizinhos continuam sem saída"): a Leva A deu um teto a `commit-errado`
// (uma hora) — mas achou, na revisão seguinte, TRÊS vizinhos que continuam
// SEM SAÍDA: `falhou` sem teto (um CD que falha e ninguém roda de novo);
// `publicando` sem teto quando a publicação está represada esperando
// aprovação humana (estado real do GitHub, nunca "zero evidência" — a
// janela de tolerância nunca se aplicava); e uma leitura ao GitHub que
// falha PARA SEMPRE (instalação revogada, 403 permanente).
//
// Este arquivo prova, pelo "real seam" de sempre, que os TRÊS agora têm
// saída: `TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS`, medido desde a mescla,
// fecha a sessão mesmo quando nenhum teto ESPECÍFICO se aplicava ao estado
// em que ela ficou presa.
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
      // A guarda de autonomia descobre o dono do repositório por aqui, na hora
      // de cada escrita REST. Sem esta linha o fake responde "não é projeto
      // nenhum" e a escrita é recusada — corretamente.
      findFirst: vi.fn(async () => PROJETO),
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

// Bem além do teto absoluto (24h) — a prova não pode depender de ficar
// exatamente na borda.
const DESDE_A_MESCLA_ALEM_DO_TETO = TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS + 60 * 60_000

function sessaoBase(over: Record<string, unknown> = {}) {
  return {
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
    stateCheckedAt: new Date(Date.now() - DESDE_A_MESCLA_ALEM_DO_TETO),
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

describe('teto absoluto (Item 1) — nenhum estado sobrevive a TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS', () => {
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

  test('estado 1 — "falhou" sem teto próprio: o teto absoluto fecha a sessão e avisa o dono', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response(JSON.stringify({ environments: [] }), { status: 200 })
        }
        if (u.endsWith('/repos/acme/api/actions/workflows')) {
          return new Response(
            JSON.stringify({
              workflows: [{ name: 'CD', path: '.github/workflows/cd.yml', state: 'active' }],
            }),
            { status: 200 }
          )
        }
        if (u.includes('/repos/acme/api/actions/workflows/cd.yml/runs')) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 99,
                  name: 'CD',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'failure',
                  head_branch: 'main',
                  head_sha: 'deadbeef',
                  run_started_at: '2026-08-16T10:00:00Z',
                },
              ],
            }),
            { status: 200 }
          )
        }
        if (u.endsWith('/repos/acme/api/actions/runs/99/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [{ name: 'Deploy backend prod', status: 'completed', conclusion: 'failure' }],
            }),
            { status: 200 }
          )
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response('{"ok":true}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessaoBase())
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // O veredito FINAL é `sem-publicacao` — o backstop nunca inventa um
    // sexto estado (ver `fecharPorTetoAbsoluto`).
    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'sem-publicacao' })

    // O dono é avisado, com a ÚLTIMA observação (o "falhou" que ficou
    // preso) — não em silêncio.
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram.length).toBeGreaterThanOrEqual(1)
    const corpoDoAviso = String(
      (chamadasDeTelegram[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    )
    expect(corpoDoAviso).toMatch(/falhou/)
  })

  test('estado 2 — "publicando" represado esperando aprovação humana (deployment "waiting", NUNCA "zero evidência"): o teto absoluto fecha mesmo assim', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response(JSON.stringify({ environments: [{ name: 'production' }] }), {
            status: 200,
          })
        }
        if (u.includes('/repos/acme/api/deployments?')) {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                environment: 'production',
                sha: 'deadbeef',
                production_environment: true,
                transient_environment: false,
              },
            ]),
            { status: 200 }
          )
        }
        if (u.match(/\/repos\/acme\/api\/deployments\/\d+\/statuses/)) {
          // "waiting" é EVIDÊNCIA real (a publicação existe, só está represada
          // esperando um aprovador humano) — nunca "zero evidência", por isso
          // a janela de tolerância nunca se aplicaria aqui. Só o teto absoluto
          // fecha esta sessão.
          return new Response(
            JSON.stringify([
              { state: 'waiting', environment_url: null, created_at: '2026-08-16T10:00:00Z' },
            ]),
            { status: 200 }
          )
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response('{"ok":true}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessaoBase({ sessionName: 'sessions/waiting' }))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

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

    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram.length).toBeGreaterThanOrEqual(1)
    const corpoDoAviso = String(
      (chamadasDeTelegram[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    )
    expect(corpoDoAviso).toMatch(/publicando/)
  })

  test('estado 3 — leitura ao GitHub que falha PARA SEMPRE (403 persistente): o teto absoluto fecha mesmo sem NUNCA ter conseguido um veredito', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        // `ghGet` lança quando a resposta não é `ok` — força o caminho do
        // `catch` por sessão em `varrerPublicacoes`, exatamente como uma
        // instalação revogada ou um projeto suspenso.
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response('{"message":"rate limited"}', { status: 403 })
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response('{"ok":true}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessaoBase({ sessionName: 'sessions/403' }))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

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

    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram.length).toBeGreaterThanOrEqual(1)
    const corpoDoAviso = String(
      (chamadasDeTelegram[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    )
    expect(corpoDoAviso).toMatch(/leitura do GitHub falhou/)
  })

  // Item 7 (leva B2): a invariante documentada em `scheduler.ts` diz que
  // `stateCheckedAt` NUNCA fica nulo numa linha que já tem `mergeCommitSha`
  // (os dois são gravados juntos por `registrarMescla`, o único escritor de
  // `mergeCommitSha`) — mas se essa invariante fosse quebrada por algum
  // motivo (edição manual do banco, uma migração futura que desacople os
  // campos), o código ANTES desta correção tratava "não sei há quanto
  // tempo" como "então nenhum teto dispara": a sessão ficava presa para
  // sempre, sem NUNCA fechar e sem avisar o dono, mesmo estando em `falhou`
  // — o estado que este arquivo inteiro existe para não deixar sem saída.
  test('Item 7 — stateCheckedAt ausente (dado impossível hoje, mas se acontecesse) FALHA PARA O LADO SEGURO: fecha por teto absoluto em vez de nunca fechar', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response(JSON.stringify({ environments: [] }), { status: 200 })
        }
        if (u.endsWith('/repos/acme/api/actions/workflows')) {
          return new Response(
            JSON.stringify({
              workflows: [{ name: 'CD', path: '.github/workflows/cd.yml', state: 'active' }],
            }),
            { status: 200 }
          )
        }
        if (u.includes('/repos/acme/api/actions/workflows/cd.yml/runs')) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 99,
                  name: 'CD',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'failure',
                  head_branch: 'main',
                  head_sha: 'deadbeef',
                  run_started_at: '2026-08-16T10:00:00Z',
                },
              ],
            }),
            { status: 200 }
          )
        }
        if (u.endsWith('/repos/acme/api/actions/runs/99/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [{ name: 'Deploy backend prod', status: 'completed', conclusion: 'failure' }],
            }),
            { status: 200 }
          )
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response('{"ok":true}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(
      sessaoBase({ sessionName: 'sessions/sem-instante-da-mescla', stateCheckedAt: null })
    )
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

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

    // O aviso ao dono não trava numa divisão por dado ausente ("NaN horas")
    // — a mensagem continua legível mesmo sem saber há quanto tempo foi.
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram.length).toBeGreaterThanOrEqual(1)
    const corpoDoAviso = String(
      (chamadasDeTelegram[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    )
    expect(corpoDoAviso).not.toMatch(/NaN/)
  })

  test('ANTES do teto absoluto: os três estados NÃO fecham sozinhos (comportamento de sempre preservado)', async () => {
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        if (u.endsWith('/repos/acme/api/environments')) {
          return new Response('{"message":"rate limited"}', { status: 403 })
        }
        return new Response('{}', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    // Bem DENTRO do teto absoluto — 1h desde a mescla, a mesma leitura que
    // falha (403) não pode fechar a sessão ainda.
    const prisma = buildFakePrisma(
      sessaoBase({
        sessionName: 'sessions/ainda-dentro',
        stateCheckedAt: new Date(Date.now() - 60 * 60_000),
      })
    )
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

    await new Promise((resolve) => setTimeout(resolve, 100))
    const fechou = prisma._updateCalls.some((c) => c.data['closedAt'] !== undefined)
    expect(fechou).toBe(false)
  })
})
