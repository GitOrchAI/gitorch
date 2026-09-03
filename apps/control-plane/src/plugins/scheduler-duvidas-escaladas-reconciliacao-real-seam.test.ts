import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T3, item 4 — O CONSERTO DAS 24 PRESAS: prova que `reconciliarDuvidasEscaladasLegadas`
// (extraída para `services/reconciliar-duvidas-escaladas.ts`, testada em
// isolamento em `reconciliar-duvidas-escaladas.test.ts`) está de fato
// CHAMADA pelo `tick()` de produção — o mesmo risco nomeado em
// `scheduler-pos-merge-real-seam.test.ts`: uma peça 100% testada em
// isolamento pode nunca rodar porque o call site real dentro do fechamento
// não-exportado do relógio nunca a chamou. Mesmo "real seam" (registra
// `schedulerPlugin` de VERDADE, `NODE_ENV` fora de 'test' só no registro,
// `GITORCH_SCHEDULER_TICK_MS` minúsculo para o `setInterval` de produção
// disparar `tick` de verdade).
//
// Cenário: uma dev_session AWAITING_USER_FEEDBACK marcada `respondida:0:<hash>`
// (a assinatura exata do defeito medido em 02/09 — 24 sessões assim, ZERO
// agent_question) e SEM a agent_question correspondente. Prova que o boot
// cria a pergunta de verdade (dedupKey `duvida-dev:*`) e migra a marca para
// `escalada:`, e que a cadência de 6h (aqui, minúscula pra ficar
// observável) impede reprocessar a cada tick.
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  userId: 'user_1',
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
  let marcaAtual: string | null = SESSAO_PRESA.answeredHash

  const prisma = new Proxy(
    {
      project: autoModel({
        // SÓ a consulta de `reconciliarDuvidasEscaladasLegadas` usa esta
        // forma exata de `select` ({id, wingId, userId} e mais nada) — as
        // outras ~11 varreduras que também leem `{isActive:true}` pedem
        // campos extras (autonomia/name/runtimeConfig/user) e caem no
        // default (`[]`), ficando inertes neste teste — mesmo espírito do
        // roteamento por forma de `scheduler-pos-merge-real-seam.test.ts`.
        findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
          const chaves = Object.keys(args?.select ?? {})
            .sort()
            .join(',')
          if (chaves === 'id,userId,wingId') return [PROJETO]
          return []
        }),
      }),
      devSession: autoModel({
        findMany: vi.fn(async (args: { where?: { answeredHash?: { not?: unknown } } }) => {
          // Só a query da reconciliação filtra `answeredHash: { not: null }`
          // — a de `sessoesVivas`/`varrerSessoesDoDev` não filtra por isso.
          if (args?.where?.answeredHash?.not === null) {
            return marcaAtual ? [{ ...SESSAO_PRESA, answeredHash: marcaAtual }] : []
          }
          return []
        }),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateCalls.push(args)
          if (typeof args.data['answeredHash'] === 'string') {
            marcaAtual = args.data['answeredHash']
          }
          return undefined
        }),
      }),
      agentQuestion: autoModel({
        findFirst: vi.fn(async () => null), // nunca existe ainda — não é idempotência entre boots aqui.
      }),
      mission: autoModel({
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      }),
      projectSchedule: autoModel({ findMany: vi.fn(async () => []) }),
      _askCalls: askCalls,
      _updateCalls: updateCalls,
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & {
    _askCalls: typeof askCalls
    _updateCalls: typeof updateCalls
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
  'GITORCH_RECONCILIACAO_DUVIDAS_CADENCIA_MS',
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
    // Sem chave do Jules de propósito: `ultimaMensagemDoDevJules` devolve ''
    // sem tocar rede (contrato do próprio serviço) — o teste prova a
    // ESCALADA em si, não a leitura da última mensagem (já coberta em
    // `reconciliar-duvidas-escaladas.test.ts`).
    process.env['GITORCH_RECONCILIACAO_DUVIDAS_CADENCIA_MS'] = '5000'
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

  test('boot cria a agent_question de verdade (dedupKey duvida-dev:*) e migra a marca para escalada:', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async (userId: string, projectId: string, input: Record<string, unknown>) => {
      prisma._askCalls.push({ userId, projectId, input })
      return { deduped: false, question: { id: 'q1', answer: null } }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    // Decora `agentQuestionService` DIRETO (sem telegramPlugin) — a mesma
    // leitura viva que `reconciliarDuvidasEscaladasLegadas` faz
    // (`(app as unknown as {agentQuestionService}).agentQuestionService`).
    app.decorate('agentQuestionService', { ask } as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(ask).toHaveBeenCalledTimes(1)
      },
      { timeout: 3000, interval: 10 }
    )

    expect(prisma._askCalls[0]?.userId).toBe('user_1')
    expect(prisma._askCalls[0]?.projectId).toBe('proj_1')
    expect(prisma._askCalls[0]?.input['dedupKey']).toBe('duvida-dev:acme/api:46:hash123')

    await vi.waitFor(() => {
      expect(
        prisma._updateCalls.some(
          (c: { where: unknown; data: Record<string, unknown> }) =>
            (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName &&
            c.data['answeredHash'] === 'escalada:0:hash123'
        )
      ).toBe(true)
    })
  })

  test('cadência: NÃO reprocessa a cada tick — só de novo depois da janela vencer', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } }))

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask } as never)
    await app.register(schedulerPlugin)

    // Primeira escalada, no boot.
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 10 })

    // Vários ticks depois (bem menos que os 5s de cadência configurados),
    // `ask` continua com UMA chamada só — a marca já é `escalada:`, que a
    // query nem devolve mais (mas mesmo que devolvesse, a cadência barraria).
    await new Promise((r) => setTimeout(r, 200))
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
