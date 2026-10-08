import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { schedulerPlugin } from './scheduler.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'

// A ligação PR → tarefa dentro da varredura do retrato, pelo caminho REAL do
// serviço: o plugin do scheduler montando `varrerRetratoDoProjeto` com o bloco
// `vincularTarefa`. `acharTarefaDoItem` existia e passava nos próprios testes,
// mas só um script avulso o chamava: no serviço o PR do dev assíncrono ficava
// sem tarefa na ficha. Este teste falha se o gancho voltar a sumir do objeto
// que o scheduler monta.

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
  encryptedClientToken: null,
  autonomiaDeSeguranca: 'so_olhar',
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

function buildFakePrisma(sessoes: unknown[]) {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      // A varredura do retrato é a única etapa que seleciona o token do cliente.
      findMany: vi.fn(async (args?: { select?: Record<string, unknown> }) =>
        args?.select && 'encryptedClientToken' in args.select ? [PROJETO] : []
      ),
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      findMany: vi.fn(async () => sessoes),
      update: vi.fn(async () => undefined),
    },
    // A ficha já tem o grafo de vínculos (`vinculos`), então o backfill não age.
    repoItem: {
      findFirst: vi.fn(async () => ({
        id: 'ri_1',
        origem: 'pessoa',
        issueNumber: null,
        vinculos: { id: 'v_1' },
      })),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    event: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
  }
}

describe('vínculo da tarefa na varredura do retrato (real seam)', () => {
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

  function githubFalso(prs: unknown[], fechaNaIssue: number[] = []) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endereco = String(url)
      if (endereco.endsWith('/graphql') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: { nodes: fechaNaIssue.map((number) => ({ number })) },
                },
              },
            },
          }),
          { status: 200 }
        )
      }
      if (endereco.includes('/repos/acme/api/pulls?state=open')) {
        return new Response(JSON.stringify(prs), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    })
  }

  const graphqlChamados = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/graphql')).length

  test('PR com linha de sessão: grava issue_number, vinculo_origem e corrige a origem, sem chamar o GraphQL', async () => {
    const fetchMock = githubFalso([
      {
        number: 4072,
        state: 'open',
        draft: false,
        user: { login: 'autor-humano' },
        head: { ref: 'x' },
      },
    ])
    global.fetch = fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma([
      { sessionName: 'sessions/7755004169003901831', issueNumber: 3842, pullRequestNumber: 4072 },
    ])

    app = Fastify({ logger: { level: 'silent' } })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    await app.register(schedulerPlugin)

    // Prova de que a varredura do retrato rodou (a ficha do PR foi gravada)...
    await vi.waitFor(() => expect(prisma.repoItem.upsert).toHaveBeenCalled(), {
      timeout: 5000,
      interval: 10,
    })
    // ...e de que o vínculo entrou nela.
    await vi.waitFor(
      () => {
        const gravacoes = prisma.repoItem.upsert.mock.calls
          .map((c) => (c as unknown as [{ update: Record<string, unknown> }])[0].update)
          .filter((u) => u['issueNumber'] === 3842)
        expect(gravacoes).toHaveLength(1)
        expect(gravacoes[0]).toMatchObject({
          issueNumber: 3842,
          vinculoOrigem: 'texto',
          origem: 'jules_gitorch',
        })
      },
      { timeout: 5000, interval: 10 }
    )

    expect(graphqlChamados(fetchMock)).toBe(0)
    const eventos = prisma.event.create.mock.calls.map(
      (c) => (c as unknown as [{ data: { payload: { chave: string } } }])[0].data.payload.chave
    )
    expect(eventos).toContain('vinculo-da-tarefa:acme/api:4072:3842')
  })

  test('PR sem sessão: consulta o GraphQL uma vez e grava o vínculo formal sem mexer na origem', async () => {
    const fetchMock = githubFalso(
      [
        {
          number: 4037,
          state: 'open',
          draft: false,
          user: { login: 'autor-humano' },
          head: { ref: 'x' },
        },
      ],
      [4036]
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma([])

    app = Fastify({ logger: { level: 'silent' } })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    await app.register(schedulerPlugin)

    // Prova de que a varredura do retrato rodou (a ficha do PR foi gravada)...
    await vi.waitFor(() => expect(prisma.repoItem.upsert).toHaveBeenCalled(), {
      timeout: 5000,
      interval: 10,
    })
    // ...e de que o vínculo entrou nela.
    await vi.waitFor(
      () => {
        const gravacoes = prisma.repoItem.upsert.mock.calls
          .map((c) => (c as unknown as [{ update: Record<string, unknown> }])[0].update)
          .filter((u) => u['issueNumber'] === 4036)
        expect(gravacoes).toHaveLength(1)
        expect(gravacoes[0]).toMatchObject({ vinculoOrigem: 'formal' })
        expect(gravacoes[0]).not.toHaveProperty('origem')
      },
      { timeout: 5000, interval: 10 }
    )
    expect(graphqlChamados(fetchMock)).toBe(1)
  })
})
