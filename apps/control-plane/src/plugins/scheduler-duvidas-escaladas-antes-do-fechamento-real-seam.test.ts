import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T4, fix-up 5 (task a13a42f8-2953-4259-b41f-3f8cddb304cd) — ITEM 2.
//
// PROVADO em produção 03/09: `reconciliarDuvidasEscaladasLegadas` rodava
// DEPOIS de `devolverVagasDeSessaoAbandonada`/`varrerCicloTerminalDaSessao`
// no `tick()`, e com cadência de 6h — então uma sessão AWAITING_USER_FEEDBACK
// marcada `respondida:0:<hash>` (assinatura do defeito da L4-T3: escalada sem
// `agent_question` real) podia ser fechada pelos dois varredores de cima
// ANTES de a reconciliação sequer olhar para ela. Pior: a query da
// reconciliação filtra `closedAt: null` (reconciliar-duvidas-escaladas.ts) —
// uma sessão já fechada some da reconciliação PARA SEMPRE. Medido: 9 sessões
// assim, 2 fechadas no MESMO primeiro tique (09:49:14), a reconciliação só às
// 09:51:08.
//
// O conserto (este arquivo prova o wiring real, registrando o
// `schedulerPlugin` de verdade e deixando o `setInterval` de produção
// disparar o `tick`): `reconciliarDuvidasEscaladasLegadas()` agora roda SEM
// cadência (todo tique) e ANTES dos dois varredores. Cenário do próprio
// fix-up: sessão AWAITING_USER_FEEDBACK marcada `respondida:0:<hash>`, parada
// há 25h (além do teto de 12h de `devolverVagasDeSessaoAbandonada`) — no fim
// do tique ela continua ABERTA, a marca virou `escalada:0:<hash>` e existe 1
// `agent_question` com dedupKey `duvida-dev:*`.
//
// Mesma técnica de costura dos outros `*-real-seam`: `project.findMany` e
// `devSession.findMany` roteiam por FORMA (select/where) — cada varredura do
// tique que este cenário não avalia (quadro, sprint, cotas, catálogo de
// modelos etc.) cai num default seguro e fica inerte, sem precisar mockar 20+
// call sites que não são o assunto deste teste.

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  isActive: true,
}

const HASH = 'abc123'
const SESSAO_PRESA = {
  sessionName: 'sessions/presa-3787',
  projectId: PROJETO.id,
  issueNumber: 3787,
  pullRequestNumber: 501,
  state: 'AWAITING_USER_FEEDBACK',
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
  let marcaAtual: string | null = `respondida:0:${HASH}`
  let fechada = false

  const prisma = new Proxy(
    {
      project: autoModel({
        // Só a consulta de `reconciliarDuvidasEscaladasLegadas` usa esta
        // forma exata de `select` ({id, wingId, userId}) — as outras ~11
        // varreduras que também leem `{isActive:true}` pedem campos extras e
        // caem no default (`[]`), ficando inertes neste teste.
        findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
          const chaves = Object.keys(args?.select ?? {})
            .sort()
            .join(',')
          if (chaves === 'id,userId,wingId') return [PROJETO]
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
              return marcaAtual && !fechada
                ? [
                    {
                      sessionName: SESSAO_PRESA.sessionName,
                      issueNumber: SESSAO_PRESA.issueNumber,
                      answeredHash: marcaAtual,
                    },
                  ]
                : []
            }
            // 3) `sessoesVivas` (por projeto, dentro de `varrerSessoesDoDev`)
            //    — sem chave do Jules configurada, `consultarSessao` devolve
            //    null e a vigia não toca nesta linha (ver comentário no topo).
            if (args?.where?.projectId) {
              return fechada ? [] : [{ ...SESSAO_PRESA, answeredHash: marcaAtual, closedAt: null }]
            }
            // 4) Consulta GLOBAL `{closedAt: null}` — usada pelas DUAS
            //    varreduras que este teste avalia:
            //    `linhasVivasParaJulgarAbandono` (devolverVagasDeSessaoAbandonada)
            //    e `linhasVivasParaCicloTerminal` (varrerCicloTerminalDaSessao).
            //    Depois do conserto, a reconciliação já rodou ANTES destas
            //    duas no mesmo tique — `marcaAtual` já reflete `escalada:`.
            return fechada ? [] : [{ ...SESSAO_PRESA, answeredHash: marcaAtual, closedAt: null }]
          }
        ),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateCalls.push(args)
          if (typeof args.data['answeredHash'] === 'string') {
            marcaAtual = args.data['answeredHash']
          }
          if (args.data['closedAt'] !== undefined) {
            fechada = true
          }
          return undefined
        }),
      }),
      agentQuestion: autoModel({
        findFirst: vi.fn(async () => null),
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
      _marcaAtual: () => marcaAtual,
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & {
    _askCalls: typeof askCalls
    _updateCalls: typeof updateCalls
    _fechada: () => boolean
    _marcaAtual: () => string | null
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

describe('reconciliação de dúvidas ANTES dos fechamentos no tick (real seam, L4-T4 fix-up 5)', () => {
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

  test('sessão AWAITING com respondida:0:<hash> parada há 25h: no fim do tique continua ABERTA, marca virou escalada: e existe 1 agent_question duvida-dev:*', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async (userId: string, projectId: string, input: Record<string, unknown>) => {
      prisma._askCalls.push({ userId, projectId, input })
      return { deduped: false, question: { id: 'q1', answer: null } }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask } as never)
    await app.register(schedulerPlugin)

    // A reconciliação criou a pergunta de verdade — prova que rodou.
    await vi.waitFor(
      () => {
        expect(ask).toHaveBeenCalledTimes(1)
      },
      { timeout: 3000, interval: 10 }
    )
    expect(prisma._askCalls[0]?.input['dedupKey']).toBe(`duvida-dev:acme/api:3787:${HASH}`)

    // A marca migrou para `escalada:` — é o que protege a sessão dos dois
    // varredores de fechamento que rodam DEPOIS no mesmo tique.
    await vi.waitFor(() => {
      expect(prisma._marcaAtual()).toBe(`escalada:0:${HASH}`)
    })

    // Dá tempo de mais alguns tiques passarem (devolverVagasDeSessaoAbandonada
    // e varrerCicloTerminalDaSessao já tiveram a chance de agir sobre a MESMA
    // sessão, no mesmo tique e nos seguintes) — e ela CONTINUA aberta.
    await new Promise((r) => setTimeout(r, 200))

    expect(prisma._fechada()).toBe(false)
    const fechouASessao = prisma._updateCalls.some(
      (c) =>
        (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName &&
        c.data['closedAt'] !== undefined
    )
    expect(fechouASessao).toBe(false)
  })
})
