import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

/**
 * D72 (02/09), item 5 — TESTE DE COSTURA REAL: prova que `reprocessarPerguntasSemOpcoesDoProjeto`
 * (services/reprocessar-perguntas-sem-opcoes.ts, testada em isolamento em
 * reprocessar-perguntas-sem-opcoes.test.ts) está de fato CHAMADA pelo
 * `tick()` de produção — mesmo risco de sempre: uma peça 100% testada
 * isoladamente pode nunca rodar porque o call site real do relógio nunca a
 * chamou (ver scheduler-pos-merge-real-seam.test.ts para o precedente).
 *
 * Cenário: as 4 perguntas REAIS que o dono flagrou ao vivo no painel/
 * Telegram (print de 02/09), todas com o mesmo formato quebrado — UM botão
 * só ("Outro/respondo por texto"), texto em inglês da tarefa #309 de
 * GitOrchAI/gitorch. Prova que o boot (schedulerPlugin real, tick de
 * verdade) marca as 4 como `assumida` via `agentQuestionService.marcarAssumida`
 * — elas saem de "Esperando você" sem precisar de clique nenhum.
 */

const PROJETO = { id: 'proj_1', wingId: 'GitOrchAI/gitorch', userId: 'user_1', isActive: true }

// As 4 perguntas reais do print do dono (02/09) — mesmo texto, mesmo
// formato de 1 botão só.
const PERGUNTAS_REAIS_QUEBRADAS = [
  {
    id: 'q_309a',
    projectId: 'proj_1',
    status: 'open',
    dedupKey: 'duvida-dev:GitOrchAI/gitorch:309:hash-a',
    options: [{ label: 'Outro (respondo por texto)', value: '__gitorch_free_text__' }],
    text:
      'O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão ' +
      "sua. Pergunta original do dev: 'I have successfully modified the code and verified the " +
      'tests are passing. 1. In packages/github-sync/src/webhook-normalizer.ts, I mapped ' +
      "wishCreatedAt to optionalString(issue, created_at)...'",
  },
  {
    id: 'q_309b',
    projectId: 'proj_1',
    status: 'open',
    dedupKey: 'duvida-dev:GitOrchAI/gitorch:309:hash-b',
    options: [{ label: 'Outro (respondo por texto)', value: '__gitorch_free_text__' }],
    text:
      'O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão ' +
      'sua. Pergunta original do dev: \'The review feedback told me: "The plan completely omits ' +
      'the required changes..." Wait, I asked for clarification on whether I should ignore the ' +
      "memory constraints about prisma.ts...'",
  },
  {
    id: 'q_309c',
    projectId: 'proj_1',
    status: 'open',
    dedupKey: 'duvida-dev:GitOrchAI/gitorch:309:hash-c',
    options: [],
    text: 'O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão sua.',
  },
  {
    id: 'q_309d',
    projectId: 'proj_1',
    status: 'open',
    dedupKey: 'duvida-dev:GitOrchAI/gitorch:309:hash-d',
    options: [{ label: 'Outro (respondo por texto)', value: '__gitorch_free_text__' }],
    text: 'O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão sua.',
  },
]

function defaultParaMetodo(nome: string): unknown {
  if (/^find(Many)/.test(nome)) return async () => []
  if (/^(findFirst|findUnique)$/.test(nome)) return async () => null
  if (/^count$/.test(nome)) return async () => 0
  if (/^aggregate$/.test(nome)) return async () => ({ _sum: {}, _count: 0 })
  if (/^updateMany$/.test(nome)) return async () => ({ count: 0 })
  if (/^(update|upsert|create)$/.test(nome)) return async () => ({})
  return async () => undefined
}

function autoModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      return defaultParaMetodo(prop)
    },
  })
}

function buildFakePrisma() {
  const questoes = new Map(PERGUNTAS_REAIS_QUEBRADAS.map((q) => [q.id, { ...q }]))

  const prisma = new Proxy(
    {
      project: autoModel({
        findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
          const chaves = Object.keys(args?.select ?? {})
            .sort()
            .join(',')
          if (chaves === 'id,userId,wingId') return [PROJETO]
          if (chaves === 'id,isActive,userId,wingId') return [PROJETO]
          return []
        }),
      }),
      devSession: autoModel({}),
      agentQuestion: autoModel({
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(
          async (args: {
            where?: { projectId?: string; status?: string; dedupKey?: { startsWith?: string } }
          }) => {
            const prefixo = args?.where?.dedupKey?.startsWith
            if (!prefixo) return []
            return [...questoes.values()].filter(
              (q) =>
                q.projectId === args?.where?.projectId &&
                q.status === args?.where?.status &&
                q.dedupKey.startsWith(prefixo)
            )
          }
        ),
      }),
      mission: autoModel({}),
      projectSchedule: autoModel({ findMany: vi.fn(async () => []) }),
      _questoes: questoes,
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & { _questoes: typeof questoes }
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'JULES_API_KEY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

describe('reprocessamento de perguntas sem opções wiring em schedulerPlugin (real seam)', () => {
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

  test('boot marca as 4 perguntas reais quebradas (tarefa #309) como assumida — saem de "Esperando você"', async () => {
    const prisma = buildFakePrisma()
    const marcarAssumida = vi.fn(async (args: { questionId: string; projectId: string }) => {
      const q = prisma._questoes.get(args.questionId)
      if (q) q.status = 'assumida'
      return { id: args.questionId, status: 'assumida' }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask: vi.fn(), marcarAssumida } as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(marcarAssumida).toHaveBeenCalledTimes(4)
      },
      { timeout: 3000, interval: 10 }
    )

    const idsChamados = marcarAssumida.mock.calls.map(
      (c) => (c[0] as { questionId: string }).questionId
    )
    expect(new Set(idsChamados)).toEqual(new Set(['q_309a', 'q_309b', 'q_309c', 'q_309d']))
    for (const q of prisma._questoes.values()) {
      expect(q.status).toBe('assumida')
    }
  })

  test('idempotência: depois de reprocessadas (status != open), tiques seguintes não chamam marcarAssumida de novo', async () => {
    const prisma = buildFakePrisma()
    const marcarAssumida = vi.fn(async (args: { questionId: string }) => {
      const q = prisma._questoes.get(args.questionId)
      if (q) q.status = 'assumida'
      return { id: args.questionId, status: 'assumida' }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask: vi.fn(), marcarAssumida } as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(() => expect(marcarAssumida).toHaveBeenCalledTimes(4), {
      timeout: 3000,
      interval: 10,
    })

    await new Promise((r) => setTimeout(r, 200))
    // A query real filtra `status: 'open'` — uma vez marcadas `assumida`,
    // somem da próxima varredura (mesma disciplina de `escalada:` na
    // reconciliação legada).
    expect(marcarAssumida).toHaveBeenCalledTimes(4)
  })
})
