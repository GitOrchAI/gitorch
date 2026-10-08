import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { RuntimeAdapter } from '@gitorch/agents'
import type { AgentQuestionService } from '../services/agent-question.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'

// A busca da tarefa pelo código dentro da missão do RA, pelo caminho REAL do
// serviço: `app.triggerAgentMission('ra', ...)` -> runTrigger ->
// executeMissionWithFailover -> `execute` (o motor de IA) -> o extra
// `rodarBuscaDeTarefaParecida`. A peça existia, passava nos próprios testes e
// ninguém a chamava: este teste falha se o extra voltar a sumir da missão.
//
// O motor de IA é FALSO (o adaptador do CLI é trocado por um que responde o
// formulário do analista), mas o prompt, a validação do formulário e a
// escolha do que gravar são o código de produção.
const motor = vi.hoisted(() => ({
  prompts: [] as string[],
  resposta: {
    issueNumberEncontrado: 713 as number | null,
    justificativa: 'o diff mexe no wishlist',
  },
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    createCliRuntimeAdapter: (opcoes: { runtime: RuntimeAdapter['runtime'] }): RuntimeAdapter => ({
      runtime: opcoes.runtime,
      async run(pedido) {
        motor.prompts.push(pedido.prompt)
        return {
          missionId: pedido.missionId,
          runtime: opcoes.runtime,
          exitCode: 0,
          durationMs: 1,
          output: JSON.stringify(motor.resposta),
          stderr: '',
        }
      },
    }),
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  devPlan: null,
  autonomia: 'cuidar',
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
  encryptedClientToken: null,
} as const

interface MissaoFalsa {
  id: string
  status: string
  payload: Record<string, unknown>
  result?: unknown
  error?: string
}

function buildFakePrisma() {
  const missoes: MissaoFalsa[] = []
  const eventos: Array<{ chave: string; texto: string }> = []
  const gravacoesDeFicha: Array<Record<string, unknown>> = []
  return {
    _missoes: missoes,
    _eventos: eventos,
    _gravacoesDeFicha: gravacoesDeFicha,
    mission: {
      create: vi.fn(async ({ data }: { data: { payload: Record<string, unknown> } }) => {
        const m: MissaoFalsa = {
          id: `mission_${missoes.length + 1}`,
          status: 'running',
          payload: data.payload,
        }
        missoes.push(m)
        return { id: m.id }
      }),
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { tokensUsed: 0 } })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = missoes.find((x) => x.id === where.id)
        return m ? { payload: m.payload } : null
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const m = missoes.find((x) => x.id === where.id)
          if (m) Object.assign(m, data)
          return {}
        }
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id?: string }; data: Record<string, unknown> }) => {
          const m = missoes.find((x) => x.id === where.id)
          if (m) Object.assign(m, data)
          return { count: m ? 1 : 0 }
        }
      ),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    engineConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    devSession: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => undefined),
    },
    repoItem: {
      // O PR #590, aberto, de um assistente de código, sem tarefa ligada.
      findMany: vi.fn(async () => [{ numero: 590, origem: 'assistente' }]),
      findUnique: vi.fn(async () => ({
        id: 'ri_590',
        projectId: 'proj_1',
        tipo: 'pr',
        numero: 590,
        estado: { status: 'open' },
        origem: 'assistente',
        issueNumber: null,
        entendimento: null,
        vinculoOrigem: null,
      })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        gravacoesDeFicha.push(update)
        return {}
      }),
    },
    event: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { payload: { chave?: string; texto?: string } } }) => {
        if (data.payload.chave) {
          eventos.push({ chave: data.payload.chave, texto: data.payload.texto ?? '' })
        }
        return {}
      }),
    },
    agentQuestion: { findFirst: vi.fn(async () => null) },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => null) },
  }
}

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

describe('busca da tarefa pelo código na missão do RA (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    limparFreiosDeCota()
    motor.prompts.length = 0
    motor.resposta = { issueNumberEncontrado: 713, justificativa: 'o diff mexe no wishlist' }
    for (const chave of ENV_KEYS) {
      original[chave] = process.env[chave]
      delete process.env[chave]
    }
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    // O relógio do tique não pode disputar a missão deste teste.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '3600000'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '3600000'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const chave of ENV_KEYS) {
      if (original[chave] === undefined) delete process.env[chave]
      else process.env[chave] = original[chave]
    }
    global.fetch = originalFetch
    limparFreiosDeCota()
    vi.restoreAllMocks()
  })

  function githubFalso() {
    return vi.fn(async (url: string | URL | Request) => {
      const endereco = String(url)
      if (endereco.includes('/repos/acme/api/pulls?state=open')) {
        return new Response(
          JSON.stringify([
            { number: 590, title: 'wishlist: add vira desejo', head: { sha: 'abc123' } },
          ]),
          { status: 200 }
        )
      }
      if (endereco.includes('/repos/acme/api/issues?state=open')) {
        return new Response(
          JSON.stringify([
            { number: 713, title: '/wishlist add responde confirmação mas não registra o pedido' },
            { number: 30, title: 'Outra tarefa' },
          ]),
          { status: 200 }
        )
      }
      if (endereco.includes('/repos/acme/api/pulls/590/files')) {
        return new Response(
          JSON.stringify([
            { filename: 'src/wishlist.ts', status: 'modified', additions: 4, deletions: 1 },
          ]),
          { status: 200 }
        )
      }
      return new Response('[]', { status: 200 })
    })
  }

  async function dispararRa(
    prisma: ReturnType<typeof buildFakePrisma>,
    ask = vi.fn(async () => ({ deduped: false }))
  ) {
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    app.decorate('agentQuestionService', { ask } as unknown as AgentQuestionService)
    await app.register(schedulerPlugin)
    const resultado = await app.triggerAgentMission('ra', 'proj_1', undefined, 'analise-pendente')
    expect(resultado.triggered).toBe(true)
    const missionId = resultado.missionId as string
    await vi.waitFor(
      () => {
        const missao = prisma._missoes.find((m) => m.id === missionId)
        if (missao?.status === 'failed') throw new Error(`missão falhou: ${missao.error}`)
        expect(missao?.status).toBe('completed')
      },
      { timeout: 8000, interval: 20 }
    )
    return { ask, missao: prisma._missoes.find((m) => m.id === missionId)! }
  }

  test('o analista é chamado dentro da missão e a tarefa achada vira palpite "codigo" na ficha, com rastro no painel', async () => {
    global.fetch = githubFalso() as unknown as typeof fetch
    const prisma = buildFakePrisma()

    const { ask } = await dispararRa(prisma)

    expect(motor.prompts).toHaveLength(1)
    expect(motor.prompts[0]).toContain('#713')
    expect(motor.prompts[0]).toContain('src/wishlist.ts')
    expect(prisma._gravacoesDeFicha).toHaveLength(1)
    expect(prisma._gravacoesDeFicha[0]).toMatchObject({ issueNumber: 713, vinculoOrigem: 'codigo' })
    expect(prisma._eventos.map((e) => e.chave)).toEqual(['vinculo-ra:acme/api:590:abc123'])
    expect(ask).not.toHaveBeenCalled()
  })

  test('sem tarefa válida o dono é perguntado pelo serviço de perguntas da instância', async () => {
    global.fetch = githubFalso() as unknown as typeof fetch
    motor.resposta = { issueNumberEncontrado: 9999, justificativa: 'chutei' }
    const prisma = buildFakePrisma()

    const { ask } = await dispararRa(prisma)

    expect(prisma._gravacoesDeFicha).toEqual([])
    expect(ask).toHaveBeenCalledTimes(1)
    const [usuario, projeto, pergunta] = ask.mock.calls[0] as unknown as [
      string,
      string,
      { dedupKey: string; options: Array<{ value: string }> },
    ]
    expect(usuario).toBe('user_1')
    expect(projeto).toBe('proj_1')
    expect(pergunta.dedupKey).toBe('vinculo-da-tarefa:acme/api:590')
    expect(pergunta.options).toHaveLength(4)
  })

  test('sem ficha candidata a missão não chama o GitHub nem o motor para isso', async () => {
    const fetchMock = githubFalso()
    global.fetch = fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma()
    prisma.repoItem.findMany.mockResolvedValue([])

    await dispararRa(prisma)

    expect(motor.prompts).toHaveLength(0)
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/pulls?state=open'))
    ).toHaveLength(0)
  })
})
