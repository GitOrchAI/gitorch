import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T4 (D64), fix-up da task a13a42f8-2953-4259-b41f-3f8cddb304cd.
//
// A LACUNA que este arquivo prova fechada: `suporSemODono`
// (duvida-rails-mission.ts) já existia, testado, mas em produção
// `deps.suporSemODono` NUNCA era fornecido a `session-watch.ts` — o único
// `execute: StepExecutor` real do produto nasce dentro de
// `executeMissionWithFailover` (dentro de uma missão de QA), e a vigia
// (`varrerSessoesDoDev`) roda no seu PRÓPRIO `setInterval`, fora de
// qualquer missão. Todo tique caía sempre em "sem suposição concreta".
//
// O conserto: o ramo de 24h de `session-watch.ts` não decide mais nada
// sozinho — ele só ACORDA o QA (`dispararMissao('qa', ...)`), pelo MESMO
// trilho que qualquer outra dúvida pendente. Quem de fato forma a
// suposição, com o `execute` real, é `suporDuvidaPendente`
// (services/supor-duvida-pendente.ts), chamada de dentro da missão de QA —
// e essa DECISÃO (limiar de 24h, formar/entregar a suposição, nunca fechar
// a sessão) tem cobertura unitária direta e real em
// `supor-duvida-pendente.test.ts` (usa o `suporSemODono` de verdade, com um
// `execute` falso).
//
// Este arquivo prova a OUTRA metade, no ponto real de wiring: registra o
// `schedulerPlugin` de VERDADE, deixa o `setInterval` de produção disparar
// o tique, e prova que uma sessão AWAITING_USER_FEEDBACK com marca
// `escalada:` (dúvida escalada ao dono, ainda sem resposta) FAZ a vigia
// disparar a missão de QA — o mesmo ponto de entrada de onde
// `suporDuvidaPendente` roda — e NUNCA fecha a sessão dizendo "já foi
// respondida" (mentira: ninguém respondeu, é o dono quem decide).
//
// FIX-UP 2 (D64/L4-T3/L4-T4, task a13a42f8-2953-4259-b41f-3f8cddb304cd):
// este arquivo isolava o watchdog de abandono (`devolverVagasDeSessaoAbandonada`
// / `sessao-abandonada.ts`) do restante do tique, devolvendo `[]` para a
// consulta GLOBAL dele — porque, sem o conserto, esse watchdog fechava
// qualquer AWAITING_USER_FEEDBACK parada há 12h+ como `abandoned`, e a
// sessão escalada deste teste (25h parada) seria uma delas: o teste provaria
// o disparo da missão e, ao mesmo tempo, esconderia que a MESMA sessão seria
// fechada por um watchdog vizinho — o achado real do executor anterior. O
// conserto (`sessao-abandonada.ts`: `AWAITING_USER_FEEDBACK` com marca
// `escalada:` pausa o relógio de abandono) já está no ar, então o
// isolamento SAIU: a consulta global agora recebe os MESMOS dados reais, e
// é o comportamento de produção — não mais um mock — que garante a sessão
// escalada sobrevivendo ao tique inteiro.
//
// Mesma costura real dos outros arquivos `*-real-seam`
// (`scheduler-vigia-pre-merge-real-seam.test.ts`): `mission.count` devolve
// um valor acima do teto para forçar `busy` em `runTrigger` — o disparo já
// fica provado (a chamada aconteceu) sem o teste precisar simular uma
// missão de QA inteira (motor, container, orçamento) — não existe, hoje,
// nenhum teste neste repositório que faça isso; todos os `*-real-seam` param
// exatamente neste ponto.

function hashDe(mensagem: string): string {
  return createHash('sha256').update(mensagem).digest('hex').slice(0, 16)
}

const PERGUNTA_ESCALADA = 'Isto é decisão de preço — decido sozinho?'

const PROJETO = {
  id: 'proj_supor',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: null,
  runtimeConfig: null,
  isActive: true,
} as const

const JULES_API = 'https://jules.googleapis.com/v1alpha'

function sessaoEscalada(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess_escalada',
    projectId: PROJETO.id,
    issueNumber: 91,
    sessionName: 'sessions/escalada-91',
    state: 'AWAITING_USER_FEEDBACK',
    answeredHash: `escalada:0:${hashDe(PERGUNTA_ESCALADA)}`,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    // 25h sem avançar: passou do prazo de 24h (HORAS_ATE_TIMEOUT_PERGUNTA_MS).
    lastProgressAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    closedAt: null,
    ...overrides,
  }
}

/**
 * `mission.count` é o PRIMEIRO ponto, dentro de `triggerAgentMission` ->
 * `runTrigger`, onde a decisão de disparo é observável sem precisar montar
 * toda a máquina de execução de missão (motor, container, orçamento). Fazer
 * a contagem devolver um valor acima do teto força a resposta `busy` — o
 * disparo já ficou provado (a chamada aconteceu), sem o teste precisar
 * simular uma missão de QA inteira.
 */
function buildFakePrisma(sessoesDoProjeto: unknown[]) {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  const missionCountCalls: unknown[] = []
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async (args: unknown) => {
        missionCountCalls.push(args)
        return 99 // força 'busy' em runTrigger — prova o disparo sem executar a missão
      }),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(
        async (args: {
          where?: { mergeCommitSha?: unknown; projectId?: unknown }
          distinct?: unknown
        }) => {
          if (args?.where?.mergeCommitSha) return []
          if (args?.distinct) return [{ projectId: PROJETO.id }]
          // `devolverVagasDeSessaoAbandonada` (dev-session-store.ts
          // `linhasVivasParaJulgarAbandono`) roda a CADA tique, GLOBAL (sem
          // `projectId` no `where`), e antes do conserto reclamava a vaga de
          // QUALQUER sessão parada há 12h+ em `AWAITING_USER_FEEDBACK` —
          // inclusive a escalada que este arquivo testa (25h > 12h). SEM
          // isolamento agora: a mesma sessão real (`sessoesDoProjeto`) é
          // devolvida também para esta consulta global — é o conserto de
          // `sessao-abandonada.ts` (escalada: pausa o relógio) que garante
          // ela não ser fechada, não mais um mock que escondia o watchdog.
          // A varredura do CICLO TERMINAL (`linhasVivasParaCicloTerminal`)
          // usa a MESMA forma de `where` (`{ closedAt: null }`, sem
          // `projectId`) e cai neste mesmo ramo — inofensivo aqui porque ela
          // filtra por `ehTerminal(state)` antes de tocar a linha, e a
          // sessão deste teste está em AWAITING_USER_FEEDBACK.
          return sessoesDoProjeto
        }
      ),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    _updateCalls: updateCalls,
    _missionCountCalls: missionCountCalls,
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

describe('dúvida escalada + 24h em silêncio: a vigia dispara o MESMO trilho de missão de QA (real seam, L4-T4/D64)', () => {
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
    process.env['JULES_API_KEY'] = 'jules-key-de-teste'
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

  test('sessão escalada há 25h: a vigia acorda o QA (mesmo ponto de entrada de suporDuvidaPendente) e NUNCA fecha a sessão', async () => {
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u === `${JULES_API}/sessions/escalada-91`) {
        return new Response(
          JSON.stringify({
            state: 'AWAITING_USER_FEEDBACK',
            outputs: [],
            updateTime: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          }),
          { status: 200 }
        )
      }
      if (u.startsWith(`${JULES_API}/sessions/escalada-91/activities`)) {
        return new Response(
          JSON.stringify({
            activities: [
              {
                originator: 'agent',
                createTime: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
                agentMessaged: { agentMessage: PERGUNTA_ESCALADA },
              },
            ],
          }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma([sessaoEscalada()])
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Prova positiva: o disparo (triggerAgentMission -> runTrigger ->
    // mission.count) de fato aconteceu para o papel 'qa' — o MESMO ponto de
    // entrada de onde `responderDuvidaPendente`/`suporDuvidaPendente` rodam
    // dentro de `executeMissionWithFailover`.
    await vi.waitFor(
      () => {
        expect(prisma._missionCountCalls.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    // NUNCA fecha a sessão por conta da escalada: `escalada:` não é
    // `respondida:` — ninguém respondeu ainda. Nenhuma escrita fecha
    // `closedAt` para esta sessão.
    const fechouASessao = prisma._updateCalls.some(
      (c) =>
        (c.where as { sessionName?: string }).sessionName === 'sessions/escalada-91' &&
        c.data['closedAt'] !== undefined
    )
    expect(fechouASessao).toBe(false)
  })
})
