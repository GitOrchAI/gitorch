import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Task fix-scheduler-tick-cabe: medido em produção (deploy 28/09 14:46 UTC,
// commit e6853b3e) — 13 disparos do `setInterval` principal pulados em 19min
// (15:15:24 → 15:34:24 UTC, journal do systemd), porque `tick()` faz ~28
// passos sequenciais de I/O de rede e rotineiramente ultrapassa os 60s do
// intervalo. Consequência real: `varrerPrsOrfaos` (vigia-do-pr) — que decide
// quem é adiado pelo teto de ações por passada — deixa de rodar em vários
// ciclos seguidos, e o PR adiado só é reexaminado 6h depois (cadência de
// `varrerPrsOrfaos`), na MESMA ordem, correndo risco de ser adiado de novo.
//
// Este arquivo prova, pelo "real seam" (mesmo padrão de
// scheduler-tick-sem-sobreposicao.test.ts): com o `tick()` PRINCIPAL
// deliberadamente travado numa chamada de rede que SÓ ele faz (a descoberta
// de mecanismo de publicação, `/repos/.../environments`, dentro de
// `varrerPublicacoes` — um dos ~24 passos que ficam no tick grande), o
// `tickRapido` — com seu PRÓPRIO `setInterval` — ainda assim dispara
// `varrerPrsOrfaos` (e os 3 drenos) várias vezes dentro de uma janela curta.
// Sem o relógio próprio, isso seria zero disparos até o tick principal (que
// aqui nunca termina) liberar a vez.
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
  stateCheckedAt: new Date(),
  reworkNoticePending: null,
  reworkNoticeAttempts: 0,
  pendingSince: null,
  mergeCommitSha: 'deadbeef',
  deployState: null,
  deployCheckedAt: null,
  mergeFailures: 0,
  mergeLastFailedAt: null,
  closedAt: null,
} as const

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_SCHEDULER_TICK_RAPIDO_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

/**
 * A "impressão digital" da consulta que só `varrerPrsOrfaos` faz: o único
 * `project.findMany` do arquivo com `select.devPlan` (ver scheduler.ts,
 * ~linha 7218). Nenhuma das outras ~15 chamadas de `project.findMany` no
 * arquivo seleciona `devPlan` — é uma marca segura de que foi ELE quem
 * rodou, sem precisar exportar `tickRapido` nem mexer no plugin para testar.
 */
function ehConsultaDoVigiaDoPr(args: unknown): boolean {
  const select = (args as { select?: Record<string, unknown> } | undefined)?.select
  return select?.['devPlan'] === true
}

function buildFakePrisma(chamadasDoVigia: unknown[]) {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async (args: unknown) => {
        if (ehConsultaDoVigiaDoPr(args)) chamadasDoVigia.push(args)
        return []
      }),
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) return [SESSAO_MESCLADA]
        return []
      }),
      update: vi.fn(async () => undefined),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
  }
}

describe('tickRapido — independente do tick principal (task fix-scheduler-tick-cabe)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    // Minúsculo para o principal: ele dispara logo, entra em
    // `varrerPublicacoes` e trava para sempre no fetch de environments
    // (abaixo) — depois disso, `tickEmAndamento` nunca mais libera dentro da
    // janela deste teste.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    // Minúsculo para o rápido: precisa disparar várias vezes dentro da janela
    // curta de espera real do teste.
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '15'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
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

  test('varrerPrsOrfaos dispara várias vezes mesmo com o tick principal travado para sempre', async () => {
    let chamadasAoEnvironments = 0
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.endsWith('/repos/acme/api/environments')) {
        chamadasAoEnvironments++
        // NUNCA resolve: simula o tick principal ultrapassando os 60s do
        // intervalo de verdade — dentro da janela deste teste, ele não
        // termina jamais.
        return await new Promise<Response>(() => {})
      }
      if (u.includes('/pulls?state=open')) {
        // Não deveria ser alcançado: `project.findMany` (mock acima) já
        // devolve `[]`, então o laço de `varrerPrsOrfaos` não itera projeto
        // nenhum e não chega a pedir a lista de pull requests. Se isto for
        // chamado, algo no teste está errado.
        throw new Error('não deveria listar PRs — a lista de projetos está vazia no fake')
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const chamadasDoVigia: unknown[] = []
    const prisma = buildFakePrisma(chamadasDoVigia)
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Tempo real de sobra: várias janelas de 15ms do `tickRapido` cabem aqui,
    // enquanto o tick principal (também disparado por volta dos 15ms) ficou
    // preso para sempre na primeira chamada de rede que só ele faz.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(chamadasAoEnvironments).toBe(1) // o tick principal começou, travou, e nunca mais tentou de novo
    expect(chamadasDoVigia.length).toBeGreaterThanOrEqual(2) // o tickRapido não ficou refém dele
  })
})
