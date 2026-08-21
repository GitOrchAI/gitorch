import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Importante 8 da revisão final da branch — "duas varreduras podem rodar ao
// mesmo tempo": `tick()` faz I/O de rede SEQUENCIAL através de vários
// projetos (reconferir acesso, vigia pré-merge, vigia de publicação,
// agendas...). Um tique que demora mais que o próprio intervalo do
// `setInterval` (`GITORCH_SCHEDULER_TICK_MS`) permitia um SEGUNDO `tick()`
// nascer por cima do primeiro ainda rodando — e o dedupe de aviso em
// `varrerPublicacoes` (`estadoAnterior`, lido antes de escrever) é
// ler-depois-escrever, não atômico: os dois ticks avisariam o dono e
// fechariam a mesma sessão em duplicidade.
//
// Este arquivo prova a trava pelo "real seam": um intervalo de tique
// minúsculo (15ms) e uma resposta de rede deliberadamente LENTA (150ms) —
// sem a trava, vários disparos do `setInterval` cairiam dentro da janela
// lenta e chamariam a mesma rota concorrentemente. Com a trava, nenhum
// segundo tique começa antes do primeiro terminar.
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
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

function buildFakePrisma() {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
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

describe('tick — Importante 8 (trava de sobreposição)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    // Minúsculo: várias janelas do `setInterval` cabem dentro dos 150ms da
    // resposta lenta abaixo — é o que exercita (ou não, com a trava) a
    // sobreposição.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
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

  test('duas varreduras nunca correm ao mesmo tempo — a chamada lenta nunca vê concorrência', async () => {
    let concorrentes = 0
    let picoDeConcorrencia = 0
    let chamadasAoEnvironments = 0
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.endsWith('/repos/acme/api/environments')) {
        chamadasAoEnvironments++
        concorrentes++
        picoDeConcorrencia = Math.max(picoDeConcorrencia, concorrentes)
        await new Promise((resolve) => setTimeout(resolve, 150))
        concorrentes--
        return new Response(JSON.stringify({ environments: [] }), { status: 200 })
      }
      if (u.endsWith('/repos/acme/api/actions/workflows')) {
        return new Response(JSON.stringify({ workflows: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Tempo real de sobra: várias janelas de 15ms cabem antes da primeira
    // chamada lenta (150ms) sequer terminar — o cenário exato em que, sem a
    // trava, o `setInterval` dispararia um segundo `tick()` por cima do
    // primeiro.
    await new Promise((resolve) => setTimeout(resolve, 450))

    expect(picoDeConcorrencia).toBeLessThanOrEqual(1)
    // Com a trava, o segundo tique só começa DEPOIS do primeiro terminar —
    // e como o mecanismo fica em cache por uma hora, a rede não é chamada de
    // novo nas janelas seguintes dentro deste teste.
    expect(chamadasAoEnvironments).toBe(1)
  })
})
