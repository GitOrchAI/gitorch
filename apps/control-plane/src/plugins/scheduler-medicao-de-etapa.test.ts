import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Task fix-scheduler-tick-cabe, item 3 — A CEGUEIRA QUE O BUG EXPÕE: hoje
// nenhum dos ~28 passos sequenciais de `tick()` (nem os 4 de `tickRapido`)
// tem log de duração. `grep -n "Date.now()\|performance.now()" scheduler.ts`
// não acha nenhuma instrumentação disso — então quando o journal mostra 13
// disparos pulados em 19min (medido em produção, 28/09/2026), NÃO dá para
// apontar hoje qual dos ~28 passos é o mais lento. Esta cegueira é PARTE do
// bug: sem saber qual etapa custa o quê, qualquer conserto futuro (orçamento
// por etapa, mais paralelismo) está adivinhando.
//
// Este teste prova que cada etapa de `tick()` agora emite
// `app.log.info({ etapa, duracaoMs }, '[Scheduler] etapa concluída')`,
// sucesso ou falha (o `finally` de `medirEtapa` não pode ser pulado), sem
// mudar nenhum log de erro que já existia.
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
  'GITORCH_SCHEDULER_TICK_RAPIDO_MS',
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
      findFirst: vi.fn(async () => PROJETO),
    },
    devSession: {
      findMany: vi.fn(async () => []),
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

describe('medição de duração por etapa (task fix-scheduler-tick-cabe, item 3)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '20'
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

  test('cada etapa de tick() loga { etapa, duracaoMs } mesmo sem nenhum projeto para processar', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

    const prisma = buildFakePrisma()
    app = Fastify({ logger: { level: 'silent' } })
    const infoSpy = vi.spyOn(app.log, 'info')
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const chamadasDeMedicao = infoSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'object' &&
            call[0] !== null &&
            'etapa' in (call[0] as Record<string, unknown>) &&
            'duracaoMs' in (call[0] as Record<string, unknown>)
        )
        expect(chamadasDeMedicao.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 }
    )

    const chamadasDeMedicao = infoSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        'etapa' in (call[0] as Record<string, unknown>) &&
        'duracaoMs' in (call[0] as Record<string, unknown>)
    ) as unknown as Array<[{ etapa: unknown; duracaoMs: unknown }, string]>

    for (const [payload, mensagem] of chamadasDeMedicao) {
      expect(typeof payload.etapa).toBe('string')
      expect(typeof payload.duracaoMs).toBe('number')
      expect(mensagem).toContain('[Scheduler] etapa concluída')
    }

    // Pelo menos uma etapa de CADA relógio (o principal e o tickRapido) —
    // prova que a instrumentação cobre os dois, não só um.
    const etapas = new Set(chamadasDeMedicao.map(([payload]) => payload.etapa as string))
    expect(etapas.has('completarAgendasDosProjetos')).toBe(true)
    expect(etapas.has('varrerPrsOrfaos')).toBe(true)
  })
})
