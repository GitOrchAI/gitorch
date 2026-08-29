import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

/**
 * D49, cenário (e): "tudo privado, numa VM minha".
 *
 * O defeito que este arquivo existe para impedir foi MEDIDO em produção: o
 * produto lendo `GET /repos/loureng/patinhas-3d-crafts/deployments?environment=copilot`
 * e levando 403 — 196 vezes em 24 horas na última contagem, quase mil na
 * primeira — porque tomou por produção um ambiente de outra ferramenta, que
 * ele não tem permissão de ler. Enquanto isso, as entregas mescladas ficavam
 * paradas esperando uma confirmação que nunca viria, e a publicação de verdade
 * acontecia numa VM do dono, onde o GitHub nunca ia olhar.
 *
 * Com o dono tendo declarado "publico em servidor meu", o produto não pode
 * mais bater no GitHub por causa desta entrega — não há nada lá para achar.
 * Ele espera o aviso de quem publica.
 *
 * Costura REAL: registra o `schedulerPlugin` de verdade e deixa o
 * `setInterval` de produção disparar o tique. Nada reimplementado.
 */

const PROJETO = {
  id: 'proj_vm',
  wingId: 'loureng/patinhas-3d-crafts',
  name: 'Patinhas',
  userId: 'user_1',
  // A declaração do dono, a mesma que a resposta no Telegram grava.
  runtimeConfig: { publicacao: { como: 'publica-em-vm-propria' } },
  isActive: true,
} as const

const ENTREGA_MESCLADA = {
  id: 'sess_vm',
  projectId: PROJETO.id,
  issueNumber: 5,
  sessionName: 'sessions/na-vm-do-dono',
  state: 'COMPLETED',
  answeredHash: null,
  pullRequestNumber: 7,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  // Mesclada agora há pouco: dentro da janela de acompanhamento, que é o
  // cenário desta prova. O caso do teto estourado tem prova própria abaixo.
  stateCheckedAt: new Date(),
  reworkNoticePending: null,
  reworkNoticeAttempts: 0,
  pendingSince: null,
  mergeCommitSha: '0e09b544',
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
} as const

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
      // A guarda de autonomia descobre o dono do repositório por aqui, na hora
      // de cada escrita REST. Sem esta linha o fake responde "não é projeto
      // nenhum" e a escrita é recusada — corretamente.
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) return [ENTREGA_MESCLADA]
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

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

describe('VM privada declarada: o produto para de bater no GitHub (D49)', () => {
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

  test('nenhuma leitura de publicação no GitHub — e a entrega segue viva, esperando o aviso', async () => {
    const rotasChamadas: string[] = []
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      rotasChamadas.push(String(url))
      return new Response('[]', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Prova positiva de que a varredura RODOU (várias vezes), e não de que o
    // tique simplesmente não chegou lá.
    await vi.waitFor(
      () => {
        expect(prisma._updateCalls.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 3000, interval: 10 }
    )

    // O que esta tarefa existe para matar: a leitura de deployments/workflows
    // do repositório, que no caso real voltava 403 a cada tique.
    expect(rotasChamadas.filter((u) => u.includes('/deployments'))).toHaveLength(0)
    expect(rotasChamadas.filter((u) => u.includes('/environments'))).toHaveLength(0)
    expect(rotasChamadas.filter((u) => u.includes('/actions/'))).toHaveLength(0)

    // E a entrega NÃO foi fechada nem declarada no ar: só teve a cadência
    // carimbada, esperando o aviso de quem publica.
    const dados = prisma._updateCalls.map((c) => c.data)
    // Nunca afirma veredito nenhum: não viu nada, então não diz nada.
    expect(dados.every((d) => d['deployState'] === undefined)).toBe(true)
    // Só a cadência, para não reexaminar a cada tique.
    expect(dados.every((d) => d['deployCheckedAt'] !== undefined)).toBe(true)
  })

  test('se o aviso nunca chega, a entrega encerra dizendo isso — nunca fica presa para sempre', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    // Mesclada há muito mais que o teto de acompanhamento: o aviso não veio.
    prisma.devSession.findMany = vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
      if (args?.where?.mergeCommitSha) {
        return [{ ...ENTREGA_MESCLADA, stateCheckedAt: new Date('2020-01-01T00:00:00Z') }]
      }
      return []
    }) as never

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(
          prisma._updateCalls.some((c) => (c.data as Record<string, unknown>)['closedAt'])
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Encerrou como "não confirmamos" — jamais como "está no ar".
    const vereditos = prisma._updateCalls
      .map((c) => (c.data as Record<string, unknown>)['deployState'])
      .filter(Boolean)
    expect(vereditos).toContain('sem-publicacao')
    expect(vereditos).not.toContain('no-ar')
  })

  test('o aviso que CHEGOU encerra a entrega — não fica viva até o teto dizendo que não chegou', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    // A rota de aviso já gravou o veredito nesta linha; falta encerrá-la.
    prisma.devSession.findMany = vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
      if (args?.where?.mergeCommitSha) {
        // `deployCheckedAt` fora da cadência de exame: é a próxima passagem
        // da varredura depois de a rota de aviso ter gravado o veredito.
        return [
          {
            ...ENTREGA_MESCLADA,
            deployState: 'no-ar',
            deployCheckedAt: new Date(Date.now() - 20 * 60_000),
          },
        ]
      }
      return []
    }) as never

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(
          prisma._updateCalls.some((c) => (c.data as Record<string, unknown>)['closedAt'])
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Fechou como NO AR, e nunca como "não confirmamos".
    const vereditos = prisma._updateCalls
      .map((c) => (c.data as Record<string, unknown>)['deployState'])
      .filter(Boolean)
    expect(vereditos).toContain('no-ar')
    expect(vereditos).not.toContain('sem-publicacao')
  })
})
