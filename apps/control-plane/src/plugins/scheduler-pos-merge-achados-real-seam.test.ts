import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Revisão da Tarefa 17 (achados 1, 2 e 3) — mesmo "real seam" de
// `scheduler-pos-merge-real-seam.test.ts`: registra o `schedulerPlugin` de
// VERDADE (nada de `tick`/`varrerPublicacoes` reimplementado) e deixa o
// próprio `setInterval` de produção disparar o tique. Este arquivo cobre os
// dois cenários que o arquivo original não cobria:
//
// - Achado 1: no caminho de DEPLOYMENT, quando o CD ainda não criou o
//   objeto de publicação para o commit mesclado (zero evidência em todos os
//   ambientes), a PRIMEIRA leitura NÃO pode fechar a sessão como
//   `sem-publicacao` — precisa ficar "publicando" (não-final) enquanto a
//   janela de tolerância não se esgota.
// - Achado 2: `falhou`/`commit-errado` não fecham a sessão (o CD pode ser
//   retentado), e são reexaminados a cada cadência para sempre — sem
//   dedupe, o dono seria avisado a cada reexame. O dedupe é por transição de
//   `deployState` (o estado gravado pela varredura ANTERIOR, já na linha
//   antes deste tique rodar).
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

// Precisa ser um dublê COM ESTADO (não uma linha fixa devolvida sempre
// igual): o intervalo do teste (15ms) deixa VÁRIOS tiques reais disparar
// dentro da janela em que o teste espera — como qualquer teste real desta
// suíte, e como o banco de verdade faria. Sem isto, o achado 2 (dedupe por
// transição de `deployState`) não tem como ser provado pelo seam real: cada
// tique veria sempre a mesma leitura "nunca examinada", nunca a leitura que
// a varredura ANTERIOR gravou.
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
          // Mesmo filtro que a consulta real aplica (`closedAt: null`) —
          // uma vez fechada, some da varredura, como no banco de verdade.
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

describe('achados da revisão da Tarefa 17 — pelo seam real', () => {
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

  test('achado 1 — primeira leitura sem evidência (deployment): NÃO fecha, fica "publicando"', async () => {
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
      // Importante 5 da revisão final: dado real de produção — o merge
      // acabou de acontecer, e é `stateCheckedAt` (gravado por
      // `registrarMescla` no instante do merge) que agora mede "desde
      // quando" para a janela de tolerância, não mais um relógio em memória.
      stateCheckedAt: new Date(),
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
      // Zero evidência: o CD ainda não criou nenhum objeto de deployment
      // para o commit mesclado neste ambiente.
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

    // Espera o veredito ser gravado (prova que a varredura rodou de
    // verdade), não que a sessão fechou.
    await vi.waitFor(
      () => {
        const gravou = prisma._updateCalls.some((c) => c.data['deployState'] !== undefined)
        expect(gravou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Um pouco de folga para qualquer segundo tique (o intervalo é de 15ms)
    // não ter fechado a sessão por engano.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'publicando' })

    // O CRITÉRIO do achado 1: nenhuma chamada fechou a sessão. Sem a
    // janela de tolerância, esta mesma leitura (zero evidência) fecharia
    // como `sem-publicacao` na hora — exatamente o bug que a revisão
    // apontou.
    const fechou = prisma._updateCalls.some((c) => c.data['closedAt'] !== undefined)
    expect(fechou).toBe(false)

    // E, coerentemente, nenhum aviso foi disparado — a sessão não chegou a
    // veredito nenhum ainda, avisar agora seria alarme falso.
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram).toHaveLength(0)
  })

  function fixturePublicacaoQueFalhou(estadoAnteriorDeployState: string | null) {
    return {
      id: 'sess_2',
      projectId: 'proj_1',
      issueNumber: 6,
      sessionName: 'sessions/xyz',
      state: 'COMPLETED',
      answeredHash: null,
      pullRequestNumber: 8,
      attempts: 1,
      nudges: 0,
      lastProgressAt: null,
      stateCheckedAt: null,
      pendingSince: null,
      mergeCommitSha: 'deadbeef',
      // O estado gravado pela varredura ANTERIOR — é o que decide o dedupe
      // do achado 2. `deployCheckedAt: null` mantém a sessão elegível para
      // este tique independente da cadência de dez minutos (o teste não
      // espera tempo real nenhum).
      deployState: estadoAnteriorDeployState,
      deployCheckedAt: null,
      mergeFailures: 0,
      mergeLastFailedAt: null,
      closedAt: null,
    }
  }

  function fetchMockPublicacaoQueFalhou() {
    return vi.fn(async (url: Parameters<typeof fetch>[0]) => {
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
    })
  }

  test('achado 2 — primeira vez que a publicação falha: avisa o dono', async () => {
    const fetchMock = fetchMockPublicacaoQueFalhou()
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(fixturePublicacaoQueFalhou(null))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const chamadas = fetchMock.mock.calls.filter((c) =>
          String(c[0]).startsWith('https://api.telegram.org/')
        )
        expect(chamadas.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000, interval: 10 }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram).toHaveLength(1)
  })

  test('achado 2 — segunda leitura com o MESMO veredito (falhou de novo): não reavisa (SPAM apaga sinal)', async () => {
    const fetchMock = fetchMockPublicacaoQueFalhou()
    global.fetch = fetchMock as unknown as typeof fetch

    // A linha já chega com `deployState: 'falhou'` — simula que a
    // varredura ANTERIOR já registrou e já avisou esta mesma falha.
    const prisma = buildFakePrisma(fixturePublicacaoQueFalhou('falhou'))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Espera a varredura rodar de verdade (grava o estado de novo — a
    // reexaminação em si não para).
    await vi.waitFor(
      () => {
        const gravou = prisma._updateCalls.some((c) => c.data['deployState'] === 'falhou')
        expect(gravou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Folga para um segundo tique não reavisar por engano.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram).toHaveLength(0)
  })

  test('achado 2 — mudança real de situação (estava commit-errado, agora falhou): REARMA o aviso', async () => {
    const fetchMock = fetchMockPublicacaoQueFalhou()
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(fixturePublicacaoQueFalhou('commit-errado'))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const chamadas = fetchMock.mock.calls.filter((c) =>
          String(c[0]).startsWith('https://api.telegram.org/')
        )
        expect(chamadas.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000, interval: 10 }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram).toHaveLength(1)
  })
})
