import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { encryptCredential } from '../lib/credential-crypto.js'
import { hojeNoFuso } from '../services/garantir-sprint.js'

/**
 * POR QUE ESTE ARQUIVO EXISTE — a caixa que dá nome à tarefa nunca tinha rodado.
 *
 * `preencherSprintCorrente` (o serviço) foi provado com mutação e no quadro
 * real. Quem o CHAMA — `varrerItensDaSprint`, dentro do relógio — não tinha um
 * teste sequer, e é exatamente o defeito que esta leva inteira persegue:
 * código que existe e ninguém aciona. `resolver-quadro.ts` e
 * `garantir-sprint.ts` estavam nessa situação — construídos, testados, e sem
 * nenhum caminho de produção chamando.
 *
 * Aqui não há serviço chamado direto: registra-se o `schedulerPlugin` de
 * VERDADE, deixa-se o `setInterval` de produção disparar, e a única coisa
 * fingida é a rede (`global.fetch`) e o banco. Tudo o mais é o caminho real.
 */

const REPO = 'acme/api'
const QUADRO_ID = 'PVT_quadro_do_cliente'
const CAMPO_ID = 'PVTIF_sprint'
const ITERACAO_CORRENTE = 'IT_de_hoje'
const ITERACAO_ALHEIA = 'IT_de_outro_ciclo'
const TOKEN_DO_CLIENTE = 'ghp_token_do_cliente'

/** O item do quadro de cada pedido — o id que a escrita tem que citar. */
const ITEM = {
  10: 'ITEM_da_issue_10',
  11: 'ITEM_do_pr_11',
  20: 'ITEM_da_issue_20',
  21: 'ITEM_da_issue_21',
  99: 'ITEM_do_backlog_99',
} as const

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_SPRINT_ITENS_CADENCIA_MS',
  'GITORCH_GITHUB_TOKEN',
  'JULES_API_KEY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'GITORCH_SELF_REPO',
]

interface ProjetoFalso {
  id: string
  name: string
  wingId: string
  autonomia: string | null
  sprintDias: number | null
  userId: string | null
  isActive: boolean
  encryptedClientToken: string | null
}

function projeto(over: Partial<ProjetoFalso> = {}): ProjetoFalso {
  return {
    id: 'proj_sprint',
    name: 'Acme API',
    wingId: REPO,
    autonomia: 'sugerir',
    sprintDias: 3,
    userId: null,
    isActive: true,
    encryptedClientToken: encryptCredential(TOKEN_DO_CLIENTE),
    ...over,
  }
}

/** Sessões vivas por projeto — a primeira fonte de trabalho ativo. */
type SessoesVivas = Record<string, Array<{ issueNumber: number; pullRequestNumber: number | null }>>

function buildFakePrisma(projetos: ProjetoFalso[], sessoes: SessoesVivas) {
  const porId = new Map(projetos.map((p) => [p.id, p]))
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      // As DUAS varreduras de sprint pedem `wingId` + `autonomia`. As outras
      // varreduras do tique pedem outra coisa e recebem lista vazia, para não
      // arrastar este cenário para dentro de engrenagem que não é a testada.
      findMany: vi.fn(async (args: { select?: Record<string, boolean> }) => {
        if (args?.select?.['wingId'] && args?.select?.['autonomia']) return projetos
        return []
      }),
      findUnique: vi.fn(async (args: { where?: { id?: string } }) => {
        const p = args?.where?.id ? porId.get(args.where.id) : undefined
        return p ?? null
      }),
      // A guarda de saída de rede (`guardaPorRepositorio`) pergunta o nível
      // pelo endereço do repositório.
      findFirst: vi.fn(async (args: { where?: { wingId?: string } }) => {
        const p = projetos.find((x) => x.wingId === args?.where?.wingId)
        return p ?? null
      }),
    },
    devSession: {
      findMany: vi.fn(
        async (args: {
          where?: { projectId?: string; closedAt?: unknown }
          select?: Record<string, boolean>
          distinct?: unknown
        }) => {
          // A pergunta que a sprint faz, e só ela: sessão aberta deste
          // projeto, com issue e PR.
          if (args?.select?.['pullRequestNumber'] && args?.where?.closedAt === null) {
            return sessoes[args.where?.projectId ?? ''] ?? []
          }
          return []
        }
      ),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
  }
}

/** Uma issue como a API REST devolve. `pull_request` presente = é um PR. */
function issue(numero: number, ehPr = false) {
  return ehPr ? { number: numero, pull_request: { url: 'x' } } : { number: numero }
}

/** Um quadro ligado ao repositório, como a API do GitHub o devolve. */
function quadroLigado(over: {
  id: string
  number: number
  title?: string
  closed?: boolean
  itens?: number
  campos?: number
}) {
  return {
    id: over.id,
    number: over.number,
    title: over.title ?? 'Quadro',
    closed: over.closed ?? false,
    items: { totalCount: over.itens ?? 0 },
    fields: { totalCount: over.campos ?? 13 },
  }
}

interface Cenario {
  /** Issues abertas por etiqueta, JÁ PAGINADAS (uma posição por página). */
  issuesPorEtiqueta?: Record<string, Array<Array<ReturnType<typeof issue>>>>
  /** O campo Sprint já existe no quadro? Quando não, a irmã o cria. */
  campoJaExiste?: boolean
  /** Itens do quadro: pedido -> iteração em que já está. */
  itens?: Array<{ pedido: number; itemId: string; iteracaoId: string | null }>
  /** Os quadros LIGADOS ao repositório. Padrão: um só, o do caso simples. */
  quadros?: ReturnType<typeof quadroLigado>[]
}

interface Espiao {
  fetchMock: ReturnType<typeof vi.fn>
  /** A sequência de operações GraphQL, na ordem em que saíram. */
  operacoes: string[]
  /** Em QUAL quadro cada leitura de itens foi feita — a prova da escolha. */
  quadrosLidos: string[]
  /** Cada escrita de sprint: item e iteração. */
  escritas: Array<{ itemId: string; iterationId: string }>
  /** Cada leitura REST de issues por etiqueta. */
  leiturasDeIssues: Array<{ etiqueta: string; pagina: string }>
}

function montarRede(cenario: Cenario): Espiao {
  const espiao: Espiao = {
    fetchMock: vi.fn(),
    operacoes: [],
    quadrosLidos: [],
    escritas: [],
    leiturasDeIssues: [],
  }
  let campoExiste = cenario.campoJaExiste ?? true
  const hoje = hojeNoFuso()

  const campoSprint = () => ({
    __typename: 'ProjectV2IterationField',
    id: CAMPO_ID,
    name: 'Sprint',
    configuration: {
      iterations: [{ id: ITERACAO_CORRENTE, title: 'Sprint 1', startDate: hoje, duration: 3 }],
    },
  })

  const json = (corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  espiao.fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const endereco = String(url)

    if (endereco === 'https://api.github.com/graphql') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as {
        query: string
        variables: Record<string, unknown>
      }
      const nome = /(?:query|mutation)\s+(\w+)/.exec(corpo.query)?.[1] ?? '?'
      espiao.operacoes.push(nome)

      if (nome === 'ListarQuadrosDoRepositorio') {
        return json({
          data: {
            repository: {
              projectsV2: {
                nodes: cenario.quadros ?? [quadroLigado({ id: QUADRO_ID, number: 2 })],
              },
            },
          },
        })
      }
      if (nome === 'GetIterationField') {
        return json({
          data: {
            node: {
              fields: {
                nodes: [
                  { __typename: 'ProjectV2Field', id: 'F_status', name: 'Status' },
                  ...(campoExiste ? [campoSprint()] : []),
                ],
              },
            },
          },
        })
      }
      if (nome === 'CriarCampoDeIteracao') {
        campoExiste = true
        return json({
          data: { createProjectV2Field: { projectV2Field: { id: CAMPO_ID, name: 'Sprint' } } },
        })
      }
      if (nome === 'ItensDoQuadro') {
        espiao.quadrosLidos.push(String(corpo.variables['id'] ?? corpo.variables['projectId']))
        const itens = cenario.itens ?? []
        return json({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: itens.map((i) => ({
                  id: i.itemId,
                  content: { number: i.pedido },
                  fieldValueByName: i.iteracaoId ? { iterationId: i.iteracaoId } : null,
                })),
              },
            },
          },
        })
      }
      if (nome === 'SetProjectV2Iteration') {
        espiao.escritas.push({
          itemId: String(corpo.variables['itemId']),
          iterationId: String(corpo.variables['iterationId']),
        })
        return json({
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: String(corpo.variables['itemId']) },
            },
          },
        })
      }
      return json({ data: {} })
    }

    if (endereco.includes('/issues?') && endereco.includes('labels=')) {
      const parametros = new URL(endereco).searchParams
      const etiqueta = parametros.get('labels') ?? ''
      const pagina = parametros.get('page') ?? '(sem page)'
      espiao.leiturasDeIssues.push({ etiqueta, pagina })
      const paginas = cenario.issuesPorEtiqueta?.[etiqueta] ?? []
      // Sem `page` na URL, quem responde só pode devolver a primeira página —
      // é exatamente o que o GitHub faz, e é onde o resto some.
      const indice = pagina === '(sem page)' ? 0 : Number(pagina) - 1
      return json(paginas[indice] ?? [])
    }

    return json({})
  })

  return espiao
}

async function subirRelogio(prisma: unknown, espiao: Espiao) {
  global.fetch = espiao.fetchMock as unknown as typeof fetch
  const app = Fastify({ logger: { level: 'silent' } })
  const info = vi.spyOn(app.log, 'info')
  const warn = vi.spyOn(app.log, 'warn')
  const debug = vi.spyOn(app.log, 'debug')
  app.decorate('prisma', prisma as never)
  await app.register(schedulerPlugin)
  return { app, info, warn, debug }
}

const textoDosLogs = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : '')).join(' '))

describe('varrerItensDaSprint: a caixa do relógio que põe o trabalho dentro do ciclo', () => {
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

  /** O cenário completo: sessão viva, etiquetas, quadro sem campo de sprint. */
  const cenarioCompleto = (): Cenario => ({
    campoJaExiste: false,
    issuesPorEtiqueta: {
      'gitorch:agent:sm': [[issue(20)]],
      // #10 repete a sessão viva (tem que ser contado UMA vez, pelo motivo mais
      // forte) e #22 é um PR disfarçado de issue pela rota REST.
      'gitorch:agent:jules': [[issue(21), issue(10), issue(22, true)]],
      'gitorch:agent:qa': [[]],
    },
    itens: [
      { pedido: 10, itemId: ITEM[10], iteracaoId: null },
      { pedido: 11, itemId: ITEM[11], iteracaoId: null },
      { pedido: 20, itemId: ITEM[20], iteracaoId: null },
      { pedido: 21, itemId: ITEM[21], iteracaoId: ITERACAO_ALHEIA },
      { pedido: 99, itemId: ITEM[99], iteracaoId: null },
    ],
  })

  const sessoesDoCenario: SessoesVivas = {
    proj_sprint: [{ issueNumber: 10, pullRequestNumber: 11 }],
  }

  test('roda no tique, e DEPOIS da irmã que cria o ciclo', async () => {
    const espiao = montarRede(cenarioCompleto())
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoesDoCenario), espiao)
    app = subida.app

    await vi.waitFor(() => expect(espiao.escritas.length).toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    })

    // A ORDEM é a prova: o ciclo precisa EXISTIR antes de ter o que pôr
    // dentro. Na primeira passada de um quadro novo, a irmã cria o campo e
    // esta o preenche na mesma volta do relógio.
    const criou = espiao.operacoes.indexOf('CriarCampoDeIteracao')
    const leuItens = espiao.operacoes.indexOf('ItensDoQuadro')
    expect(criou).toBeGreaterThanOrEqual(0)
    expect(leuItens).toBeGreaterThanOrEqual(0)
    expect(criou).toBeLessThan(leuItens)
  })

  test('monta as TRÊS fontes de trabalho ativo — e só elas entram na sprint', async () => {
    const espiao = montarRede(cenarioCompleto())
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoesDoCenario), espiao)
    app = subida.app

    await vi.waitFor(() => expect(espiao.escritas.length).toBeGreaterThanOrEqual(3), {
      timeout: 5000,
      interval: 10,
    })

    const itensEscritos = [...new Set(espiao.escritas.map((e) => e.itemId))].sort()
    // #10 = issue da sessão viva · #11 = PR da sessão viva · #20 = etiqueta.
    expect(itensEscritos).toEqual([ITEM[10], ITEM[11], ITEM[20]].sort())
    // #21 já está em OUTRO ciclo: decisão de alguém, não se arrasta.
    expect(itensEscritos).not.toContain(ITEM[21])
    // #99 é backlog: sprint que recebe o backlog inteiro não é sprint.
    expect(itensEscritos).not.toContain(ITEM[99])
    // Tudo foi para o ciclo que está correndo HOJE.
    expect(espiao.escritas.every((e) => e.iterationId === ITERACAO_CORRENTE)).toBe(true)
  })

  test('respeita a cadência: não volta a cada tique, mas volta quando ela vence', async () => {
    // Cadência curta para o teste ver o relógio de verdade: com tique de 15ms,
    // uma varredura por 400ms é observável, e "toda vez" seria ~26 no mesmo
    // intervalo. A janela discrimina as duas coisas.
    process.env['GITORCH_SPRINT_ITENS_CADENCIA_MS'] = '400'
    const espiao = montarRede(cenarioCompleto())
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoesDoCenario), espiao)
    app = subida.app

    const passadas = () => espiao.operacoes.filter((o) => o === 'ItensDoQuadro').length

    await vi.waitFor(() => expect(passadas()).toBe(1), { timeout: 5000, interval: 10 })
    // Vários tiques depois, CONTINUA uma só: a cadência segura.
    await new Promise((r) => setTimeout(r, 150))
    expect(passadas()).toBe(1)
    // E quando a cadência vence, ela volta sozinha.
    await vi.waitFor(() => expect(passadas()).toBeGreaterThan(1), { timeout: 5000, interval: 10 })
  })

  test('issue além da primeira página NÃO some: pagina de verdade', async () => {
    const cheia = Array.from({ length: 100 }, (_, i) => issue(200 + i))
    const cenario = cenarioCompleto()
    cenario.issuesPorEtiqueta = {
      // Página 1 cheia e uma segunda página com o pedido que importa.
      'gitorch:agent:sm': [cheia, [issue(20)]],
      'gitorch:agent:jules': [[]],
      'gitorch:agent:qa': [[]],
    }
    const espiao = montarRede(cenario)
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoesDoCenario), espiao)
    app = subida.app

    await vi.waitFor(() => expect(espiao.escritas.some((e) => e.itemId === ITEM[20])).toBe(true), {
      timeout: 5000,
      interval: 10,
    })

    // A prova de que houve paginação REAL, e não sorte: a segunda página foi
    // pedida explicitamente.
    expect(
      espiao.leiturasDeIssues.some((l) => l.etiqueta === 'gitorch:agent:sm' && l.pagina === '2')
    ).toBe(true)
  })

  test('quando o teto de páginas morde, AVISA — teto silencioso é o mesmo defeito', async () => {
    // Todas as páginas cheias: a lista nunca acaba, o teto é o que para.
    const cheia = (base: number) => Array.from({ length: 100 }, (_, i) => issue(base + i))
    const cenario = cenarioCompleto()
    cenario.issuesPorEtiqueta = {
      'gitorch:agent:sm': Array.from({ length: 60 }, (_, p) => cheia(1000 + p * 100)),
      'gitorch:agent:jules': [[]],
      'gitorch:agent:qa': [[]],
    }
    const espiao = montarRede(cenario)
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoesDoCenario), espiao)
    app = subida.app

    await vi.waitFor(
      () =>
        expect(
          textoDosLogs(subida.warn).some(
            (l) => l.includes('gitorch:agent:sm') && /não li .*inteir|parei em/i.test(l)
          )
        ).toBe(true),
      { timeout: 8000, interval: 20 }
    )

    // E o teto PAROU de verdade: não girou pelas 60 páginas que a rede oferece.
    const paginasLidas = espiao.leiturasDeIssues.filter(
      (l) => l.etiqueta === 'gitorch:agent:sm'
    ).length
    expect(paginasLidas).toBeGreaterThan(1)
    expect(paginasLidas).toBeLessThan(60)
  })

  test('projeto sem credencial é DITO, não pulado em silêncio', async () => {
    const semToken = projeto({
      id: 'proj_sem_token',
      wingId: 'acme/sem-credencial',
      encryptedClientToken: null,
    })
    const espiao = montarRede(cenarioCompleto())
    const subida = await subirRelogio(
      buildFakePrisma([semToken, projeto()], sessoesDoCenario),
      espiao
    )
    app = subida.app

    await vi.waitFor(
      () =>
        expect(
          textoDosLogs(subida.info).some(
            (l) =>
              l.includes('acme/sem-credencial') &&
              // A frase da CAIXA, não a da irmã: a varredura irmã também
              // registra "sem_credencial" no mesmo tique, e um teste que
              // aceitasse a frase dela passaria verde com esta caixa muda.
              l.includes('não preenchida') &&
              /credencial/i.test(l)
          )
        ).toBe(true),
      { timeout: 5000, interval: 10 }
    )

    // E o projeto SEGUINTE continua sendo atendido: um sem credencial não
    // pode calar a varredura inteira.
    await vi.waitFor(() => expect(espiao.escritas.length).toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    })
  })

  test('em "só olhar", a guarda recusa e isso não vira falha nem escrita', async () => {
    const espiao = montarRede(cenarioCompleto())
    const subida = await subirRelogio(
      buildFakePrisma([projeto({ autonomia: 'so_olhar' })], sessoesDoCenario),
      espiao
    )
    app = subida.app

    // O relógio continua girando (a leitura de quadros é permitida em qualquer
    // nível), e é isso que prova que a recusa não derrubou o tique.
    await vi.waitFor(
      () =>
        expect(
          espiao.operacoes.filter((o) => o === 'ListarQuadrosDoRepositorio').length
        ).toBeGreaterThan(2),
      { timeout: 5000, interval: 10 }
    )

    // Nenhuma escrita de sprint saiu para o GitHub.
    expect(espiao.escritas).toEqual([])
    // E a recusa foi registrada como o que é: obediência ao nível do cliente.
    expect(textoDosLogs(subida.debug).some((l) => l.includes(REPO) && /sprint/i.test(l))).toBe(true)
    // Não vira `warn` de defeito nosso.
    expect(
      textoDosLogs(subida.warn).some((l) => l.includes(REPO) && /não consegui pôr/i.test(l))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// O LAÇO DOS QUADROS, no caminho de PRODUÇÃO.
//
// Medido em 31/08/2026 no repositório do dono (loureng/patinhas-3d-crafts):
// quatro quadros ligados — #3 "Jardim das Patinhas" com 146 itens e 24 campos,
// #5 fechado, e #11 e #12 criados pelo PRODUTO com 42 segundos de diferença, os
// dois vazios. A decisão devolvia "escolher" e esta varredura fazia `continue`
// CALADA: o patinhas sumia do relato inteiro, e as 4 sessões vivas nunca
// entravam em ciclo nenhum. Metade da frota parada esperando uma escolha que
// ninguém nunca pediu ao dono.
// ---------------------------------------------------------------------------
describe('varrerItensDaSprint diante de vários quadros ligados', () => {
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

  const cenarioBase = (): Cenario => ({
    issuesPorEtiqueta: {
      'gitorch:agent:sm': [[issue(20)]],
      'gitorch:agent:jules': [[]],
      'gitorch:agent:qa': [[]],
    },
    itens: [{ pedido: 20, itemId: ITEM[20], iteracaoId: null }],
  })

  const sessoes: SessoesVivas = { proj_sprint: [] }

  test('o Jardim real: escolhe o quadro de 146 itens sozinho e põe o trabalho nele', async () => {
    const cenario = cenarioBase()
    cenario.quadros = [
      quadroLigado({ id: 'PVT_12', number: 12, title: 'loureng/patinhas-3d-crafts' }),
      quadroLigado({ id: 'PVT_11', number: 11, title: 'loureng/patinhas-3d-crafts' }),
      quadroLigado({ id: 'PVT_5', number: 5, closed: true }),
      quadroLigado({
        id: 'PVT_3',
        number: 3,
        title: 'Jardim das Patinhas',
        itens: 146,
        campos: 24,
      }),
    ]
    const espiao = montarRede(cenario)
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoes), espiao)
    app = subida.app

    await vi.waitFor(() => expect(espiao.escritas.length).toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    })

    // A prova NÃO é "chamou a decisão": é em QUAL quadro o produto escreveu.
    expect(espiao.quadrosLidos).toContain('PVT_3')
    expect(espiao.quadrosLidos).not.toContain('PVT_11')
    expect(espiao.quadrosLidos).not.toContain('PVT_12')
    expect(espiao.quadrosLidos).not.toContain('PVT_5')
    expect(espiao.escritas.map((e) => e.itemId)).toContain(ITEM[20])
  })

  test('empate de verdade: o projeto pulado é DITO, com o motivo — nunca some do relato', async () => {
    const cenario = cenarioBase()
    // Dois quadros indistinguíveis: mesmos itens, mesmos campos. Aqui a
    // pergunta ao dono é legítima — o que não pode é ele nunca saber dela.
    cenario.quadros = [
      quadroLigado({ id: 'PVT_A', number: 7, itens: 9, campos: 13 }),
      quadroLigado({ id: 'PVT_B', number: 8, itens: 9, campos: 13 }),
    ]
    const espiao = montarRede(cenario)
    const subida = await subirRelogio(buildFakePrisma([projeto()], sessoes), espiao)
    app = subida.app

    await vi.waitFor(
      () =>
        expect(
          textoDosLogs(subida.info).some(
            (l) => l.includes(REPO) && l.includes('não preenchida') && /quadro/i.test(l)
          )
        ).toBe(true),
      { timeout: 5000, interval: 20 }
    )

    // E a varredura IRMÃ (a que cria o ciclo) também precisa dizer que parou
    // aqui — `sem_quadro` não estava em nenhum ramo do log dela.
    expect(
      textoDosLogs(subida.info).some(
        (l) => l.includes(REPO) && l.includes('depende de você') && /quadro/i.test(l)
      )
    ).toBe(true)

    // Nada foi escrito num quadro escolhido no chute.
    expect(espiao.escritas).toEqual([])
  })
})
