import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { BuildAgentMissionInput, RuntimeExecutionResult } from '@gitorch/agents'

// DJ-T3: o SM roda com TODOS os motores sem cota, porque `runSmDelegation` é
// 100% determinístico (delega pela etiqueta do GitHub, nenhum passo de LLM) —
// ele nunca gasta a quota do motor primário do projeto. Antes deste conserto,
// `runTrigger` checava `canRunMission` (spend-guard.ts) contra a quota do
// `primary.runtime` para TODO papel, `sm` incluído: um cliente com o motor
// primário em quota crítica via a esteira inteira travar exatamente no papel
// que mais precisava rodar (a vaga liberada — DJ-T3 acorda o SM por evento —
// nunca conseguiria disparar).
//
// Este teste prende o caminho REAL (`app.triggerAgentMission` → `runTrigger`),
// não uma reimplementação — mesmo padrão de `scheduler-teto-acordada-vazia.test.ts`.
vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    AgentOrchestrator: class {
      constructor(_options: unknown) {}
      async runMission(_input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
        return {
          missionId: 'irrelevante',
          runtime: 'antigravity',
          exitCode: 0,
          durationMs: 1,
          output: 'saída qualquer',
          stderr: '',
        }
      }
    },
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const PLANO = { id: 'plan_pro', maxMissionsPerDay: 90, features: {}, tierRank: 1 } as const

function buildProjeto() {
  return {
    id: 'proj_1',
    wingId: 'acme/api',
    name: 'Acme API',
    userId: 'user_1',
    runtimeConfig: null,
    devPlan: null,
    accessSuspendedAt: null,
    accessSuspendedReason: null,
    isActive: true,
    user: { id: 'user_1', plan: PLANO },
  }
}

/**
 * Motor primário do projeto em quota CRÍTICA — `quotaHealth` (spend-guard.ts)
 * classifica `remaining <= 0` como crítico não importa o total.
 */
function buildFakePrisma() {
  const missionsCreated: Array<Record<string, unknown>> = []
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      // Nenhuma missão ativa nem histórico do dia — o teste é só sobre a
      // guarda de gasto, não sobre os tetos diários (já cobertos em
      // scheduler-teto-acordada-vazia.test.ts).
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { tokensUsed: 0 } })),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        missionsCreated.push(args.data)
        return { id: `mission_${missionsCreated.length}` }
      }),
      findMany: vi.fn(async () => []),
    },
    project: {
      findFirst: vi.fn(async () => buildProjeto()),
    },
    engineConnection: {
      // Sem prova de vida nenhuma — cadeia de motores cai no default, mas o
      // que importa aqui é a quota do PRIMÁRIO, lida logo abaixo.
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async (_args?: { select?: { quotaRemaining?: unknown } }) => ({
        quotaRemaining: 0,
        quotaTotal: 1000,
      })),
    },
    telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
    missionsCreated,
  }
}

async function disparar(role: 'ra' | 'sm', fake: ReturnType<typeof buildFakePrisma>) {
  const app = Fastify({ logger: false })
  app.decorate('prisma', fake as never)
  await app.register(schedulerPlugin)
  return app.triggerAgentMission(role, 'proj_1')
}

const ENV_KEYS = ['GITORCH_GITHUB_TOKEN', 'GITORCH_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']

describe('DJ-T3: SM roda sem motor (cota crítica não bloqueia missão determinística)', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
    }
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    vi.restoreAllMocks()
  })

  test('papel que USA motor (ra) é barrado pela quota crítica do primário', async () => {
    const fake = buildFakePrisma()

    const resultado = await disparar('ra', fake)

    expect(resultado.triggered).toBe(false)
    expect(resultado.reason).toBe('engine-quota-critical')
  })

  test('SM (determinístico, sem passo de LLM) dispara mesmo com o motor primário em cota crítica', async () => {
    const fake = buildFakePrisma()

    const resultado = await disparar('sm', fake)

    expect(resultado.triggered).toBe(true)
    expect(resultado.reason).toBeUndefined()
  })

  test('SM SEM trilhos (sem GITORCH_GITHUB_TOKEN e sem App instalado) é barrado pela quota crítica, como os outros papéis', async () => {
    // Sem railsToken o SM cai no caminho clássico (`else` de
    // `executeMissionWithFailover`), que chama o motor de verdade — não pode
    // ficar de fora da guarda de gasto nesse caso, senão gastaria a quota do
    // cliente sem checar nada.
    delete process.env['GITORCH_GITHUB_TOKEN']
    delete process.env['GITHUB_APP_ID']
    delete process.env['GITHUB_APP_PRIVATE_KEY']
    const fake = buildFakePrisma()

    const resultado = await disparar('sm', fake)

    expect(resultado.triggered).toBe(false)
    expect(resultado.reason).toBe('engine-quota-critical')
  })

  test('SM disparado NÃO consulta a quota do motor (a guarda de gasto é pulada, não só ignorada no resultado)', async () => {
    // `engineConnection.findFirst` também é chamado por outros caminhos (ex.:
    // catálogo de modelos, `select: { models: true }`) — o que importa aqui é
    // que NENHUMA chamada pede especificamente a quota (`quotaRemaining`),
    // que é a consulta da guarda de gasto (spend-guard.ts) pulada para o SM.
    const fake = buildFakePrisma()

    await disparar('sm', fake)

    const consultouQuota = fake.engineConnection.findFirst.mock.calls.some((c) =>
      Boolean(c[0]?.select?.quotaRemaining)
    )
    expect(consultouQuota).toBe(false)
  })
})
