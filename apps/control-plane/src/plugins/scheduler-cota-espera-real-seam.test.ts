import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { BuildAgentMissionInput, RuntimeExecutionResult } from '@gitorch/agents'

// DJ-T4 (10/09/2026) — "não tem cota? tudo bem, aguarda. Sem falha, sem
// mensagem." Antes desta tarefa, quando TODOS os degraus da cadeia (chain
// padrão codex > antigravity > claude) esgotavam a cota, `executeMissionWithFailover`
// (scheduler.ts) gravava a missão 'failed' e a agenda a redisparava minutos
// depois — 244 missões de QA 'failed' em 24h, sem nenhum trabalho feito, só
// porque nenhum motor tinha cota naquele minuto.
//
// Real seam (mesmo padrão de scheduler-aviso-credencial-real-seam.test.ts):
// registra o schedulerPlugin de VERDADE e dispara pelo único ponto de entrada
// real (app.triggerAgentMission) — daí em diante é 100% código de produção:
// runTrigger -> executeMissionWithFailover -> caminho clássico ->
// AgentOrchestrator.runMission (mockado para REJEITAR com o texto real do
// provedor, em vez de retornar exitCode) -> catch -> isEngineFault ->
// ehTetoDeUsoDaConta -> parseHorarioDeVoltaDaCota -> decisão de
// waiting/failed. Nada disso é reimplementado aqui.
const resultadoDoMotor = vi.hoisted(() => ({
  /** Texto do erro a LANÇAR para aquele runtime (simula o motor sem cota). */
  erroPorRuntime: null as Record<string, string> | null,
  /** Resultado de SUCESSO para aquele runtime, quando não deve lançar. */
  sucessoPorRuntime: null as Record<string, RuntimeExecutionResult> | null,
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    AgentOrchestrator: class {
      constructor(_options: unknown) {}
      async runMission(input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
        const runtime = input.runtime?.runtime as string
        const erro = resultadoDoMotor.erroPorRuntime?.[runtime]
        if (erro) throw new Error(erro)
        const sucesso = resultadoDoMotor.sucessoPorRuntime?.[runtime]
        if (sucesso) return sucesso
        throw new Error(`teste não configurou runtime ${runtime}`)
      }
    },
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

// Saídas LITERAIS medidas em produção (10/09/2026).
const ANTIGRAVITY_SEM_COTA_2H =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h0m0s.'
const CODEX_SEM_COTA_8H =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 8h0m0s.'
const CLAUDE_SEM_COTA_5H =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 5h0m0s.'
const ERRO_NAO_E_COTA = '401 Unauthorized: token invalid for this engine'

const RELATORIO_REAL =
  '## Revisão de QA\n\n' +
  'Testei o PR #42 ponta a ponta: build verde, testes passando, sem regressão.\n\n' +
  '### Veredito\n\nAprovado para merge.'

interface FakeMission {
  id: string
  projectId: string
  type: string
  status: string
  payload: Record<string, unknown>
  waitingStatus: string | null
  waitingReason: string | null
}

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  devPlan: null,
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
} as const

function buildFakePrisma() {
  let counter = 0
  const missions: FakeMission[] = []
  return {
    _missions: missions,
    mission: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: { projectId: string; type: string; status: string; payload: unknown }
        }) => {
          counter += 1
          missions.push({
            id: `mission_${counter}`,
            projectId: data.projectId,
            type: data.type,
            status: data.status,
            payload: (data.payload ?? {}) as Record<string, unknown>,
            waitingStatus: null,
            waitingReason: null,
          })
          return { id: `mission_${counter}` }
        }
      ),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { projectId?: string; type?: string; status?: string; waitingReason?: string }
        }) => {
          const found = missions.find(
            (m) =>
              (where.projectId === undefined || m.projectId === where.projectId) &&
              (where.type === undefined || m.type === where.type) &&
              (where.status === undefined || m.status === where.status) &&
              (where.waitingReason === undefined || m.waitingReason === where.waitingReason)
          )
          return found ? { id: found.id } : null
        }
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { status?: string; waitingReason?: string; waitingStatus?: { lte: string } }
        }) => {
          return missions
            .filter((m) => {
              if (where.status !== undefined && m.status !== where.status) return false
              if (where.waitingReason !== undefined && m.waitingReason !== where.waitingReason)
                return false
              if (where.waitingStatus?.lte !== undefined) {
                if (!m.waitingStatus || m.waitingStatus > where.waitingStatus.lte) return false
              }
              return true
            })
            .map((m) => ({ id: m.id, projectId: m.projectId, type: m.type, payload: m.payload }))
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = missions.find((x) => x.id === where.id)
        return m ? { payload: m.payload } : null
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string }
          data: Record<string, unknown>
        }) => {
          let count = 0
          for (const m of missions) {
            if (m.id !== where.id) continue
            if (where.status !== undefined && m.status !== where.status) continue
            Object.assign(m, data)
            count += 1
          }
          return { count }
        }
      ),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => ({ motoresEsgotadosAvisadoEm: null })),
      update: vi.fn(async () => ({})),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      count: vi.fn(async () => 0),
    },
  }
}

const ENV_KEYS = [
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'GITORCH_TELEGRAM_CHAT_ID',
  'TELEGRAM_CHAT_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_GITHUB_TOKEN',
]

describe('DJ-T4 — cadeia inteira sem cota: a missão dorme, não falha, e não avisa', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const originalFetch = global.fetch

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
    // Sem GITHUB_APP_ID/PRIVATE_KEY nem GITORCH_GITHUB_TOKEN: nenhum papel
    // monta board/token — todos caem garantidamente no caminho CLÁSSICO,
    // exatamente como o real seam de credencial expirada já usa.
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
    resultadoDoMotor.erroPorRuntime = null
    resultadoDoMotor.sucessoPorRuntime = null
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  test('TODOS os degraus (codex, antigravity, claude) sem cota: missão vira waiting com o MENOR horário entre os três, sem falha e sem aviso', async () => {
    resultadoDoMotor.erroPorRuntime = {
      codex: CODEX_SEM_COTA_8H,
      antigravity: ANTIGRAVITY_SEM_COTA_2H,
      claude: CLAUDE_SEM_COTA_5H,
    }
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const antes = Date.now()
    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)
    const missionId = resultado.missionId as string

    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('waiting')
      },
      { timeout: 2000 }
    )

    const missao = prisma._missions.find((x) => x.id === missionId)
    expect(missao?.waitingReason).toBe('cota-dos-motores')
    // O MENOR horário entre os três (antigravity, 2h) — nunca o do último
    // degrau tentado (claude, 5h) nem o do primeiro (codex, 8h).
    const esperado2h = antes + 2 * 60 * 60_000
    const gravado = new Date(missao?.waitingStatus as string).getTime()
    expect(gravado).toBeGreaterThanOrEqual(esperado2h - 2000)
    expect(gravado).toBeLessThanOrEqual(esperado2h + 5000)

    // Sem falha. E, especificamente, SEM o resumo EXECUTIVO de "motores
    // esgotados" que existia antes desta tarefa (recadoDeMotoresEsgotados) —
    // é exatamente essa mensagem que o silêncio do dono substitui: o time
    // não fica mais sabendo que "a esteira parou", porque ela não parou.
    //
    // Ajuste DJ-T4 (decisão D76, literal): "não tem cota? tudo bem, aguarda.
    // Eu sei que está sem cota" e "não quero ficar recebendo... se eu
    // precisar ver como estão as coisas eu acesso o painel". O achado
    // registrado aqui antes (o aviso POR MOTOR `recadoDeTetoDeUso`, #511,
    // ainda saindo a cada degrau que bate no teto) foi corrigido nesta
    // rodada: nenhuma mensagem sai para NENHUM motor desta cadeia, mesmo
    // cada um batendo no teto individualmente. O fato continua em log e
    // visível pelo painel via o estado 'waiting' da missão, verificado acima.
    expect(missao?.status).not.toBe('failed')
    const chamadasDeFetch = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(
      chamadasDeFetch.filter((c) => c[0].startsWith('https://api.telegram.org/'))
    ).toHaveLength(0)

    // A cadeia original fica gravada para a retomada reconstruir o caminho.
    const cotaEspera = missao?.payload['cotaEspera'] as { chainOriginal?: unknown[] } | undefined
    expect(cotaEspera?.chainOriginal?.length).toBe(3)

    await app.close()
  })

  test('só o PRIMEIRO degrau sem cota: o failover troca de motor e a missão completa normalmente', async () => {
    resultadoDoMotor.erroPorRuntime = { codex: CODEX_SEM_COTA_8H }
    resultadoDoMotor.sucessoPorRuntime = {
      antigravity: {
        missionId: 'irrelevante-aqui',
        runtime: 'antigravity',
        exitCode: 0,
        durationMs: 1,
        output: RELATORIO_REAL,
        stderr: '',
      },
    }
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    const missionId = resultado.missionId as string

    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('completed')
      },
      { timeout: 2000 }
    )
    const missao = prisma._missions.find((x) => x.id === missionId)
    expect(missao?.waitingReason).toBeFalsy()

    await app.close()
  })

  test('erro que NÃO é de cota em todos os degraus: continua virando failed, como hoje', async () => {
    resultadoDoMotor.erroPorRuntime = {
      codex: ERRO_NAO_E_COTA,
      antigravity: ERRO_NAO_E_COTA,
      claude: ERRO_NAO_E_COTA,
    }
    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    const missionId = resultado.missionId as string

    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('failed')
      },
      { timeout: 2000 }
    )
    const missao = prisma._missions.find((x) => x.id === missionId)
    expect(missao?.waitingReason).toBeFalsy()

    await app.close()
  })

  test('cascata MISTA (cota + outro motivo de motor): continua falhando como hoje, mas DJ-T4 (D76) desligou o aviso', async () => {
    resultadoDoMotor.erroPorRuntime = {
      codex: CODEX_SEM_COTA_8H,
      antigravity: ERRO_NAO_E_COTA,
      claude: CLAUDE_SEM_COTA_5H,
    }
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    const missionId = resultado.missionId as string

    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('failed')
      },
      { timeout: 2000 }
    )
    // DJ-T4 (decisão D76, literal): mista ou 100% cota, não importa — pelo
    // menos um motor desta cadeia bateu no teto de uso, então nenhuma
    // mensagem sai ao dono. Antes desta tarefa o resumo executivo
    // (`recadoDeMotoresEsgotados`) ainda saía aqui (#511/#513/L4-T22); esta
    // rodada desligou também esse caso. O desfecho da MISSÃO (failed) não
    // muda — só o envio.
    //
    // Tempo de sobra para qualquer chamada de rede terminar de sair antes de
    // provar que nenhuma saiu.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fetchMock).not.toHaveBeenCalled()

    await app.close()
  })

  test('não duplica: enquanto a missão esperando cota existe, a agenda não cria outra do mesmo papel+projeto', async () => {
    resultadoDoMotor.erroPorRuntime = {
      codex: CODEX_SEM_COTA_8H,
      antigravity: ANTIGRAVITY_SEM_COTA_2H,
      claude: CLAUDE_SEM_COTA_5H,
    }
    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const primeiro = await app.triggerAgentMission('qa', 'proj_1')
    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === primeiro.missionId)
        expect(m?.status).toBe('waiting')
      },
      { timeout: 2000 }
    )

    const segundo = await app.triggerAgentMission('qa', 'proj_1')
    expect(segundo.triggered).toBe(false)
    expect(segundo.reason).toBe('cota-esperando')
    expect(prisma._missions).toHaveLength(1)

    await app.close()
  })

  test('retomada: horário vencido é redisparado e completa; horário futuro fica esperando', async () => {
    resultadoDoMotor.erroPorRuntime = {
      codex: CODEX_SEM_COTA_8H,
      antigravity: ANTIGRAVITY_SEM_COTA_2H,
      claude: CLAUDE_SEM_COTA_5H,
    }
    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    const missionId = resultado.missionId as string
    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('waiting')
      },
      { timeout: 2000 }
    )

    // Horário ainda não chegou: a retomada não mexe na missão.
    await app.retomarMissoesEsperandoCota()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prisma._missions.find((x) => x.id === missionId)?.status).toBe('waiting')

    // Agora todos os motores respondem sucesso — o horário "vence" porque
    // forçamos o waitingStatus gravado para o passado (equivalente a esperar
    // de verdade, sem sleep de horas no teste).
    const missao = prisma._missions.find((x) => x.id === missionId)
    if (missao) missao.waitingStatus = new Date(Date.now() - 1000).toISOString()
    resultadoDoMotor.erroPorRuntime = null
    resultadoDoMotor.sucessoPorRuntime = {
      codex: {
        missionId: 'irrelevante-aqui',
        runtime: 'codex',
        exitCode: 0,
        durationMs: 1,
        output: RELATORIO_REAL,
        stderr: '',
      },
    }

    await app.retomarMissoesEsperandoCota()
    await vi.waitFor(
      () => {
        const m = prisma._missions.find((x) => x.id === missionId)
        expect(m?.status).toBe('completed')
      },
      { timeout: 2000 }
    )
    // MESMA missão, nunca uma segunda linha — "redisparada pelo mesmo caminho".
    expect(prisma._missions).toHaveLength(1)

    await app.close()
  })
})
