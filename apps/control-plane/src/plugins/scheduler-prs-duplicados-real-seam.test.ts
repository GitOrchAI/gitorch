import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { marcadorDePrSubstituido } from '../services/pr-substituido.js'

// C10 (fix-up L4-T5, CSO) — CASO LEGADO aceito como referência: "#3907
// fechado como substituído por #3917" (issue #3884 do Jardim, 5 sessões e 3
// pull requests para uma task, MEDIDO 02/09/2026). A fila
// (fila-de-delegacao.ts), a retomada no mesmo PR (retomar-pr-reprovado.ts) e
// o fecho automático do antigo quando um NOVO nasce (pr-substituido.ts,
// github-webhook.ts) juntos só cobrem o que acontece DAQUI PARA FRENTE — a
// varredura periódica (`varrerPrsDuplicadosDosProjetos`, scheduler.ts) é a
// rede de segurança para o par que já existia ANTES desses consertos.
//
// Mesmo "real seam" dos irmãos (`scheduler-vigia-pre-merge-real-seam.test.ts`
// etc.): registra o `schedulerPlugin` de VERDADE, deixa o próprio
// `setInterval` de produção disparar `tick` -> `varrerPrsDuplicadosDosProjetos`,
// e prova o resultado observável — os PRs antigos comentados+fechados via
// `fetch`, o mais novo nunca tocado.
//
// `project.findMany({ where: { isActive: true } })` é chamado por VÁRIAS
// varreduras do tique (vigia-do-pr, quadro, sprint...) com `select`
// diferentes — o fake só devolve o projeto para o `select` EXATO desta
// varredura (`{ id, wingId }`, 2 campos), e `[]` para qualquer outro,
// desligando as varreduras irmãs de propósito: este arquivo prova SÓ o
// caminho de PRs duplicados, como os outros `*-real-seam` prova cada um o
// seu próprio recorte.

const PROJETO = {
  id: 'proj_dup',
  wingId: 'loureng/patinhas-3d-crafts',
  name: 'Patinhas 3D Crafts',
  userId: null,
  runtimeConfig: null,
  isActive: true,
  autonomia: 'cuidar',
  devPlan: null,
  devAccountId: null,
} as const

function ehSelectDaVarreduraDePrsDuplicados(select: unknown): boolean {
  if (!select || typeof select !== 'object') return false
  const chaves = Object.keys(select as Record<string, unknown>).sort()
  return chaves.length === 2 && chaves[0] === 'id' && chaves[1] === 'wingId'
}

function buildFakePrisma() {
  const eventos: unknown[] = []
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findMany: vi.fn(async (args: { where?: { isActive?: boolean }; select?: unknown }) => {
        if (args?.where?.isActive && ehSelectDaVarreduraDePrsDuplicados(args.select)) {
          return [PROJETO]
        }
        return []
      }),
      findUnique: vi.fn(async () => PROJETO),
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      findMany: vi.fn(
        async (args: {
          where?: { pullRequestNumber?: unknown; projectId?: string; mergeCommitSha?: unknown }
          distinct?: unknown
        }) => {
          if (args?.where?.mergeCommitSha) return []
          if (args?.distinct) return []
          if (args?.where?.pullRequestNumber && args.where.projectId === PROJETO.id) {
            // As 5 sessões medidas da issue #3884 — 3 números de PR distintos.
            return [
              { issueNumber: 3884, pullRequestNumber: 3907 },
              { issueNumber: 3884, pullRequestNumber: 3907 },
              { issueNumber: 3884, pullRequestNumber: 3913 },
              { issueNumber: 3884, pullRequestNumber: 3917 },
              { issueNumber: 3884, pullRequestNumber: 3917 },
            ]
          }
          // Varredura GLOBAL (closedAt: null) — ciclo terminal/abandono: nenhuma
          // sessão viva, de propósito (fora do escopo deste arquivo).
          return []
        }
      ),
      update: vi.fn(async () => undefined),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    event: {
      create: vi.fn(async (args: unknown) => {
        eventos.push(args)
        return undefined
      }),
      count: vi.fn(async () => 0),
    },
    _eventos: eventos,
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
  'GITORCH_VARREDURA_DE_PRS_DUPLICADOS_CADENCIA_MS',
]

function prDoDev(numero: number, estado: 'open' | 'closed') {
  return {
    number: numero,
    state: estado,
    user: { login: 'google-labs-jules[bot]' },
    labels: [],
    body:
      `*PR created automatically by Jules for task [12112302527133030906]` +
      `(https://jules.google.com/task/12112302527133030906) started by @loureng*`,
  }
}

describe('varredura de PRs duplicados do dev (real seam, C10/L4-T5)', () => {
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

  test('issue com 3 PRs abertos do dev termina com 1 aberto e 2 fechados com o marcador', async () => {
    const chamadasDeFechamento: Array<{ numero: number }> = []
    const chamadasDeComentario: Array<{ numero: number; body: string }> = []

    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        const method = (init?.method ?? 'GET').toUpperCase()

        const mPull = /\/pulls\/(\d+)$/.exec(u)
        if (mPull && method === 'GET') {
          const n = Number(mPull[1])
          return new Response(JSON.stringify(prDoDev(n, 'open')), { status: 200 })
        }
        if (mPull && method === 'PATCH') {
          chamadasDeFechamento.push({ numero: Number(mPull[1]) })
          return new Response(JSON.stringify({}), { status: 200 })
        }
        const mComments = /\/issues\/(\d+)\/comments/.exec(u)
        if (mComments && method === 'GET') {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if (mComments && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { body: string }
          chamadasDeComentario.push({ numero: Number(mComments[1]), body: body.body })
          return new Response(JSON.stringify({}), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(chamadasDeFechamento.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 3000, interval: 10 }
    )

    // Os DOIS antigos fecharam — nunca o mais novo (#3917).
    expect(chamadasDeFechamento.map((c) => c.numero).sort()).toEqual([3907, 3913])
    expect(chamadasDeComentario.map((c) => c.numero).sort()).toEqual([3907, 3913])
    for (const c of chamadasDeComentario) {
      expect(c.body).toContain(marcadorDePrSubstituido(3917))
      expect(c.body).toContain('#3917')
    }
    // O mais novo NUNCA recebe PATCH nem comentário.
    expect(chamadasDeFechamento.some((c) => c.numero === 3917)).toBe(false)
    expect(chamadasDeComentario.some((c) => c.numero === 3917)).toBe(false)
  })
})
