import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Trava de entrega no seam REAL: registra o schedulerPlugin de verdade, com o
// relógio andando, e prova pelas chamadas ao banco que, com a trava ligada,
// nenhuma etapa que INICIA trabalho acontece (agendas, missões de setup,
// retomadas), enquanto as etapas de manutenção seguem rodando e o que já está
// `running` não é tocado. Soltando a trava, as mesmas etapas voltam sozinhas.
//
// Sem tempo real: o teste espera por contagem de chamadas (uma etapa que roda
// sempre prova que tiques completos aconteceram), nunca por pausa fixa.

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_SCHEDULER_TICK_RAPIDO_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

type Chamada = string

function buildFakePrisma(estado: { ligada: boolean; ilegivel?: boolean }) {
  const chamadas: Chamada[] = []
  const argumentos: Record<string, unknown[]> = {}
  const contar = (chave: string) => chamadas.filter((c) => c === chave).length
  const retornos: Record<string, unknown> = {
    findMany: [],
    findFirst: null,
    findUnique: null,
    count: 0,
    updateMany: { count: 0 },
    aggregate: { _sum: { tokensUsed: 0 } },
    groupBy: [],
  }
  const modelo = (nome: string) =>
    new Proxy(
      {},
      {
        get: (_alvo, metodo: string) => {
          return async (args?: unknown) => {
            chamadas.push(`${nome}.${metodo}`)
            ;(argumentos[`${nome}.${metodo}`] ??= []).push(args)
            if (nome === 'travaDeEntrega' && metodo === 'findUnique') {
              if (estado.ilegivel) throw new Error('banco fora do ar')
              return estado.ligada
                ? { id: 'entrega', ligada: true, desde: new Date(), motivo: 'm', ligadaPor: 'p' }
                : null
            }
            if (nome === 'mission' && metodo === 'findMany') {
              const tipo = (args as { where?: { type?: string } } | undefined)?.where?.type
              if (tipo === 'clone_and_start_engines') chamadas.push('mission.findMany#setup')
            }
            return retornos[metodo] ?? null
          }
        },
      }
    )
  const prisma = new Proxy(
    { $queryRaw: async () => [1], $queryRawUnsafe: async () => [] },
    {
      // Neste dublê, qualquer modelo "existe", inclusive o da trava.
      has: () => true,
      get: (alvo, nome: string) => {
        if (nome in alvo) return (alvo as Record<string, unknown>)[nome]
        return modelo(nome)
      },
    }
  )
  return { prisma, chamadas, contar, argumentos }
}

describe('a trava de entrega no relógio do agendador (real seam)', () => {
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
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '15'
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as never
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

  async function subir(estado: { ligada: boolean; ilegivel?: boolean }) {
    const fake = buildFakePrisma(estado)
    app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)
    return fake
  }

  test('ligada: manutenção segue, nada que inicia trabalho acontece; solta: volta sozinho', async () => {
    const estado = { ligada: true }
    const fake = await subir(estado)

    // A faxina de ambientes roda em TODO tique: três chamadas = pelo menos dois
    // tiques completos já passaram.
    await vi.waitFor(
      () => expect(fake.contar('clientEnvironment.findMany')).toBeGreaterThanOrEqual(3),
      {
        timeout: 4000,
        interval: 5,
      }
    )

    // Nenhuma agenda foi lida (disparar agendas), nenhuma missão de setup foi
    // procurada para ser tomada, nenhuma espera-por-cota foi retomada.
    expect(fake.contar('projectSchedule.findMany')).toBe(0)
    expect(fake.contar('mission.findMany#setup')).toBe(0)
    // Nunca criou missão, nunca tomou missão para `running`.
    expect(fake.contar('mission.create')).toBe(0)

    // Solta a trava: as etapas de início voltam sozinhas (a leitura da trava
    // expira em 1,5 s).
    estado.ligada = false
    await vi.waitFor(() => expect(fake.contar('projectSchedule.findMany')).toBeGreaterThan(0), {
      timeout: 6000,
      interval: 10,
    })
    await vi.waitFor(() => expect(fake.contar('mission.findMany#setup')).toBeGreaterThan(0), {
      timeout: 6000,
      interval: 10,
    })
  })

  test('ligada: disparar um papel recusa com em-entrega e não cria missão', async () => {
    const estado = { ligada: true }
    const fake = await subir(estado)
    await app!.ready()
    const resultado = await app!.triggerAgentMission('ra')
    expect(resultado).toEqual({ triggered: false, reason: 'em-entrega' })
    expect(fake.contar('mission.create')).toBe(0)

    // O que já está rodando segue o seu curso: a limpeza de missão presa
    // continua valendo para `running` vencida, mas uma `pending` que espera a
    // troca acabar NÃO é dada como presa só porque a fila parou.
    const limpeza = fake.argumentos['mission.updateMany']!.at(-1) as {
      where: { OR: Array<{ status: string }> }
    }
    expect(limpeza.where.OR.map((c) => c.status)).toEqual(['running'])
  })

  test('FAIL-SAFE: sem conseguir ler a trava, não cria missão (trabalho novo adiado)', async () => {
    const fake = await subir({ ligada: false, ilegivel: true })
    await app!.ready()
    const resultado = await app!.triggerAgentMission('ra')
    expect(resultado).toEqual({ triggered: false, reason: 'em-entrega' })
    expect(fake.contar('mission.create')).toBe(0)
  })
})
