import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T30 (05/09) — REESCRITA pós-D75 (decisão do dono: "os agentes do
// gitorch não podem mandar essas dúvidas pra mim").
//
// ATÉ AQUI este teste provava que `reconciliarDuvidasEscaladasLegadas`
// criava uma `agent_question` DE VERDADE para a sessão presa (L4-T3, item
// 4) e migrava a marca para `escalada:`. Esse caminho é EXATAMENTE o que
// mandou as duas perguntas vazias de 05/09 — D75 fechou o caminho vivo
// (`escalar-duvida-ao-dono.ts`), mas este legado nunca foi desligado.
//
// A reescrita inverte o que se prova: o boot NUNCA cria `agent_question`
// para esta sessão — `reconciliarDuvidasEscaladasDoProjeto`
// (services/reconciliar-duvidas-escaladas.ts) não tem mais nenhum jeito de
// tocar `agentQuestion` (garantia estrutural no próprio tipo). A sessão
// presa (mesma assinatura exata: AWAITING_USER_FEEDBACK, marcada
// `respondida:0:<hash>`, sem `agent_question`) é ENCERRADA direto —
// `fecharSessao` com o motivo redelegante `pergunta-sem-resposta` — e a
// issue some da lista de "presa" (query filtra `closedAt: null`).
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  isActive: true,
}

const SESSAO_PRESA = {
  sessionName: 'sessions/presa-46',
  issueNumber: 46,
  answeredHash: 'respondida:0:hash123',
  devAccountId: null,
}

/** Proxy "catch-all": qualquer model/método não roteado explicitamente
 *  devolve um default seguro por HEURÍSTICA DO NOME — nunca lança
 *  `undefined is not a function`. Fininho o bastante para os call sites do
 *  scheduler que este teste não avalia (varreduras de quadro/sprint/cotas
 *  etc.) ficarem inertes sozinhos, sem precisar rotear cada um à mão.
 */
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
  const askCalls: Array<{ userId: string; projectId: string; input: Record<string, unknown> }> = []
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let fechada = false

  const prisma = new Proxy(
    {
      project: autoModel({
        // Só a consulta de `reconciliarDuvidasEscaladasLegadas` usa esta
        // forma exata de `select` ({id, wingId} e mais nada, desde a
        // reescrita L4-T30 — antes incluía `userId`, que ninguém mais lê
        // aqui) — as outras varreduras que também leem `{isActive:true}`
        // pedem campos extras e caem no default (`[]`).
        findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
          const chaves = Object.keys(args?.select ?? {})
            .sort()
            .join(',')
          if (chaves === 'id,wingId') return [PROJETO]
          return []
        }),
      }),
      devSession: autoModel({
        findMany: vi.fn(async (args: { where?: { answeredHash?: { not?: unknown } } }) => {
          // Só a query da reconciliação filtra `answeredHash: { not: null }`
          // — a de `sessoesVivas`/`varrerSessoesDoDev` não filtra por isso.
          if (args?.where?.answeredHash?.not === null) {
            return fechada ? [] : [{ ...SESSAO_PRESA }]
          }
          return []
        }),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateCalls.push(args)
          if (args.data['closedAt'] !== undefined) fechada = true
          return undefined
        }),
      }),
      agentQuestion: autoModel({
        findMany: vi.fn(async () => []), // nenhuma agent_question legada aberta neste cenário.
      }),
      mission: autoModel({
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      }),
      projectSchedule: autoModel({ findMany: vi.fn(async () => []) }),
      _askCalls: askCalls,
      _updateCalls: updateCalls,
      _fechada: () => fechada,
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & {
    _askCalls: typeof askCalls
    _updateCalls: typeof updateCalls
    _fechada: () => boolean
  }
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

describe('reconciliação de dúvidas escaladas legadas wiring em schedulerPlugin (real seam)', () => {
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
    // Sem chave do Jules de propósito: `chaveDaSessao` devolve `undefined`
    // sem tocar rede — o teste prova o ENCERRAMENTO em si, não a chamada ao
    // fornecedor (best-effort, já coberta em `dev-session-store.test.ts`).
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

  test('boot NUNCA cria agent_question — encerra a sessão presa direto (motivo pergunta-sem-resposta)', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async (userId: string, projectId: string, input: Record<string, unknown>) => {
      prisma._askCalls.push({ userId, projectId, input })
      return { deduped: false, question: { id: 'q1', answer: null } }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask, marcarAssumida: vi.fn() } as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(
          prisma._updateCalls.some(
            (c: { where: unknown; data: Record<string, unknown> }) =>
              (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName &&
              c.data['closedAt'] !== undefined
          )
        ).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    const fechamento = prisma._updateCalls.find(
      (c) => (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName
    )
    expect(fechamento?.data['closedReason']).toBe('pergunta-sem-resposta')
    expect(ask).not.toHaveBeenCalled()
  })

  test('idempotência: rodar em todo tique não reencerra nem reenvia nada depois de fechada', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } }))

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask, marcarAssumida: vi.fn() } as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(() => expect(prisma._fechada()).toBe(true), { timeout: 3000, interval: 10 })
    const fechamentosNoPrimeiroInstante = prisma._updateCalls.filter(
      (c) => (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName
    ).length

    // Vários tiques depois (o tique aqui é de 15ms — dezenas de passadas):
    // a sessão já fechada não aparece mais na query da reconciliação
    // (`closedAt: null`), então não é reprocessada — nem reenviada, nem
    // ganha `ask()` nenhum.
    await new Promise((r) => setTimeout(r, 200))
    expect(ask).not.toHaveBeenCalled()
    const fechamentosDepois = prisma._updateCalls.filter(
      (c) => (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName
    ).length
    expect(fechamentosDepois).toBe(fechamentosNoPrimeiroInstante)
  })
})
