import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { BuildAgentMissionInput, RuntimeExecutionResult } from '@gitorch/agents'

// Achado 2 da revisão da Tarefa 16: um reviewer apagou o bloco INTEIRO que
// dispara o aviso Telegram (scheduler.ts, catch de executeMissionWithFailover,
// ~2126-2149) e a suíte inteira (1581 testes) continuou 100% verde. Causa raiz:
// o único teste que tocava o assunto (scheduler-failover-motor.test.ts,
// `simulaCadeia`) REIMPLEMENTAVA a forma do loop à mão — nunca chamava o código
// de verdade, então não tinha como perceber a remoção.
//
// Este arquivo fecha essa lacuna com o "real seam": registra o schedulerPlugin
// de VERDADE (mesmo padrão de scheduler-boot-reaper.test.ts, describe "real
// seam") e dispara uma missão pelo ÚNICO ponto de entrada real
// (app.triggerAgentMission, o mesmo que a rota admin/QA e o relógio usam) — daí
// em diante é 100% o código de produção: runTrigger -> executeMissionWithFailover
// -> caminho clássico -> ehCredencialExpirada -> catch -> deveAvisarDeNovo ->
// resolveNotifyChatId -> buildTelegramNotifier -> fetch. Nada disso é
// reimplementado aqui.
//
// Só o AgentOrchestrator é substituído (para não depender de um binário de CLI
// de verdade — codex/agy/claude — dentro do runner de CI); registry, adapters e
// o resto inteiro de @gitorch/agents continuam reais, o mesmo seam já usado em
// scheduler-free-tier-local.test.ts/scheduler-mission-cpus.test.ts.
const resultadoDoMotor = vi.hoisted(() => ({
  atual: null as RuntimeExecutionResult | null,
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    AgentOrchestrator: class {
      constructor(_options: unknown) {}
      async runMission(_input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
        if (!resultadoDoMotor.atual) {
          throw new Error('teste não configurou resultadoDoMotor.atual antes de disparar a missão')
        }
        return resultadoDoMotor.atual
      }
    },
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

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

function buildFakePrisma(chatId: string | null) {
  let missionCounter = 0
  return {
    mission: {
      // count:1 (não 0): a via de sucesso (~scheduler.ts, bloco "entrega
      // delivered") confere o count do updateMany condicional
      // (where: { status: 'running' }) para decidir se OUTRO tick já
      // reivindicou a missão — com 0 sempre, ela se autodescartava como
      // "já não estava running" mesmo tendo acabado de rodar, e a missão
      // de sucesso do teste de corroboração nunca persistia 'completed'.
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => {
        missionCounter += 1
        return { id: `mission_${missionCounter}` }
      }),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
    },
    telegramLink: {
      findUnique: vi.fn(async () =>
        chatId ? { status: 'linked', chatId } : { status: 'unlinked', chatId: null }
      ),
    },
    // 26/08: além do recado, o produto agora marca a CONEXÃO como precisando de
    // login novo. Sem isto a linha do banco seguia dizendo 'connected' e o
    // assistente mostrava o motor verde com ele morto (print do dono).
    engineConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
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

describe('Tarefa 16 (achado 2 da revisão) — aviso de credencial expirada pelo seam real', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const originalFetch = global.fetch

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
    // Sem GITHUB_APP_ID/PRIVATE_KEY nem GITORCH_GITHUB_TOKEN: mintInstallationToken
    // resolve null SEM rede (contrato documentado em github-app-token.ts), então
    // role 'qa' cai garantidamente no caminho CLÁSSICO — o único ramo onde
    // result.output é saída crua do motor (ver scheduler.ts ~1944-1949).
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
    resultadoDoMotor.atual = null
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  test('motor mente sucesso (exitCode 0) pedindo login novo: o dono recebe o aviso de VERDADE no Telegram', async () => {
    resultadoDoMotor.atual = {
      missionId: 'irrelevante-aqui',
      // 'codex' é o primeiro da cadeia canônica (codex > antigravity > claude,
      // DEFAULT_AGENT_RUNTIME_ASSIGNMENTS) e portanto o runtime selecionado para
      // o role 'qa' — é ele que o CredencialExpiradaError e a mensagem nomeiam.
      runtime: 'codex',
      exitCode: 0,
      durationMs: 1,
      output: 'ERROR: Your access token could not be refreshed. Please log out and sign in again.',
      stderr: '',
    }
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prismaDoAviso = buildFakePrisma('chat-do-dono')
    app.decorate('prisma', prismaDoAviso as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // O envio é fire-and-forget (executeMissionWithFailover roda em background);
    // vi.waitFor espera o catch/aviso terminarem sem depender de contar ticks de
    // microtask (frágil e o motivo de trocarmos setImmediate por isto).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 })

    const chamada = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = chamada
    expect(url).toBe('https://api.telegram.org/botbot-token-de-teste/sendMessage')
    const corpo = JSON.parse(String(init.body)) as { chat_id: string; text: string }
    expect(corpo.chat_id).toBe('chat-do-dono')
    expect(corpo.text).toContain('codex')
    expect(corpo.text).toContain('acme/api')
    // Correção 2 (segunda revisão): a mensagem não afirma "a credencial
    // expirou" como fato — é uma inferência (sinal textual + ausência de
    // entregável), nunca uma observação direta da credencial em si. Descreve
    // o que foi observado (terminou sem entregar; a saída LEMBRA um login
    // expirado) e pede para o dono CONFERIR, não afirma com certeza.
    expect(corpo.text).toContain('terminou sem entregar')
    expect(corpo.text).toContain('login expirado')
    expect(corpo.text).toContain('conferir')
    expect(corpo.text).not.toContain('a credencial do motor')
    // Nunca vaza o texto cru do motor (que poderia um dia carregar mais que a
    // frase de recado) — o aviso ao DONO é sempre a mensagem sintetizada do
    // produto, nunca stderr/output relatado.
    expect(corpo.text).not.toContain('access token could not be refreshed')

    // 26/08 — A TELA PARA DE MENTIR. Não basta avisar: a linha da conexão tem
    // de deixar de dizer 'connected' no mesmo instante. Enquanto isto não
    // existia, o assistente mostrava o card do motor VERDE, "Conectado", com
    // os modelos listados, no minuto em que toda missão morria por credencial
    // — e uma tela verde não oferece nada para clicar (print do dono).
    await vi.waitFor(() => expect(prismaDoAviso.engineConnection.updateMany).toHaveBeenCalled(), {
      timeout: 2000,
    })
    const marca = prismaDoAviso.engineConnection.updateMany.mock.calls[0] as unknown as [
      { where: { userId: string; runtime: string }; data: { status: string; lastError: string } },
    ]
    expect(marca[0].where).toEqual({ userId: 'user_1', runtime: 'codex' })
    expect(marca[0].data.status).toBe('needs_reconnect')
    expect(marca[0].data.status).not.toBe('connected')
    // A credencial cifrada NUNCA é apagada aqui (isso é papel de revoke): uma
    // renovação posterior ainda pode ressuscitá-la, e captureFromHome regrava
    // 'connected' sozinho na primeira missão que der certo.
    expect(marca[0].data).not.toHaveProperty('encryptedCredential')

    await app.close()
  })

  test('sem vínculo de Telegram (chatId nulo): a missão ainda falha honestamente, mas NADA é enviado (nunca lança por falta de canal)', async () => {
    resultadoDoMotor.atual = {
      missionId: 'irrelevante-aqui',
      runtime: 'antigravity',
      exitCode: 0,
      durationMs: 1,
      output: '401 Unauthorized',
      stderr: '',
    }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma(null)
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // Dá tempo do catch/classificação rodarem (mesmo sem notificar, o resto da
    // missão — marcar failed — precisa terminar).
    await vi.waitFor(() => expect(prisma.mission.updateMany).toHaveBeenCalled(), {
      timeout: 2000,
    })
    expect(fetchMock).not.toHaveBeenCalled()

    await app.close()
  })

  test('dedup real (não só em unidade): duas missões no mesmo dia para o MESMO dono+motor avisam UMA vez só', async () => {
    resultadoDoMotor.atual = {
      missionId: 'irrelevante-aqui',
      runtime: 'antigravity',
      exitCode: 0,
      durationMs: 1,
      output: 'invalid_grant: token expired',
      stderr: '',
    }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma('chat-do-dono') as never)
    await app.register(schedulerPlugin)

    await app.triggerAgentMission('qa', 'proj_1')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 })

    await app.triggerAgentMission('qa', 'proj_1')
    // Segunda missão: dá tempo equivalente de sobra e confirma que NÃO houve
    // uma segunda chamada — SPAM apaga sinal tanto quanto silêncio.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  // Correção 2 (segunda revisão, achado 1 residual): sinal forte
  // ("invalid_grant") sozinho não basta mais — precisa TAMBÉM que a missão
  // não tenha entregado. Este teste atravessa o MESMO seam real dos três
  // acima (nada reimplementado) com uma saída que TEM o sinal forte E tem
  // entregável real (estrutura de relatório técnico) — é o caso que
  // disparava falso antes da corroboração e é a prova mais forte possível de
  // que a correção está ligada de verdade no call site de produção, não só
  // testada em unidade pura.
  test('sinal forte presente (invalid_grant) MAS a missão entregou um relatório real: NÃO avisa, e a missão completa normalmente', async () => {
    resultadoDoMotor.atual = {
      missionId: 'irrelevante-aqui',
      runtime: 'antigravity',
      exitCode: 0,
      durationMs: 1,
      output:
        '## Investigação do incidente #884\n\n' +
        'A sessão de um cliente caiu com a seguinte pilha:\n\n' +
        '```\n' +
        'OAuthError: invalid_grant\n' +
        '    at TokenClient.refresh (oauth-client.ts:142)\n' +
        '```\n\n' +
        '### Causa raiz\n\n' +
        'O refresh token do CLIENTE (não do GitOrch) expirou no provedor deles — ' +
        'não é um problema do nosso motor.',
      stderr: '',
    }
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const app = Fastify({ logger: false })
    const prisma = buildFakePrisma('chat-do-dono')
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    const resultado = await app.triggerAgentMission('qa', 'proj_1')
    expect(resultado.triggered).toBe(true)

    // Espera especificamente a chamada de SUCESSO (status 'completed'), não
    // "qualquer chamada" — a faxina de missões presas (failStuckMissions)
    // também chama updateMany, cedo, sem relação com esta missão; esperar só
    // "toHaveBeenCalled()" resolve antes da persistência real terminar
    // (corrida observada: passa isolado, falha junto com os outros testes
    // do arquivo). Some chamadas de updateMany são dessa faxina — por isso
    // procuramos, entre TODAS as chamadas, uma que marcou status
    // 'completed' (só a via de sucesso real faz isso).
    const encontrouChamadaDeSucesso = () => {
      const chamadas = prisma.mission.updateMany.mock.calls as unknown as Array<
        [{ data?: { status?: string } }]
      >
      return chamadas.some(([arg]) => arg.data?.status === 'completed')
    }
    await vi.waitFor(() => expect(encontrouChamadaDeSucesso()).toBe(true), { timeout: 2000 })
    // Nenhum aviso de credencial expirada — a missão entregou. E o motivo de
    // não ter avisado é que ela foi tratada como sucesso, não como uma falha
    // silenciosa qualquer (senão o teste passaria "por acidente" caso outra
    // parte do código também suprimisse o aviso) — já verificado acima pelo
    // wait na chamada 'completed'.
    expect(fetchMock).not.toHaveBeenCalled()

    await app.close()
  })
})
