import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Tarefa 19 — defeito confirmado: `sessoesVivas` (dev-session-store.ts) só
// filtra por `closedAt: null`, então uma sessão já mesclada (Tarefa 17 grava
// `mergeCommitSha` e NÃO fecha mais a linha no merge — quem fecha agora é
// `varrerPublicacoes`, quando há veredito de publicação) continuava sendo
// devolvida para `varrerSessoesDoDev`/`vigiarSessoes`, a vigia PRÉ-merge. Com
// `stateCheckedAt` fora da cadência de dez minutos, ela interrogava
// `consultarSessaoJules` de novo — e um `COMPLETED` com PR disparava `julgar`
// (missão de QA) contra um pull request que já tinha sido mesclado.
//
// O reparo (`sessoesParaVigiaPreMerge`, scheduler.ts) fica no CONSUMIDOR
// pré-merge, não em `sessoesVivas`: o OUTRO chamador de `sessoesVivas`
// (`montarOpcoesDeDelegacao`, a fila de delegação do SM) precisa continuar
// contando sessão mesclada como ocupada, senão o SM re-delegaria a mesma
// issue enquanto o veredito de publicação ainda está em aberto.
//
// Este arquivo prova que o filtro está de fato LIGADO no ponto real de
// wiring — mesmo "real seam" de `scheduler-pos-merge-real-seam.test.ts` e
// `scheduler-boot-reaper.test.ts` (describe "real seam"): registra o
// `schedulerPlugin` de VERDADE, força `NODE_ENV` para fora de 'test' só no
// registro do plugin, e usa `GITORCH_SCHEDULER_TICK_MS` minúsculo para o
// próprio `setInterval` de produção disparar `tick` -> `varrerSessoesDoDev`
// -> `sessoesVivas` -> `sessoesParaVigiaPreMerge` -> `vigiarSessoes`. Nada de
// `tick`/`vigiarSessoes` reimplementado.
//
// `varrerPublicacoes` fica inerte neste arquivo (routing do `where` do mock,
// igual ao dos outros dois real-seam) porque o que se prova aqui é só o lado
// PRÉ-merge — o pós-merge já tem cobertura própria.
const PROJETO = {
  id: 'proj_19',
  wingId: 'acme/api',
  name: 'Acme API',
  // null de propósito: sem dono, `resolveNotifyChatId` devolve null sem
  // consultar `telegramLink`, e o orçamento/plano de `runTrigger` nunca entra
  // no caminho — o que este teste precisa provar pára bem antes disso (ver
  // `mission.count` no fakePrisma).
  userId: null,
  runtimeConfig: null,
  isActive: true,
} as const

const JULES_API = 'https://jules.googleapis.com/v1alpha'

const SESSAO_MESCLADA = {
  id: 'sess_mesclada',
  projectId: PROJETO.id,
  issueNumber: 19,
  sessionName: 'sessions/mesclada-19',
  state: 'COMPLETED',
  answeredHash: null,
  pullRequestNumber: 42,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  // null: sem isto a cadência de dez minutos (CADENCIA_DE_EXAME_MS) poderia
  // mascarar o defeito por acaso — com null, TODO tick que a vigia enxergar
  // esta linha vai examiná-la de novo.
  stateCheckedAt: null,
  reworkNoticePending: null,
  reworkNoticeAttempts: 0,
  pendingSince: null,
  mergeCommitSha: 'deadbeef19',
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
} as const

const SESSAO_ABERTA = {
  id: 'sess_aberta',
  projectId: PROJETO.id,
  issueNumber: 20,
  sessionName: 'sessions/aberta-20',
  state: 'IN_PROGRESS',
  answeredHash: null,
  pullRequestNumber: null,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
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
} as const

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
      updateMany: vi.fn(async () => ({ count: 0 })), // failStuckMissions: nada travado
      findMany: vi.fn(async () => []), // processSetupMissions: nada pendente
      count: vi.fn(async (args: unknown) => {
        missionCountCalls.push(args)
        return 99 // força 'busy' em runTrigger — prova o disparo sem executar a missão
      }),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO), // varrerSessoesDoDev: dono da sessão
      // reconferirAcessoDoRelogio: sem projetos, o laço nunca entra —
      // nenhuma prova de escrita é tentada (mesmo padrão de
      // scheduler-pos-merge-real-seam.test.ts).
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(
        async (args: { where?: { mergeCommitSha?: unknown }; distinct?: unknown }) => {
          if (args?.where?.mergeCommitSha) return [] // varrerPublicacoes: inerte neste arquivo
          if (args?.distinct) return [{ projectId: PROJETO.id }] // projetosComSessao
          return sessoesDoProjeto // sessoesVivas(): a fixture do cenário
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

describe('vigia pré-merge (varrerSessoesDoDev) wiring em schedulerPlugin (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    // Fora de 'test': é o guard que deixa o `setInterval` real do relógio
    // nascer — mesmo padrão de scheduler-pos-merge-real-seam.test.ts e
    // scheduler-boot-reaper.test.ts.
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    // Com a chave presente, `consultarSessaoJules` faz a chamada de verdade
    // (sem ela, devolve null ANTES de tocar rede — e o teste provaria menos
    // do que promete: nunca saberíamos se o filtro barrou a chamada ou se
    // simplesmente não havia chave).
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

  test('(b) sessão já mesclada: a vigia pré-merge NUNCA consulta o Jules nem dispara missão contra ela', async () => {
    const fetchMock = vi.fn(async () => {
      // Só existe para provar que, SE fosse chamada (defeito reintroduzido),
      // a resposta não quebraria o teste por outro motivo — não deveria ser
      // atingida para a sessão mesclada.
      return new Response(JSON.stringify({ state: 'COMPLETED', outputs: [], updateTime: null }), {
        status: 200,
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma([SESSAO_MESCLADA])
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Espera VÁRIOS ciclos de tick terem alcançado o laço por-projeto (prova
    // positiva de que a vigia rodou de verdade, repetidas vezes — não é só
    // um tick que não deu tempo de chegar lá).
    await vi.waitFor(
      () => {
        expect(
          (prisma.project.findUnique as ReturnType<typeof vi.fn>).mock.calls.length
        ).toBeGreaterThanOrEqual(3)
      },
      { timeout: 3000, interval: 10 }
    )

    // Nenhuma chamada de rede — nem para o Jules, nem para nada: a sessão
    // mesclada nunca chega a `consultarSessao` porque `vigiarSessoes` recebe
    // lista vazia (filtrada) e retorna cedo ("nenhuma sessão viva").
    expect(fetchMock).not.toHaveBeenCalled()
    expect(prisma._missionCountCalls).toHaveLength(0)
    expect(
      prisma._updateCalls.some(
        (c) =>
          c.where &&
          (c.where as { sessionName?: string }).sessionName === SESSAO_MESCLADA.sessionName
      )
    ).toBe(false)
  })

  test('(c) sessão ainda não mesclada: continua examinada normalmente (COMPLETED+PR dispara julgar, sem regressão)', async () => {
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u === `${JULES_API}/${SESSAO_ABERTA.sessionName}`) {
        return new Response(
          JSON.stringify({
            state: 'COMPLETED',
            outputs: [{ pullRequest: { url: 'https://github.com/acme/api/pull/42' } }],
            updateTime: '2026-08-16T00:00:00.000Z',
          }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma([SESSAO_ABERTA])
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Prova positiva: o disparo de missão (triggerAgentMission -> runTrigger
    // -> mission.count) de fato aconteceu para a sessão ainda não mesclada —
    // o caminho normal não regrediu com a introdução do filtro.
    await vi.waitFor(
      () => {
        expect(prisma._missionCountCalls.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    const urlsChamadas = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urlsChamadas).toContain(`${JULES_API}/${SESSAO_ABERTA.sessionName}`)

    // `julgar` grava o PR capturado antes de disparar a missão de QA
    // (vigiarSessoes, ramo 'julgar') — prova de que a decisão real
    // (`decidirRespostaDaSessao`) rodou até o fim, não só que alguma chamada
    // de rede aconteceu.
    const chamadaDePr = prisma._updateCalls.find(
      (c) =>
        (c.where as { sessionName?: string }).sessionName === SESSAO_ABERTA.sessionName &&
        c.data['pullRequestNumber'] !== undefined
    )
    expect(chamadaDePr?.data).toMatchObject({ pullRequestNumber: 42 })
  })
})
