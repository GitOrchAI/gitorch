import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// C11 (fix-up L4-T5, CSO): teste de costura REAL do wiring de retomada
// (`varrerCicloTerminalDaSessao` -> `retomarPrReprovado`, já existente desde
// a task original ebf7e69e) — os testes unitários de `executarCicloTerminal`
// e `retomarPrReprovado` já provam a DECISÃO com deps falsos; nenhum arquivo
// provava, pelo seam real do `schedulerPlugin`, que uma sessão COMPLETED com
// pull request aberto-e-reprovado além das 12h de fato vira uma sessão NOVA
// no MESMO PR — não uma linha morta esperando o vigia de PR órfão (3 dias
// depois) ou uma redelegação que abriria um PR SEGUNDO do zero.
//
// Mesmo "real seam" dos irmãos: registra o `schedulerPlugin` de VERDADE,
// deixa o próprio `setInterval` de produção disparar `tick` ->
// `varrerCicloTerminalDaSessao`, e prova o resultado observável — uma
// chamada POST à API do Jules pedindo a sessão nova NA MESMA branch do PR
// reprovado, e o registro do MESMO número de PR na linha nova.

const JULES_API = 'https://jules.googleapis.com/v1alpha'
const GITHUB_API = 'https://api.github.com'

const PROJETO = {
  id: 'proj_retomada',
  wingId: 'loureng/patinhas-3d-crafts',
  name: 'Patinhas 3D Crafts',
  userId: null,
} as const

const PR_NUMBER = 3917
const BRANCH_DO_PR = 'jules-3917-branch'
const SESSAO_VELHA = 'sessions/velha-3907'

function sessaoTerminalComPrRejeitado() {
  return {
    id: 'sess_velha',
    projectId: PROJETO.id,
    issueNumber: 3884,
    sessionName: SESSAO_VELHA,
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: PR_NUMBER,
    attempts: 1,
    nudges: 0,
    // 13h sem avançar: passou das 12h de espera (HORAS_ATE_DESISTIR_DO_PR_REJEITADO).
    lastProgressAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    requeueCount: 0,
    analysisDoneAt: null,
    devAccountId: null,
    closedAt: null,
  }
}

function buildFakePrisma() {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  const upsertCalls: Array<{ where: unknown; create: Record<string, unknown> }> = []
  const linha = sessaoTerminalComPrRejeitado()

  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      // `varrerCicloTerminalDaSessao` resolve o projeto por `id: { in: [...] }`
      // — DIFERENTE da consulta `isActive: true` que as outras varreduras do
      // tique usam (vigia-do-pr, quadro, sprint, prs-duplicados). Devolver
      // `[]` para `isActive` desliga as irmãs de propósito: este arquivo
      // prova só o caminho de retomada.
      findMany: vi.fn(async (args: { where?: { id?: { in?: string[] }; isActive?: boolean } }) => {
        if (args?.where?.id?.in?.includes(PROJETO.id)) return [PROJETO]
        return []
      }),
      findUnique: vi.fn(async () => ({ encryptedDevApiKey: null })),
      findFirst: vi.fn(async () => ({ autonomia: 'cuidar' })),
    },
    devSession: {
      findMany: vi.fn(
        async (args: {
          where?: { closedAt?: null; mergeCommitSha?: unknown; projectId?: string }
          distinct?: unknown
        }) => {
          if (args?.where?.mergeCommitSha) return []
          if (args?.distinct) return [{ projectId: PROJETO.id }]
          // GLOBAL `{ closedAt: null }` — ciclo terminal E o watchdog de
          // abandono compartilham esta MESMA forma de `where`; o watchdog
          // pula COMPLETED/FAILED de propósito (sessao-abandonada.ts), então
          // devolver a mesma linha para os dois é seguro.
          if (args?.where?.closedAt === null && !args.where.projectId) return [linha]
          return []
        }
      ),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      count: vi.fn(async () => 1), // só ESTA linha registrada para o PR — 0 retomadas anteriores
      upsert: vi.fn(async (args: { where: unknown; create: Record<string, unknown> }) => {
        upsertCalls.push(args)
        return undefined
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    _updateCalls: updateCalls,
    _upsertCalls: upsertCalls,
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
  'GITORCH_RETOMADAS_POR_PR',
]

describe('retomada no mesmo PR — wiring do ciclo terminal (real seam, C11/L4-T5)', () => {
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

  test('sessão COMPLETED com PR aberto-rejeitado-parado há 13h e branch retomável → cria sessão nova na MESMA branch, mesmo PR, e NÃO fica presa em pr-rejeitado-sem-retomada', async () => {
    const chamadasAoJules: Array<{ body: Record<string, unknown> }> = []

    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        const method = (init?.method ?? 'GET').toUpperCase()

        if (u === `${GITHUB_API}/repos/${PROJETO.wingId}/pulls/${PR_NUMBER}`) {
          return new Response(
            JSON.stringify({
              state: 'open',
              merged: false,
              merged_at: null,
              head: { ref: BRANCH_DO_PR, repo: { full_name: PROJETO.wingId } },
            }),
            { status: 200 }
          )
        }
        if (u === `${GITHUB_API}/repos/${PROJETO.wingId}/pulls/${PR_NUMBER}/reviews?per_page=100`) {
          return new Response(
            JSON.stringify([
              {
                state: 'CHANGES_REQUESTED',
                user: { login: 'gitorch-ai[bot]' },
                body: 'Parecer do QA: conserte o teste de checkout.',
              },
            ]),
            { status: 200 }
          )
        }
        if (u === `${JULES_API}/sessions` && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          chamadasAoJules.push({ body })
          return new Response(JSON.stringify({ name: 'sessions/retomada-nova' }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Prova positiva: a sessão nova foi pedida ao Jules — o disparo real do
    // caminho de retomada, não uma decisão pura testada com deps falsos.
    await vi.waitFor(
      () => {
        expect(chamadasAoJules.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    // A sessão nova nasce NA MESMA branch do PR reprovado — startingBranch E
    // workingBranch, nunca deixando o Jules escolher um ramo novo (que
    // criaria um PR NOVO do zero, o próprio defeito medido em #3884).
    const sourceContext = chamadasAoJules[0]!.body['sourceContext'] as Record<string, unknown>
    expect(sourceContext['workingBranch']).toBe(BRANCH_DO_PR)
    const githubCtx = sourceContext['githubRepoContext'] as Record<string, unknown>
    expect(githubCtx['startingBranch']).toBe(BRANCH_DO_PR)

    // A linha antiga fecha (a vaga da conta precisa voltar) — isto É
    // esperado e intencional, não o defeito. O que prova que a issue NÃO
    // ficou presa em "pr-rejeitado-sem-retomada" sem ninguém trabalhando
    // nela é a linha NOVA registrando o MESMO número de PR logo a seguir.
    await vi.waitFor(() => {
      const registrouPr = prisma._updateCalls.some(
        (c) =>
          (c.where as { sessionName?: string }).sessionName === 'sessions/retomada-nova' &&
          c.data['pullRequestNumber'] === PR_NUMBER
      )
      expect(registrouPr).toBe(true)
    })

    const abriuSessaoNova = prisma._upsertCalls.some(
      (c) => (c.where as { sessionName?: string }).sessionName === 'sessions/retomada-nova'
    )
    expect(abriuSessaoNova).toBe(true)
  })
})
