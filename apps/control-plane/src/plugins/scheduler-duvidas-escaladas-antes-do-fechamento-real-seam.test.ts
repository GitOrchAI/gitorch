import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T4, fix-up 5 (task a13a42f8-2953-4259-b41f-3f8cddb304cd) — ITEM 2,
// REESCRITO em L4-T30 (05/09) pós-D75.
//
// PROVADO em produção 03/09: `reconciliarDuvidasEscaladasLegadas` rodava
// DEPOIS de `devolverVagasDeSessaoAbandonada`/`varrerCicloTerminalDaSessao`
// no `tick()`, e uma sessão AWAITING_USER_FEEDBACK marcada
// `respondida:0:<hash>` (assinatura do defeito L4-T3) podia ser fechada
// pelos dois varredores de cima ANTES de a reconciliação sequer olhar para
// ela. O conserto original preservou a ordem (reconciliação PRIMEIRO) para
// a sessão virar `escalada:` (protegida) antes dos fechamentos — mas isso
// ainda dependia de criar `agent_question`, o caminho que D75 fechou.
//
// L4-T30: a reconciliação agora ENCERRA a sessão ela mesma (`fecharSessao`,
// motivo redelegante `pergunta-sem-resposta` — dev-session-store.ts,
// `MOTIVOS_QUE_REDELEGAM`), e a ORDEM continua importando pelo MESMO
// motivo, só que invertido: se `devolverVagasDeSessaoAbandonada` (que fecha
// com `abandoned`, motivo que NÃO redelega) chegasse primeiro nesta MESMA
// sessão, a tarefa se perderia da fila em vez de ser redelegada. Rodando a
// reconciliação primeiro, a sessão já está fechada (com o motivo CERTO)
// quando os dois varredores de fechamento chegam — a query deles filtra
// `closedAt: null`, então nem tocam nela.
//
// Cenário do próprio fix-up: sessão AWAITING_USER_FEEDBACK marcada
// `respondida:0:<hash>`, parada há 25h (além do teto de 12h de
// `devolverVagasDeSessaoAbandonada`) — no fim do tique ela está FECHADA,
// com `closedReason: 'pergunta-sem-resposta'` (nunca `abandoned`), e NENHUMA
// `agent_question` foi criada.

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  isActive: true,
}

const HASH = 'abc123'
const SESSAO_PRESA = {
  sessionName: 'sessions/presa-3787',
  projectId: PROJETO.id,
  issueNumber: 3787,
  pullRequestNumber: 501,
  state: 'AWAITING_USER_FEEDBACK',
  answeredHash: `respondida:0:${HASH}`,
  devAccountId: null,
  requeueCount: 0,
  analysisDoneAt: null,
  createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
  // 25h sem avançar: além do teto de 12h de `devolverVagasDeSessaoAbandonada`
  // (`HORAS_SEM_PROGRESSO_ATE_ABANDONAR`, sessao-abandonada.ts).
  lastProgressAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
}

/** Proxy "catch-all": qualquer model/método não roteado explicitamente
 *  devolve um default seguro por HEURÍSTICA DO NOME — mesmo padrão de
 *  `scheduler-duvidas-escaladas-reconciliacao-real-seam.test.ts`. */
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
  let motivoFechamento: string | null = null

  const prisma = new Proxy(
    {
      project: autoModel({
        // Só a consulta de `reconciliarDuvidasEscaladasLegadas` usa esta
        // forma exata de `select` ({id, wingId}, desde a reescrita L4-T30
        // — antes incluía `userId`) — as outras varreduras que também leem
        // `{isActive:true}` pedem campos extras e caem no default (`[]`).
        findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
          const chaves = Object.keys(args?.select ?? {})
            .sort()
            .join(',')
          if (chaves === 'id,wingId') return [PROJETO]
          return []
        }),
        findUnique: vi.fn(async () => PROJETO),
      }),
      telegramLink: autoModel({ findUnique: vi.fn(async () => null) }),
      devSession: autoModel({
        findMany: vi.fn(
          async (args: {
            where?: { answeredHash?: { not?: unknown }; projectId?: unknown }
            distinct?: unknown
          }) => {
            // 1) `varrerSessoesDoDev`: lista de projetos com sessão viva.
            if (args?.distinct) return [{ projectId: PROJETO.id }]
            // 2) A query da RECONCILIAÇÃO — só ela filtra `answeredHash: {not: null}`.
            if (args?.where?.answeredHash?.not === null) {
              return fechada ? [] : [{ ...SESSAO_PRESA }]
            }
            // 3) `sessoesVivas` (por projeto, dentro de `varrerSessoesDoDev`)
            //    — sem chave do Jules configurada, `consultarSessao` devolve
            //    null e a vigia não toca nesta linha (ver comentário no topo).
            if (args?.where?.projectId) {
              return fechada ? [] : [{ ...SESSAO_PRESA, closedAt: null }]
            }
            // 4) Consulta GLOBAL `{closedAt: null}` — usada pelas DUAS
            //    varreduras que este teste avalia:
            //    `linhasVivasParaJulgarAbandono` (devolverVagasDeSessaoAbandonada)
            //    e `linhasVivasParaCicloTerminal` (varrerCicloTerminalDaSessao).
            //    Depois do conserto, a reconciliação já FECHOU a sessão
            //    ANTES destas duas no mesmo tique — `fechada` já é `true`.
            return fechada ? [] : [{ ...SESSAO_PRESA, closedAt: null }]
          }
        ),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateCalls.push(args)
          if (args.data['closedAt'] !== undefined) {
            fechada = true
            motivoFechamento = (args.data['closedReason'] as string) ?? null
          }
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
      _motivoFechamento: () => motivoFechamento,
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & {
    _askCalls: typeof askCalls
    _updateCalls: typeof updateCalls
    _fechada: () => boolean
    _motivoFechamento: () => string | null
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

describe('reconciliação de dúvidas ANTES dos fechamentos no tick (real seam, L4-T4 fix-up 5 / L4-T30)', () => {
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
    // Sem GITORCH_GITHUB_TOKEN/JULES_API_KEY de propósito: a sessão deste
    // cenário nunca chega a precisar de rede (nem GitHub — não é terminal;
    // nem Jules — a vigia não tem chave e não toca a linha, ver topo do
    // arquivo). Isolar isso é o que permite provar SÓ a ordem/cadência do
    // `tick`, sem simular PR nem sessão remota.
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

  test('sessão AWAITING com respondida:0:<hash> parada há 25h: no fim do tique está FECHADA com pergunta-sem-resposta (nunca abandoned), e nenhuma agent_question foi criada', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async (userId: string, projectId: string, input: Record<string, unknown>) => {
      prisma._askCalls.push({ userId, projectId, input })
      return { deduped: false, question: { id: 'q1', answer: null } }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask, marcarAssumida: vi.fn() } as never)
    await app.register(schedulerPlugin)

    // A reconciliação encerrou a sessão direto — prova que rodou ANTES dos
    // dois varredores de fechamento (senão eles teriam fechado primeiro,
    // com `abandoned`).
    await vi.waitFor(
      () => {
        expect(prisma._fechada()).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )
    expect(prisma._motivoFechamento()).toBe('pergunta-sem-resposta')

    // Dá tempo de mais alguns tiques passarem (devolverVagasDeSessaoAbandonada
    // e varrerCicloTerminalDaSessao já tiveram a chance de agir sobre a MESMA
    // sessão, no mesmo tique e nos seguintes) — o motivo do fechamento NUNCA
    // vira `abandoned`: a query deles filtra `closedAt: null` e a sessão já
    // não aparece mais.
    await new Promise((r) => setTimeout(r, 200))

    expect(prisma._motivoFechamento()).toBe('pergunta-sem-resposta')
    expect(ask).not.toHaveBeenCalled()

    const fechamentosDaSessao = prisma._updateCalls.filter(
      (c) =>
        (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName &&
        c.data['closedAt'] !== undefined
    )
    expect(fechamentosDaSessao).toHaveLength(1)
  })
})
