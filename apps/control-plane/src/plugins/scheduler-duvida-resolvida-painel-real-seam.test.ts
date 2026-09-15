import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '@gitorch/agents'

// Achado do QA (score 70) na task a8e667c8 (DJ-T15/D76): a mensagem "...já
// respondeu — nada bloqueado" (scheduler.ts, dentro de `responderDuvidaPendente`,
// bloco `saiu && devoAvisarDonoDeBloqueioResolvido(politica)`) continuava
// passando por `avisarDonoDoProjeto` sem bater nenhum padrão de
// `classificarAviso` (classe-do-aviso.ts) — nenhuma das 4 frases de rotina
// reconhecidas por regex casa este texto — e caía no default 'executivo',
// vazando para o Telegram. É status/andamento puro pela letra do D76: o dev
// JÁ foi respondido antes desta linha rodar (nunca bloqueante), o aviso é só
// para o dono acompanhar. Este arquivo é o "real seam" (mesmo padrão de
// scheduler-aviso-credencial-real-seam.test.ts e
// scheduler-duvida-cota-cascata-real-seam.test.ts): registra o
// schedulerPlugin de VERDADE e dispara pelo ÚNICO ponto de entrada real
// (app.triggerAgentMission) — daí em diante é 100% código de produção:
// runTrigger -> executeMissionWithFailover -> ramo qaRails ->
// responderDuvidaPendente -> runDuvidaMissionViaRails (resposta direta, sem
// RA) -> responderSessaoJules (sucesso) -> o bloco corrigido ->
// registrarStatusNoPainel -> registrarNoPainelUmaVez -> prisma.event. Nada
// disso é reimplementado aqui.
//
// Só `createCliRuntimeAdapter` é substituído (para não depender de um
// binário de CLI de verdade) — o mesmo seam de
// scheduler-duvida-cota-cascata-real-seam.test.ts, porque `responderDuvidaPendente`
// mora no ramo de TRILHOS (`qaRails`), que nunca passa pelo
// `AgentOrchestrator` clássico.
const resultadoDoMotor = vi.hoisted(() => ({
  porRuntime: null as Record<string, RuntimeExecutionResult> | null,
  chamadas: [] as string[],
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    createCliRuntimeAdapter: (options: { runtime: string }) => ({
      runtime: options.runtime,
      async run(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
        const runtime = request.runtime.runtime
        resultadoDoMotor.chamadas.push(runtime)
        const doMotor = resultadoDoMotor.porRuntime?.[runtime]
        if (!doMotor) {
          throw new Error(`teste não configurou resultadoDoMotor.porRuntime para ${runtime}`)
        }
        return doMotor
      },
    }),
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const PERGUNTA_DO_DEV =
  'Should I reuse the existing retry helper, or is a new one expected for this task?'

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  // D76/ESTEIRA-T14: só 'tudo'/'executivo-e-tecnico-bloqueante' disparam o
  // aviso de bloqueio resolvido (devoAvisarDonoDeBloqueioResolvido) — o
  // default 'so-executivo' NUNCA chega a este bloco. Precisa estar ligado
  // para o cenário deste arquivo existir.
  runtimeConfig: { perguntasAoDono: 'tudo' },
  devPlan: null,
  autonomia: null,
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
} as const

const SESSAO_DUVIDA = {
  sessionName: 'sessions/duvida-1',
  issueNumber: 55,
  answeredHash: null as string | null,
  stateCheckedAt: null as Date | null,
}

function buildFakePrisma() {
  let missionCounter = 0
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => {
        missionCounter += 1
        return { id: `mission_${missionCounter}` }
      }),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => PROJETO),
    },
    telegramLink: {
      // Vínculo REAL e ligado: se o código ainda mandasse isto para o
      // Telegram, `resolveNotifyChatId` acharia um chat de verdade e o
      // `fetch` para api.telegram.org aconteceria — é isto que faz a
      // asserção negativa (`fetchMock não chamado`) provar algo, em vez de
      // passar por acidente por falta de canal configurado.
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    devSession: {
      findMany: vi.fn(async () => [SESSAO_DUVIDA]),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    // DJ-T15 (D76): o aviso agora é `registrarNoPainelUmaVez`
    // (registro-no-painel.ts) — `findFirst` nulo simula "nunca registrado
    // antes desta chave".
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'evt_1' })),
    },
  }
}

function fetchRoteado(pergunta: string) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/activities')) {
      return new Response(
        JSON.stringify({
          activities: [
            {
              originator: 'agent',
              createTime: new Date().toISOString(),
              agentMessaged: { agentMessage: pergunta },
            },
          ],
        }),
        { status: 200 }
      )
    }
    let hostReal = ''
    try {
      hostReal = new URL(u).hostname
    } catch {
      hostReal = ''
    }
    if (hostReal === 'api.github.com' && u.includes('/pulls')) {
      return new Response('[]', { status: 200 })
    }
    // Telegram sendMessage e qualquer outra chamada (ex.: Jules :sendMessage
    // no cenário de sucesso) — 200 genérico basta para os dois.
    return new Response('{"ok":true}', { status: 200 })
  })
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'JULES_API_KEY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'GITORCH_TELEGRAM_CHAT_ID',
  'TELEGRAM_CHAT_ID',
  'GITORCH_OWNER_EMAIL',
]

describe('dúvida do dev resolvida pelo QA/RA — o aviso "nada bloqueado" vai para o painel, nunca para o Telegram (task a8e667c8, achado do QA)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    // GITORCH_GITHUB_TOKEN presente: `qaRails` fica true (role 'qa' cai no
    // ramo de trilhos, onde `responderDuvidaPendente` roda).
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['JULES_API_KEY'] = 'jules-key-de-teste'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
    resultadoDoMotor.porRuntime = null
    resultadoDoMotor.chamadas = []
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

  test('QA responde a dúvida sozinho (precisaDoDono: false), política "tudo": o aviso de bloqueio resolvido vai para prisma.event (painel), nunca para fetch (Telegram)', async () => {
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 0,
        durationMs: 1,
        // Resposta técnica válida (RAILS_SCHEMAS.devQuestion): precisaDoDono
        // falso -> destino 'responder-o-dev', sem RA, sem escalar ao dono.
        output: JSON.stringify({
          precisaDoDono: false,
          resposta:
            'Reuse the retry helper already defined in apps/control-plane/src/services/rails-runner.ts (runFormStep) instead of writing a new one.',
        }),
        stderr: '',
      },
    }
    const fetchMock = fetchRoteado(PERGUNTA_DO_DEV)
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma()
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // Prova positiva: o aviso "nada bloqueado" foi gravado na timeline do
    // painel (prisma.event, type 'audit').
    await vi.waitFor(
      () => {
        expect(prisma.event.create).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 10 }
    )

    const chamada = prisma.event.create.mock.calls[0] as unknown as [
      { data: { projectId: string; type: string; payload: { texto: string; chave: string } } },
    ]
    const { data } = chamada[0]
    expect(data.projectId).toBe('proj_1')
    expect(data.type).toBe('audit')
    expect(data.payload.texto).toContain('nada bloqueado')
    expect(data.payload.texto).toContain('#55')
    expect(data.payload.texto).toContain('acme/api')
    expect(data.payload.texto).toContain('o QA')
    expect(typeof data.payload.chave).toBe('string')
    expect(data.payload.chave.length).toBeGreaterThan(0)

    // Tempo de sobra para qualquer chamada tardia terminar de sair.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Prova negativa: nenhuma chamada a api.telegram.org carregou este
    // texto — o vazamento que o QA achou está fechado.
    const mensagensDeTelegram = fetchMock.mock.calls
      .filter((c) => String(c[0]).startsWith('https://api.telegram.org/'))
      .map((c) => {
        try {
          return (JSON.parse(String((c[1] as RequestInit).body)) as { text: string }).text
        } catch {
          return ''
        }
      })
    const vazouParaOTelegram = mensagensDeTelegram.some((t) => t.includes('nada bloqueado'))
    expect(vazouParaOTelegram).toBe(false)
  })
})
