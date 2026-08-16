import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Tarefa 17 — "a esteira vai até o ar".
//
// O RISCO central desta tarefa (nomeado no brief): `varrerPublicacoes` só
// existe de verdade se o `tick()` de produção a CHAMA. As Tarefas 7, 10 e 16
// já provaram, três vezes, que uma peça pode estar correta e 100% testada em
// isolamento e ainda assim nunca rodar em produção — porque o call site real
// dentro do fechamento não-exportado do relógio (`tick`,
// `executeMissionWithFailover`) nunca chegou a chamá-la.
//
// Este arquivo fecha essa lacuna pelo MESMO "real seam" já usado em
// `scheduler-boot-reaper.test.ts` (describe "real seam") e em
// `scheduler-aviso-credencial-real-seam.test.ts`: registra o `schedulerPlugin`
// de VERDADE — nada de `tick`/`varrerPublicacoes` reimplementado — e deixa o
// próprio `setInterval` de produção disparar o tick (força `NODE_ENV` para
// fora de 'test', só no registro do plugin, e usa um `GITORCH_SCHEDULER_TICK_MS`
// minúsculo). Dali em diante é 100% código de produção: tick -> varrerPublicacoes
// -> sessoesParaAcompanharPublicacao -> descobrirMecanismo -> acompanharPublicacao
// -> registrarEstadoDaPublicacao -> fecharSessao.
//
// Cenário escolhido (mecanismo 'nenhum' -> veredito 'sem-publicacao'): é o
// que exige MENOS mock de rede (só duas rotas do GitHub — environments e
// actions/workflows, ambas vazias) enquanto ainda atravessa a cadeia inteira
// até o fechamento real da sessão.
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
} as const

const SESSAO_MESCLADA = {
  id: 'sess_1',
  projectId: 'proj_1',
  issueNumber: 5,
  sessionName: 'sessions/abc',
  state: 'COMPLETED',
  answeredHash: null,
  pullRequestNumber: 7,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  stateCheckedAt: null,
  pendingSince: null,
  mergeCommitSha: 'deadbeef',
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
} as const

function buildFakePrisma() {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  return {
    mission: {
      // boot reaper (roda no registro do plugin, fora de NODE_ENV='test') e
      // processSetupMissions (roda a cada tick) — ambos inertes aqui.
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      // reconferirAcessoDoRelogio: sem projetos, o laço nunca entra —
      // nenhuma prova de escrita é tentada.
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        // Roteamento por forma do `where`: só a consulta de
        // `varrerPublicacoes` (mergeCommitSha) enxerga a sessão mesclada —
        // a de `varrerSessoesDoDev` (distinct projectId, sem mergeCommitSha)
        // devolve vazio, deixando aquela vigília inerte neste teste.
        if (args?.where?.mergeCommitSha) return [SESSAO_MESCLADA]
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      // Achado 3 da revisão: linkado (não 'unlinked'), para o aviso de
      // fechamento por `sem-publicacao` ser observável de verdade pelo
      // teste — sem isto `avisarDonoDoProjeto` retorna cedo (nenhum canal) e
      // o teste não provaria nada sobre o aviso.
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

describe('varrerPublicacoes wiring em schedulerPlugin (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    // Fora de 'test': é o que deixa o `setInterval` real do relógio nascer
    // (o mesmo guard que `scheduler-boot-reaper.test.ts` já usa para provar
    // o boot reaper pelo seam real).
    process.env['NODE_ENV'] = 'production'
    // Minúsculo: o tick dispara quase de imediato, sem waits artificiais.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    // Bypassa mintInstallationToken (App do GitHub) — não é o que esta
    // tarefa testa.
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    // Achado 3: canal de Telegram real (mockado na rede), para o aviso de
    // fechamento por `sem-publicacao` disparar de verdade.
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
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

  test('tick real fecha a sessão mesclada sem mecanismo de publicação (sem-publicacao) — a cadeia inteira roda sem reimplementação, e o dono é avisado (achado 3)', async () => {
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.endsWith('/repos/acme/api/environments')) {
        return new Response(JSON.stringify({ environments: [] }), { status: 200 })
      }
      if (u.endsWith('/repos/acme/api/actions/workflows')) {
        return new Response(JSON.stringify({ workflows: [] }), { status: 200 })
      }
      if (u.startsWith('https://api.telegram.org/')) {
        return new Response('{"ok":true}', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // A sessão NÃO estava mesclada por um `fetchMock`/tick simulado — ela já
    // nasce com `mergeCommitSha` preenchido (o cenário começa DEPOIS do
    // merge, exatamente o que `aoMesclarUmaEntrega` grava). O que este teste
    // prova é o PRÓXIMO passo: o tick real leva essa sessão até o veredito.
    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Prova que o veredito gravado foi o real (`registrarEstadoDaPublicacao`
    // -> `acompanharPublicacao` -> `descobrirMecanismo` == 'nenhum'), não um
    // fechamento por qualquer outro motivo.
    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'sem-publicacao' })
    expect(chamadaDeEstado?.where).toEqual({ sessionName: 'sessions/abc' })

    // E que a descoberta do mecanismo realmente saiu pela rede real (as duas
    // rotas do GitHub) — não um veredito inventado sem consultar nada.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.endsWith('/repos/acme/api/environments'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/repos/acme/api/actions/workflows'))).toBe(true)

    // Achado 3 da revisão: fechar `sem-publicacao` em silêncio era o
    // caminho mais provável de esconder uma falha real. O dono precisa ser
    // avisado UMA vez, em linguagem de negócio, dizendo que o repositório
    // não tem mecanismo de publicação configurado (não que "algo falhou").
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram).toHaveLength(1)
    const chamadaDeTelegram = chamadasDeTelegram[0] as unknown as [string, RequestInit]
    const corpo = JSON.parse(String(chamadaDeTelegram[1].body)) as {
      chat_id: string
      text: string
    }
    expect(corpo.chat_id).toBe('chat-do-dono')
    expect(corpo.text).toContain('acme/api')
    expect(corpo.text).toContain('mesclada')
    expect(corpo.text).toMatch(/não identificamos.*como este repositório publica/)
  })
})
