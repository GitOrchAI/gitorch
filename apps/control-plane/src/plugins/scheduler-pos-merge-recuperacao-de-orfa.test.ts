import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { CADENCIA_DE_PUBLICACAO_MS } from '../services/publicacao.js'

// Crítico 2 (leva C) — "uma sessão órfã fica presa para sempre".
//
// O CENÁRIO: `scheduler.ts` grava o veredito FINAL da publicação
// (`registrarEstadoDaPublicacao`, `deployState: 'no-ar'`) e SÓ DEPOIS, depois
// de `testarAmbiente` (uma chamada HTTP real de ~10s ao endereço do
// cliente), chama `fecharSessao` (`closedAt`). Um restart do control-plane
// bem NESSA janela deixa uma linha com veredito final registrado mas
// `closedAt` ainda nulo — exatamente o estado que este arquivo simula ao
// semear a sessão fake JÁ NESSE estado (o "restart" já aconteceu antes do
// teste começar).
//
// SEM a correção (`pos-merge.ts`, `sessoesParaAcompanharPublicacao`): essa
// linha nunca mais entra em `candidatas` — `ESTADOS_FINAIS` a exclui só pelo
// veredito, sem checar se ela está DE FATO fechada. A vigília nunca a
// reexamina, `fecharSessao` nunca roda, e o índice único de sessão aberta
// por issue bloqueia qualquer nova delegação para a mesma issue, para
// sempre.
//
// COM a correção: a exclusão por `ESTADOS_FINAIS` só vale quando `closedAt`
// já está preenchido. Uma linha órfã (final + `closedAt` nulo) cai na
// checagem de cadência, como qualquer sessão em aberto — e volta a ser
// examinada. Este arquivo prova que, na PRÓXIMA passagem do relógio depois
// do "restart", a sessão órfã é finalmente fechada de verdade: o produto
// consulta o GitHub de novo, confirma o veredito, testa o ambiente, fecha a
// sessão e avisa o dono — nada fica perdido, só atrasado até a cadência
// seguinte.
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
} as const

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

function buildFakePrisma(sessaoInicial: Record<string, unknown>) {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let sessaoAtual: Record<string, unknown> = { ...sessaoInicial }
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
      // A guarda de autonomia descobre o dono do repositório por aqui, na hora
      // de cada escrita REST. Sem esta linha o fake responde "não é projeto
      // nenhum" e a escrita é recusada — corretamente.
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      // Mesmo filtro que a query real (`scheduler.ts`, `varrerPublicacoes`):
      // `where: { closedAt: null, mergeCommitSha: { not: null } }`. A linha
      // órfã tem `closedAt: null` — o BANCO já a devolveria; é
      // `sessoesParaAcompanharPublicacao` (pos-merge.ts), rodando DEPOIS
      // desta chamada, quem decide se ela entra em `candidatas`.
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) {
          return sessaoAtual['closedAt'] === null ? [sessaoAtual] : []
        }
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        sessaoAtual = { ...sessaoAtual, ...args.data }
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

// A sessão nasce JÁ no estado "órfão": veredito final registrado
// (`deployState: 'no-ar'`), cadência vencida (para não esperar 10 minutos no
// teste), mas `closedAt` ainda nulo — o restart aconteceu antes de
// `fecharSessao` rodar.
function sessaoOrfa(over: Record<string, unknown> = {}) {
  return {
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
    stateCheckedAt: new Date(Date.now() - 60 * 60_000),
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: 'deadbeef',
    deployState: 'no-ar',
    deployCheckedAt: new Date(Date.now() - (CADENCIA_DE_PUBLICACAO_MS + 60_000)),
    mergeFailures: 0,
    mergeLastFailedAt: null,
    closedAt: null,
    ...over,
  }
}

describe('Crítico 2 — sessão órfã (veredito final registrado, closedAt nulo) é recuperada na próxima passagem', () => {
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

  test('a linha órfã volta a ser examinada, o GitHub é consultado de novo, a sessão fecha de verdade e o dono é avisado', async () => {
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
        if (u.endsWith('/repos/acme/api/environments')) {
          return json({ environments: [{ name: 'production' }] })
        }
        if (u.includes('/repos/acme/api/deployments?')) {
          return json([
            {
              id: 1,
              environment: 'production',
              sha: 'deadbeef',
              production_environment: true,
              transient_environment: false,
            },
          ])
        }
        if (u.match(/\/repos\/acme\/api\/deployments\/\d+\/statuses/)) {
          return json([
            {
              state: 'success',
              environment_url: 'https://prod.example.com',
              created_at: '2026-01-01T00:00:00Z',
            },
          ])
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return json({ ok: true })
        }
        // Ensaio do ambiente (Tarefa 14/17) — qualquer caminho testado
        // responde 200; não é o que este arquivo prova.
        void init
        return new Response('ok', { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma(sessaoOrfa())
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // SEM a correção, `candidatas` nunca inclui esta linha (ESTADOS_FINAIS a
    // exclui só pelo veredito) — nenhuma chamada ao GitHub acontece, e este
    // `waitFor` estoura o timeout.
    await vi.waitFor(
      () => {
        const consultouOGithubDeNovo = fetchMock.mock.calls.some(([u]) =>
          String(u).includes('/repos/acme/api/deployments?')
        )
        expect(consultouOGithubDeNovo).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // A sessão finalmente fecha de verdade — `closedAt`/`closedReason`
    // gravados pela PRIMEIRA vez (o restart simulado nunca chegou a gravar
    // isso).
    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // E o dono é avisado — não fica sabendo só quando reparar, meses depois,
    // que a issue nunca fechou.
    const chamadasDeTelegram = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.telegram.org/')
    )
    expect(chamadasDeTelegram.length).toBeGreaterThanOrEqual(1)
    const corpoDoAviso = String(
      (chamadasDeTelegram[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    )
    expect(corpoDoAviso).toContain('acme/api')
  })
})
