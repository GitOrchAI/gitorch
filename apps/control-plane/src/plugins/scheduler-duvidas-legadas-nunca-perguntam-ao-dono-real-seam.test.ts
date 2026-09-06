import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T30 (05/09) — O TESTE CENTRAL do conserto pós-D75 (decisão do dono:
// "os agentes do gitorch não podem mandar essas dúvidas pra mim").
//
// Sobe o relógio de VERDADE (`schedulerPlugin` registrado de fato,
// `GITORCH_SCHEDULER_TICK_MS` minúsculo para o `setInterval` de produção
// disparar `tick()` de verdade) com os DOIS lados do defeito medido em
// 05/09 ao mesmo tempo:
//
//  1) uma dev_session AWAITING_USER_FEEDBACK marcada `respondida:0:<hash>`
//     — a assinatura exata do defeito de `escalar-duvida-ao-dono.ts` (L4-
//     T3, 02/09), SEM `agent_question` correspondente — o caminho que
//     `reconciliarDuvidasEscaladasDoProjeto` (services/reconciliar-duvidas-
//     escaladas.ts) varre a cada tique;
//  2) uma `agent_question` JÁ `open`, dedupKey `duvida-dev:*` (a tarefa
//     #3866 do Jardim, de ontem — a que o caminho legado já tinha
//     escalado ao dono ANTES deste conserto, com contexto vazio, D73/L4-
//     T23) — o caminho que `encerrarDuvidasLegadasAbertasDoProjeto`
//     (services/encerrar-duvidas-legadas-abertas.ts) varre.
//
// PROVA, ao longo de VÁRIAS passagens do relógio (não só a primeira): `ask`
// — a única porta que cria pergunta ao dono (`AgentQuestionService.ask`) —
// NUNCA é chamada, em NENHUM dos dois caminhos. Prova também o DESFECHO
// positivo de cada um: a sessão presa é ENCERRADA (motivo redelegante
// `pergunta-sem-resposta`, a issue volta para a fila) e a pergunta aberta é
// ENCERRADA via `marcarAssumida` citando D75 — cada uma exatamente UMA vez,
// mesmo depois de dezenas de tiques.

const PROJETO = {
  id: 'proj_1',
  wingId: 'GitOrchAI/jardim',
  isActive: true,
}

const SESSAO_PRESA = {
  sessionName: 'sessions/presa-99',
  projectId: PROJETO.id,
  issueNumber: 99,
  state: 'AWAITING_USER_FEEDBACK',
  answeredHash: 'respondida:0:hashSessao',
  devAccountId: null,
}

const PERGUNTA_ABERTA_3866 = {
  id: 'q_3866',
  dedupKey: 'duvida-dev:GitOrchAI/jardim:3866:hashPergunta',
  // 4 opções (3 executivas + a livre) DE PROPÓSITO: bem formada, para que
  // `reprocessarPerguntasSemOpcoesDoProjeto` (D72, "sem opções") NÃO a
  // encerre por engano — este teste prova o encerramento pelo caminho NOVO
  // (`encerrarDuvidasLegadasAbertasDoProjeto`, item 2), isolado do
  // mecanismo antigo que já existia para perguntas quebradas.
  options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
}

/** Proxy "catch-all": qualquer model/método não roteado explicitamente
 *  devolve um default seguro por HEURÍSTICA DO NOME — mesmo padrão dos
 *  outros `*-real-seam` desta pasta. */
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
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let sessaoFechada = false
  let perguntaAindaAberta = true

  const prisma = new Proxy(
    {
      project: autoModel({
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
          // Só a query da reconciliação filtra `answeredHash: { not: null }`.
          if (args?.where?.answeredHash?.not === null) {
            return sessaoFechada ? [] : [{ ...SESSAO_PRESA }]
          }
          return []
        }),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
          updateCalls.push(args)
          if (args.data['closedAt'] !== undefined) sessaoFechada = true
          return undefined
        }),
      }),
      agentQuestion: autoModel({
        findMany: vi.fn(
          async (args: { where?: { status?: string; dedupKey?: { startsWith?: string } } }) => {
            if (args?.where?.status === 'open' && args?.where?.dedupKey?.startsWith) {
              return perguntaAindaAberta ? [PERGUNTA_ABERTA_3866] : []
            }
            return []
          }
        ),
      }),
      mission: autoModel({
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      }),
      projectSchedule: autoModel({ findMany: vi.fn(async () => []) }),
      _updateCalls: updateCalls,
      _sessaoFechada: () => sessaoFechada,
      _fecharPergunta: () => {
        perguntaAindaAberta = false
      },
    },
    {}
  )
  return prisma as unknown as Record<string, unknown> & {
    _updateCalls: typeof updateCalls
    _sessaoFechada: () => boolean
    _fecharPergunta: () => void
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

describe('D75 — nenhum caminho legado de dúvida do dev cria pergunta ao dono (real seam, teste central)', () => {
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

  test('sessão presa + pergunta legada aberta (tarefa #3866): ask() nunca é chamado em várias passagens; sessão encerra e pergunta é assumida uma única vez', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async () => ({ deduped: false, question: { id: 'novo', answer: null } }))
    const marcarAssumida = vi.fn(async (args: { questionId: string; suposicao: string }) => {
      if (args.questionId === PERGUNTA_ABERTA_3866.id) {
        prisma._fecharPergunta()
      }
      return { id: args.questionId, status: 'assumida', answer: args.suposicao }
    })

    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    app.decorate('agentQuestionService', { ask, marcarAssumida } as never)
    await app.register(schedulerPlugin)

    // Os dois desfechos acontecem — prova que os DOIS caminhos rodaram.
    await vi.waitFor(
      () => {
        expect(prisma._sessaoFechada()).toBe(true)
        expect(marcarAssumida).toHaveBeenCalledWith(
          expect.objectContaining({ questionId: PERGUNTA_ABERTA_3866.id })
        )
      },
      { timeout: 3000, interval: 10 }
    )

    // A suposição que encerra a pergunta legada cita D75 — nunca finge que o
    // dono decidiu algo.
    const chamadaDeEncerramento = marcarAssumida.mock.calls.find(
      (c) => (c[0] as { questionId: string }).questionId === PERGUNTA_ABERTA_3866.id
    )
    expect((chamadaDeEncerramento?.[0] as { suposicao: string }).suposicao).toContain('D75')

    // A sessão encerrou com o motivo redelegante — a issue volta para a
    // fila, nunca some.
    const fechamentoDaSessao = prisma._updateCalls.find(
      (c) => (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName
    )
    expect(fechamentoDaSessao?.data['closedReason']).toBe('pergunta-sem-resposta')

    // VÁRIAS passagens depois (o tique aqui é de 15ms — dezenas de
    // passadas): `ask` NUNCA foi chamado, em nenhum momento, para nenhum
    // dos dois caminhos — e nada é reprocessado (idempotência: a sessão já
    // fechada some da query da reconciliação; a pergunta já assumida some
    // da query do encerramento).
    await new Promise((r) => setTimeout(r, 250))

    expect(ask).not.toHaveBeenCalled()
    expect(marcarAssumida).toHaveBeenCalledTimes(1)
    const fechamentosDaSessao = prisma._updateCalls.filter(
      (c) =>
        (c.where as { sessionName?: string }).sessionName === SESSAO_PRESA.sessionName &&
        c.data['closedAt'] !== undefined
    )
    expect(fechamentosDaSessao).toHaveLength(1)
  })
})
