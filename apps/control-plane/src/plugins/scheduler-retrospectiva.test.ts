import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// POR QUE ESTE ARQUIVO EXISTE — o achado mais grave da revisão.
//
// A primeira versão da retrospectiva guardava "quando foi a última" numa
// variável, inicializada no registro do plugin. Com cadência semanal e um
// serviço que reinicia várias vezes por dia — quatro vezes só em 23/08 —, o
// relógio zerava antes de a semana passar e a cerimônia NUNCA RODARIA.
//
// Compilando. Com onze testes verdes na função de medida. E sem executar uma
// única vez em produção.
//
// É a pior classe de defeito que existe aqui: a esteira ganharia a capacidade
// de medir a si mesma, o quadro diria que a tarefa está pronta, e nada teria
// acontecido de verdade. Este arquivo prende o comportamento pelo caminho REAL
// do plugin — se a marca durável sumir, ele quebra.
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  isActive: true,
  user: { email: 'dono@exemplo.com' },
  runtimeConfig: null,
} as const

const ENV_KEYS = ['NODE_ENV', 'GITORCH_SCHEDULER_TICK_MS', 'JULES_API_KEY', 'GITORCH_GITHUB_TOKEN']

function buildFakePrisma(opcoes: { ultimaRetro: Date | null; sessoes?: unknown[] }) {
  const eventosCriados: Array<{
    type: string
    projectId: string
    payload: unknown
    createdAt: Date
  }> = []
  return {
    prisma: {
      mission: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
        create: vi.fn(async () => ({ id: 'm1' })),
      },
      project: {
        findMany: vi.fn(async () => [PROJETO]),
        findUnique: vi.fn(async () => PROJETO),
      },
      devSession: {
        findMany: vi.fn(async () => opcoes.sessoes ?? []),
        update: vi.fn(async () => undefined),
      },
      // O falso PERSISTE de verdade: `findFirst` enxerga o que `create`
      // acabou de gravar. Sem isso o teste mentiria nos dois sentidos — a
      // guarda pareceria quebrada aqui e funcionaria em produção, ou o
      // contrário.
      event: {
        findFirst: vi.fn(async () => {
          const ultimoCriado = eventosCriados[eventosCriados.length - 1]
          if (ultimoCriado) return { createdAt: ultimoCriado.createdAt }
          return opcoes.ultimaRetro ? { createdAt: opcoes.ultimaRetro } : null
        }),
        create: vi.fn(
          async (args: { data: { type: string; projectId: string; payload: unknown } }) => {
            eventosCriados.push({ ...args.data, createdAt: new Date() })
            return { id: 'e1' }
          }
        ),
      },
      projectSchedule: { findMany: vi.fn(async () => []) },
      telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
    },
    eventosCriados,
  }
}

describe('a retrospectiva RODA — e sobrevive ao reinício', () => {
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
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
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

  test('NUNCA rodou antes: roda no primeiro tique depois de subir', async () => {
    // Este é o teste que a versão anterior não passava. Ela dependia de uma
    // variável em memória e, num serviço que reinicia, a semana nunca vencia.
    const fake = buildFakePrisma({ ultimaRetro: null })
    app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => expect(fake.eventosCriados.some((e) => e.type === 'ceremony-retro')).toBe(true),
      { timeout: 8000, interval: 20 }
    )
  }, 30000)

  test('rodou HÁ POUCO: não roda de novo — a marca do banco segura', async () => {
    const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const fake = buildFakePrisma({ ultimaRetro: ontem })
    app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)

    await new Promise((r) => setTimeout(r, 600))
    expect(fake.eventosCriados.filter((e) => e.type === 'ceremony-retro')).toHaveLength(0)
  }, 30000)

  test('rodou HÁ MAIS DE UMA SEMANA: roda de novo', async () => {
    const semanaPassada = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const fake = buildFakePrisma({ ultimaRetro: semanaPassada })
    app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => expect(fake.eventosCriados.some((e) => e.type === 'ceremony-retro')).toBe(true),
      { timeout: 8000, interval: 20 }
    )
  }, 30000)

  test('semana SEM DADOS também deixa marca — senão tentaria a cada tique', async () => {
    const fake = buildFakePrisma({ ultimaRetro: null, sessoes: [] })
    app = Fastify({ logger: false })
    app.decorate('prisma', fake.prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const marcas = fake.eventosCriados.filter((e) => e.type === 'ceremony-retro')
        expect(marcas).toHaveLength(1)
        expect((marcas[0]!.payload as { semDados: boolean }).semDados).toBe(true)
      },
      { timeout: 8000, interval: 20 }
    )

    // E não repete: a marca segura as rodadas seguintes.
    await new Promise((r) => setTimeout(r, 400))
    expect(fake.eventosCriados.filter((e) => e.type === 'ceremony-retro')).toHaveLength(1)
  }, 30000)
})
