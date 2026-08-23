import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// POR QUE ESTE ARQUIVO EXISTE — a aceleração é o pedaço perigoso.
//
// A primeira varredura em produção (22/08/2026, 23:02) mediu 1978 vagas sem
// dono. Mesmo com o teto novo de duzentas por rodada, a cadência de hora cheia
// levaria dez horas para esvaziar. Por isso a varredura passa a voltar em cinco
// minutos ENQUANTO SOBRAR FILA.
//
// O risco é o oposto do problema: acelerar quando NÃO se sabe nada. Fornecedor
// fora do ar, banco fora do ar, ou o banco devolvendo zero linhas com o
// fornecedor cheio — nos três casos a varredura aborta sem tocar em nada, e
// acelerar ali seria bater de cinco em cinco minutos num serviço que já não
// está respondendo. Este arquivo prende essa distinção pelo caminho REAL do
// plugin, não por reimplementação da regra.
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
  'JULES_API_KEY',
  'GITORCH_RECONCILIACAO_CADENCIA_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

/** Sessões do fornecedor: velhas o bastante para passar da guarda de idade. */
function sessoesDoFornecedor(quantas: number) {
  const nascidaEm = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  return Array.from({ length: quantas }, (_, i) => ({
    name: `sessions/orfa-${i}`,
    createTime: nascidaEm,
  }))
}

function buildFakePrisma(vivas: string[]) {
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: { findUnique: vi.fn(async () => PROJETO), findMany: vi.fn(async () => []) },
    devSession: {
      findMany: vi.fn(async (args: { select?: { sessionName?: boolean } }) => {
        if (args?.select?.sessionName) return vivas.map((sessionName) => ({ sessionName }))
        return []
      }),
      update: vi.fn(async () => undefined),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
  }
}

describe('a varredura acelera enquanto há fila — e só enquanto há fila', () => {
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
    process.env['JULES_API_KEY'] = 'chave-de-teste'
    // A cadência é o único botão desta engrenagem; a espera inicial e a
    // cadência acelerada DERIVAM dela (um doze avos). Com 1200ms aqui, a
    // primeira varredura sai em 100ms e a acelerada também — é assim que este
    // teste consegue observar o comportamento REAL do plugin, sem esperar
    // cinco minutos de relógio nem reimplementar a regra.
    // 6000ms: a acelerada vira 500ms (um doze avos) e a normal fica em 6000.
    //
    // Era 1200/100, e a banda de 700ms entre as duas ficou APERTADA DEMAIS —
    // rodando a suíte inteira em paralelo, a segunda varredura às vezes não
    // terminava a tempo e o teste piscava. Teste que pisca é pior que teste
    // que falta: ensina a ignorar vermelho. A banda agora é de 500ms a 6000ms,
    // com folga de sobra para carga, e continua discriminando exatamente a
    // mesma coisa.
    process.env['GITORCH_RECONCILIACAO_CADENCIA_MS'] = '6000'
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

  test('com fila sobrando, a varredura VOLTA em minutos — não espera a hora cheia', async () => {
    // Mais órfãs que o teto: é o caso real de produção. Sem a aceleração, a
    // segunda varredura só sairia daqui a uma hora, e as 1978 vagas levariam
    // dez horas para serem devolvidas.
    const arquivadas: string[] = []
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.includes(':archive')) {
        arquivadas.push(u)
        return new Response('{}', { status: 200 })
      }
      if (u.includes('/sessions?')) {
        return new Response(JSON.stringify({ sessions: sessoesDoFornecedor(400) }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma(['sessions/viva']) as never)
    await app.register(schedulerPlugin)

    // Teto de 200 por rodada: a PRIMEIRA varredura arquiva 200 e sobra fila.
    await vi.waitFor(() => expect(arquivadas.length).toBe(200), { timeout: 8000, interval: 20 })

    // A PROVA da aceleração, e a janela é o que a torna prova.
    //
    // A revisão pegou este teste frouxo: com espera de 15 segundos, a cadência
    // NORMAL (1200ms aqui) também caberia dentro dela, e o teste passaria
    // mesmo com a aceleração removida — provando nada. A janela agora fica
    // ENTRE a cadência acelerada (100ms, um doze avos) e a normal (1200ms),
    // igual às duas irmãs abaixo. Sem aceleração, este `waitFor` estoura.
    await vi.waitFor(() => expect(arquivadas.length).toBeGreaterThan(200), {
      timeout: 3000,
      interval: 20,
    })
  }, 30000)

  test('fornecedor MUDO não acelera nada — abortar é o oposto de "tem mais fila"', async () => {
    // Insistir de cinco em cinco minutos contra um serviço que está devolvendo
    // erro é alimentar o problema. A varredura aborta e volta à hora cheia.
    let listagens = 0
    const arquivadas: string[] = []
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.includes(':archive')) {
        arquivadas.push(u)
        return new Response('{}', { status: 200 })
      }
      if (u.includes('/sessions?')) {
        listagens += 1
        return new Response('erro', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma(['sessions/viva']) as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(() => expect(listagens).toBeGreaterThanOrEqual(1), {
      timeout: 8000,
      interval: 20,
    })

    // A janela é deliberada: 3000ms passa MUITO da cadência acelerada (500ms,
    // um doze avos de 6000) e fica bem abaixo da normal (6000ms). Se a
    // varredura tivesse acelerado, teria voltado várias vezes aqui dentro.
    // Não voltou nenhuma.
    await new Promise((r) => setTimeout(r, 3000))
    expect(listagens).toBe(1)
    expect(arquivadas).toEqual([])
  }, 30000)

  test('sem fila sobrando, não acelera: arquiva o que há e para', async () => {
    const arquivadas: string[] = []
    let listagens = 0
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url)
      if (u.includes(':archive')) {
        arquivadas.push(u)
        return new Response('{}', { status: 200 })
      }
      if (u.includes('/sessions?')) {
        listagens += 1
        return new Response(JSON.stringify({ sessions: sessoesDoFornecedor(3) }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma(['sessions/viva']) as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(() => expect(arquivadas.length).toBe(3), { timeout: 8000, interval: 20 })
    // Mesma janela do teste acima, pelo mesmo motivo: acima da cadência
    // acelerada, abaixo da normal.
    await new Promise((r) => setTimeout(r, 3000))
    expect(listagens).toBe(1)
    expect(arquivadas).toHaveLength(3)
  }, 30000)

  test('cadência INVÁLIDA cai no padrão seguro — não vira varredura a cada minuto', async () => {
    // `Number('') === 0` e `Number('abc')` é NaN, e o `??` não protege nenhum
    // dos dois: ele só age em null/undefined. Com 0 ou NaN, a comparação de
    // cadência é sempre falsa e a varredura passaria a rodar a cada tique —
    // até cem páginas e duzentos arquivamentos contra o fornecedor, de minuto
    // em minuto, por causa de um erro de digitação no arquivo de ambiente.
    process.env['GITORCH_RECONCILIACAO_CADENCIA_MS'] = 'nao-e-numero'

    let listagens = 0
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('/sessions?')) {
        listagens += 1
        return new Response(JSON.stringify({ sessions: sessoesDoFornecedor(3) }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma(['sessions/viva']) as never)
    await app.register(schedulerPlugin)

    // Com o padrão de uma hora, a espera inicial é de cinco minutos: nada pode
    // acontecer nesta janela. Se o valor inválido tivesse virado 0 ou NaN, a
    // varredura já teria rodado várias vezes aqui dentro.
    await new Promise((r) => setTimeout(r, 1500))
    expect(listagens).toBe(0)
  }, 30000)

  test('cadência ZERO também cai no padrão — zero não é "sempre"', async () => {
    process.env['GITORCH_RECONCILIACAO_CADENCIA_MS'] = '0'

    let listagens = 0
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('/sessions?')) {
        listagens += 1
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    app = Fastify({ logger: false })
    app.decorate('prisma', buildFakePrisma(['sessions/viva']) as never)
    await app.register(schedulerPlugin)

    await new Promise((r) => setTimeout(r, 1500))
    expect(listagens).toBe(0)
  }, 30000)
})
