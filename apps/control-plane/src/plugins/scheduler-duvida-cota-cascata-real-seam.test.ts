import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '@gitorch/agents'

// L4-T22 — "Ligue o caminho da dúvida à cascata que já existe".
//
// ANTES desta tarefa, o motor sem cota respondendo à dúvida do dev
// (`responderDuvidaPendente`, scheduler.ts) era um beco sem saída: o catch
// interno via a falha, devolvia a reserva e RETORNAVA em silêncio — nunca
// relançava. O call site (dentro de `executeMissionWithFailover`) engolia
// qualquer exceção com um `.catch(warn)` cego. A exceção nunca alcançava o
// laço que troca de motor (`executeMissionWithFailover`), então a dúvida
// ficava esperando o MESMO motor morto voltar, com os outros dois degraus da
// cadeia canônica (codex → antigravity → claude) ociosos ao lado — o mesmo
// defeito medido ao vivo em 26/08 para OUTROS papéis, nunca corrigido para a
// dúvida.
//
// Este arquivo é o "real seam" (mesmo padrão de
// scheduler-aviso-credencial-real-seam.test.ts): registra o schedulerPlugin
// de VERDADE e dispara pelo único ponto de entrada real
// (app.triggerAgentMission) — daí em diante é 100% código de produção:
// runTrigger -> executeMissionWithFailover -> ramo qaRails (o `execute()` que
// `responderDuvidaPendente` recebe) -> runDuvidaMissionViaRails -> runFormStep
// -> adapter.run() -> RailsExecutionError (cota) -> isEngineFault -> catch de
// executeMissionWithFailover -> próximo motor da cadeia. Nada disso é
// reimplementado aqui.
//
// O que É substituído: `createCliRuntimeAdapter` (o fabricante do adaptador
// que fala com o binário do CLI de cada motor). Diferente do caminho
// CLÁSSICO (scheduler-aviso-credencial-real-seam.test.ts, que mocka
// `AgentOrchestrator` inteiro), o ramo de TRILHOS (`qaRails`, onde
// `responderDuvidaPendente` mora) nunca passa pelo `AgentOrchestrator` —
// chama `activeStack.registry.resolve(runtime).run(...)` DIRETO. Mockar
// `AgentOrchestrator` aqui não teria efeito NENHUM (medido: a primeira versão
// deste arquivo fazia isso e a missão batia direto no gate real de segurança
// do host, `/opt/gitorch-plugin/gitorch/hooks.json`, porque tentava spawnar
// um `codex`/`agy`/`claude` de verdade). `createCliRuntimeAdapter` é o
// fabricante — substituí-lo troca o QUE o adaptador faz (spawnar processo)
// sem tocar em NADA do resto: `RuntimeRegistry`, a resolução por `runtime`,
// e todo o wiring de `scheduler.ts` continuam 100% reais.
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

// A saída LITERAL do provedor batendo no teto — mesma medição de
// teto-de-uso-da-conta.test.ts (L4-T22, item 1): "usage limit" casa
// `isFailoverError` (troca de motor) e "try again at ..." casa
// `quandoACotaVolta` (o prazo que o aviso executivo do item 3 usa).
const SAIDA_DE_COTA_ESGOTADA =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at " +
  'Sep 21st, 2026 6:00 AM (https://chatgpt.com/explore/plus)'

const PERGUNTA_DO_DEV =
  'Which existing error-handling helper should I reuse for the retry logic — is there one already?'

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

const SESSAO_DUVIDA = {
  sessionName: 'sessions/duvida-1',
  issueNumber: 55,
  answeredHash: null as string | null,
  stateCheckedAt: null as Date | null,
}

function buildFakePrisma(args: { chatId: string | null; duvidasEsperando: number }) {
  let missionCounter = 0
  return {
    mission: {
      updateMany: vi.fn(async (_args: { where: unknown; data: { status?: string } }) => ({
        count: 1,
      })),
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
      findUnique: vi.fn(async () =>
        args.chatId
          ? { status: 'linked', chatId: args.chatId }
          : { status: 'unlinked', chatId: null }
      ),
    },
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    devSession: {
      // Única forma que `responderDuvidaPendente` (a candidata pendente)
      // consulta neste cenário — os fluxos que reprocessam
      // `suporDuvidaPendente`/`runQaMissionViaRails` nunca são alcançados
      // porque `responderDuvidaPendente` sempre lança (cota esgotada).
      findMany: vi.fn(async () => [SESSAO_DUVIDA]),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => args.duvidasEsperando),
    },
  }
}

// `src/test/setup.ts` faz `vi.mock('pino', ...)` para TODA a suíte (evita
// custo de logger real em milhares de testes) — então passar `logger: {...}`
// para o Fastify não adianta aqui, o pino por trás sai mudo sempre. Para
// PROVAR o conteúdo do log ("qual motor respondeu"), a única porta real é
// `loggerInstance` (Fastify aceita um logger PRÓPRIO, ignorando pino por
// completo — `validateLogger` em fastify/lib/logger-factory.js só exige a
// forma: info/error/debug/fatal/warn/trace/child).
interface LoggerCapturado {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  fatal: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  child: () => LoggerCapturado
}

function criaLoggerCapturado(): { linhas: string[]; logger: LoggerCapturado } {
  const linhas: string[] = []
  const logger: LoggerCapturado = {
    info: (...args: unknown[]) => linhas.push(`INFO ${args.map(String).join(' ')}`),
    warn: (...args: unknown[]) => linhas.push(`WARN ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => linhas.push(`ERROR ${args.map(String).join(' ')}`),
    debug: (...args: unknown[]) => linhas.push(`DEBUG ${args.map(String).join(' ')}`),
    fatal: (...args: unknown[]) => linhas.push(`FATAL ${args.map(String).join(' ')}`),
    trace: (...args: unknown[]) => linhas.push(`TRACE ${args.map(String).join(' ')}`),
    child: () => logger,
  }
  return { linhas, logger }
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
    // Telegram sendMessage E qualquer outra chamada (ex.: Jules :sendMessage
    // no cenário de sucesso) — 200 genérico basta para os dois.
    return new Response('{"ok":true}', { status: 200 })
  })
}

describe('dúvida do dev + cota esgotada: liga à cascata de failover que já existe (L4-T22)', () => {
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
    // ramo de trilhos, onde `responderDuvidaPendente` roda) — o OPOSTO do
    // seam de credencial expirada, que precisa do caminho clássico.
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

  test('cota esgotada nos TRÊS motores da cadeia: os três são tentados (item 2) e o dono recebe UM aviso executivo agregado, não por motor (item 3)', async () => {
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 1,
        durationMs: 1,
        output: '',
        stderr: SAIDA_DE_COTA_ESGOTADA,
      },
      antigravity: {
        missionId: 'irrelevante',
        runtime: 'antigravity',
        exitCode: 1,
        durationMs: 1,
        output: '',
        stderr: SAIDA_DE_COTA_ESGOTADA,
      },
      claude: {
        missionId: 'irrelevante',
        runtime: 'claude',
        exitCode: 1,
        durationMs: 1,
        output: '',
        stderr: SAIDA_DE_COTA_ESGOTADA,
      },
    }
    const fetchMock = fetchRoteado(PERGUNTA_DO_DEV)
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    const prisma = buildFakePrisma({ chatId: 'chat-do-dono', duvidasEsperando: 3 })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // Item 2: a cascata REALMENTE tentou os três motores — não parou no
    // primeiro nem ficou girando nele. Esta é a prova de que o esgotamento de
    // cota deixou de ser falha LOCAL e passou pela MESMA cascata de
    // executeMissionWithFailover.
    await vi.waitFor(
      () => {
        expect(resultadoDoMotor.chamadas).toEqual(['codex', 'antigravity', 'claude'])
      },
      { timeout: 3000, interval: 10 }
    )

    // A missão termina marcada como falha honesta (nenhum motor concluiu) —
    // nunca mascarada como sucesso.
    await vi.waitFor(
      () => {
        const chamadasDeFalha = prisma.mission.updateMany.mock.calls.filter(
          (c) => (c[0] as { data?: { status?: string } }).data?.status === 'failed'
        )
        expect(chamadasDeFalha.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    // Item 3: entre as mensagens de Telegram (o aviso por motor de
    // `recadoDeTetoDeUso` sai a cada degrau, e é um recado DIFERENTE), existe
    // UM aviso executivo agregado dizendo que o TIME ficou sem capacidade — e
    // ele conta as dúvidas esperando. O envio é fire-and-forget (a mesma razão
    // de `vi.waitFor` em scheduler-aviso-credencial-real-seam.test.ts): os
    // `await`s de `resolveNotifyChatId`/`devSession.count`/`avisarMotoresEsgotados`
    // terminam DEPOIS do `chamadas` já ter os 3 motores.
    const mensagensDeTelegramDe = (mock: typeof fetchMock) =>
      mock.mock.calls
        .filter((c) => String(c[0]).startsWith('https://api.telegram.org/'))
        .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { text: string })

    let avisoExecutivo: Array<{ text: string }> = []
    await vi.waitFor(
      () => {
        avisoExecutivo = mensagensDeTelegramDe(fetchMock).filter((m) =>
          m.text.includes('sem capacidade')
        )
        expect(avisoExecutivo).toHaveLength(1)
      },
      { timeout: 3000, interval: 10 }
    )
    expect(avisoExecutivo[0]?.text).toContain('3')
    expect(avisoExecutivo[0]?.text).toContain('Sep 21st, 2026 6:00 AM')
    // Nunca uma pergunta técnica solta — é um informe (D71/D72).
    expect(avisoExecutivo[0]?.text).not.toContain('?')

    // Dedup "uma vez por janela": uma SEGUNDA missão, na mesma janela (mesmo
    // dono+projeto), esgotando a cadeia de novo, NÃO manda um segundo aviso
    // executivo — spam apagaria sinal tanto quanto silêncio.
    resultadoDoMotor.chamadas = []
    const segundaMissao = await app.triggerAgentMission('qa', 'proj_1')
    expect(segundaMissao.triggered).toBe(true)
    await vi.waitFor(
      () => {
        expect(resultadoDoMotor.chamadas).toEqual(['codex', 'antigravity', 'claude'])
      },
      { timeout: 3000, interval: 10 }
    )
    // Tempo de sobra para qualquer aviso adicional terminar de sair — se
    // fosse repetir, já teria acontecido dentro desta janela.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const avisosExecutivosNoTotal = mensagensDeTelegramDe(fetchMock).filter((m) =>
      m.text.includes('sem capacidade')
    )
    expect(avisosExecutivosNoTotal).toHaveLength(1)
  })

  test('cota esgotada só no primeiro motor: o SEGUNDO responde, o terceiro nunca é chamado, e o log nomeia qual motor respondeu', async () => {
    resultadoDoMotor.porRuntime = {
      codex: {
        missionId: 'irrelevante',
        runtime: 'codex',
        exitCode: 1,
        durationMs: 1,
        output: '',
        stderr: SAIDA_DE_COTA_ESGOTADA,
      },
      antigravity: {
        missionId: 'irrelevante',
        runtime: 'antigravity',
        exitCode: 0,
        durationMs: 1,
        // Resposta técnica válida (RAILS_SCHEMAS.devQuestion): precisaDoDono
        // falso, resposta cita arquivo real — passa o freio de concretude
        // (ehRespostaUtil) e vai direto para o dev.
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

    const { linhas: logLinhas, logger } = criaLoggerCapturado()
    app = Fastify({ loggerInstance: logger as never })
    const prisma = buildFakePrisma({ chatId: 'chat-do-dono', duvidasEsperando: 0 })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // O segundo motor (antigravity) respondeu — o terceiro (claude) NUNCA
    // precisou ser chamado. Prova de que o failover para no primeiro sucesso,
    // não continua tentando motores à toa.
    await vi.waitFor(
      () => {
        expect(resultadoDoMotor.chamadas).toEqual(['codex', 'antigravity'])
      },
      { timeout: 3000, interval: 10 }
    )
    // O log NOMEIA qual motor respondeu, e qual motor não deu conta — a
    // exigência explícita do item 2 ("com log dizendo qual motor
    // respondeu"). Nunca um log genérico sem dizer QUAL motor. `waitFor`
    // pela mesma razão de sempre: as linhas de log da resposta bem-sucedida
    // saem DEPOIS de `chamadas` já ter os dois motores (mais `await`s no
    // caminho: registrarResposta, registrarAprendizado etc.).
    await vi.waitFor(
      () => {
        const textoDoLog = logLinhas.join('\n')
        expect(textoDoLog).toContain('motor codex não deu conta')
        expect(textoDoLog).toContain('motor antigravity respondeu à dúvida')
      },
      { timeout: 3000, interval: 10 }
    )
    // Depois de estabilizado: o terceiro motor (claude) nunca foi chamado.
    expect(resultadoDoMotor.chamadas).toEqual(['codex', 'antigravity'])
  })
})
