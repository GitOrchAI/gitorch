import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { schedulerPlugin } from './scheduler.js'
import { encryptCredential } from '../lib/credential-crypto.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'
import {
  criarGitHubFalso,
  WORKFLOW_FIXADO,
  WORKFLOW_POR_TAG,
  type RepositorioFalso,
} from '../test/github-de-seguranca-fake.js'

// A nota de segurança (5.1) e a conformidade (5.6) pelo caminho REAL do
// serviço: o plugin do scheduler montando a etapa do tique. As peças existiam,
// passavam nos próprios testes e ninguém as chamava; estes testes falham se a
// etapa sair do tique, se ela deixar de chamar uma das duas peças ou se uma
// peça que falha derrubar o tique. O GitHub é o `global.fetch`.

const REPO = 'acme/api'
const TOKEN_DO_CLIENTE = 'ghp_token_do_cliente'
const ETAPA = 'varrerSegurancaDosProjetos'

const REPOSITORIO: RepositorioFalso = {
  protecao: 'plano-gratis',
  permissaoDoToken: 'write',
  arquivos: {
    '.github/CODEOWNERS': '* @acme',
    '.github/dependabot.yml': 'version: 2',
    '.github/workflows/ci.yml': WORKFLOW_FIXADO,
    '.github/workflows/cd.yml': WORKFLOW_POR_TAG,
  },
  sbom: [
    { name: 'left-pad', licenca: 'MIT' },
    { name: 'copyleft', licenca: 'AGPL-3.0-only' },
  ],
}

const PROJETO = {
  id: 'proj_1',
  wingId: REPO,
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  devPlan: null,
  autonomia: 'cuidar',
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
  encryptedClientToken: encryptCredential(TOKEN_DO_CLIENTE),
  autonomiaDeSeguranca: 'so_olhar',
}

function novoPortao() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface FichaGravada {
  tipo: string
  estado: Record<string, unknown>
  atualizadoEm: Date
}

function buildFakePrisma(
  opcoes: {
    falharAoGravar?: 'seguranca' | 'conformidade'
    falharAoLerFichas?: boolean
    /** O que a leitura das fichas lança, quando `falharAoLerFichas` está ligado. */
    erroAoLerFichas?: () => unknown
  } = {}
) {
  const fichas = new Map<string, FichaGravada>()
  const eventos: Array<{ chave: string; texto: string }> = []
  let iniciosDaEtapa = 0
  return {
    _fichas: fichas,
    _eventos: eventos,
    /** Quantas vezes a etapa de segurança começou de verdade (a primeira leitura dela é a lista de projetos). */
    _iniciosDaEtapa: () => iniciosDaEtapa,
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { tokensUsed: 0 } })),
    },
    project: {
      findFirst: vi.fn(async () => PROJETO),
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async (args?: { select?: Record<string, unknown> }) => {
        // Só a etapa de segurança pede, juntas, a configuração de execução e a autonomia de segurança.
        if (
          args?.select &&
          'runtimeConfig' in args.select &&
          'autonomiaDeSeguranca' in args.select
        ) {
          iniciosDaEtapa += 1
        }
        return args?.select && 'encryptedClientToken' in args.select ? [PROJETO] : []
      }),
      update: vi.fn(async () => ({})),
    },
    engineConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    devSession: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => undefined),
    },
    repoItem: {
      findMany: vi.fn(async (args: { where?: { tipo?: unknown } }) => {
        const tipos = (args.where?.tipo as { in?: string[] } | undefined)?.in
        if (!tipos) return []
        if (opcoes.falharAoLerFichas) {
          throw opcoes.erroAoLerFichas
            ? opcoes.erroAoLerFichas()
            : new Error('banco fora do ar para as fichas')
        }
        return [...fichas.entries()]
          .filter(([chave]) => tipos.includes(chave.split(':')[1] ?? ''))
          .map(([chave, f]) => ({
            projectId: chave.split(':')[0],
            tipo: f.tipo,
            estado: f.estado,
            atualizadoEm: f.atualizadoEm,
          }))
      }),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(
        async (args: {
          where: { projectId_tipo_numero: { projectId: string; tipo: string } }
          create: { estado: Record<string, unknown> }
        }) => {
          const { projectId, tipo } = args.where.projectId_tipo_numero
          if (tipo === opcoes.falharAoGravar) throw new Error(`banco recusou a ficha ${tipo}`)
          fichas.set(`${projectId}:${tipo}`, {
            tipo,
            estado: args.create.estado,
            atualizadoEm: new Date(),
          })
          return {}
        }
      ),
    },
    event: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { payload: { chave?: string; texto?: string } } }) => {
        if (data.payload.chave) {
          eventos.push({ chave: data.payload.chave, texto: data.payload.texto ?? '' })
        }
        return {}
      }),
    },
    agentQuestion: { findFirst: vi.fn(async () => null) },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => null) },
  }
}

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
  'GITORCH_SEGURANCA_CADENCIA_MS',
  'GITORCH_CONFORMIDADE_CADENCIA_MS',
]

describe('nota de segurança e conformidade no tique (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    limparFreiosDeCota()
    for (const chave of ENV_KEYS) {
      original[chave] = process.env[chave]
      delete process.env[chave]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '3600000'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-do-app'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const chave of ENV_KEYS) {
      if (original[chave] === undefined) delete process.env[chave]
      else process.env[chave] = original[chave]
    }
    global.fetch = originalFetch
    limparFreiosDeCota()
    vi.restoreAllMocks()
  })

  function redeComGitHub(
    repositorio: RepositorioFalso,
    sbomQuebrado = false,
    /** Segura a primeira leitura do repositório até a promessa resolver. */
    portao?: Promise<void>
  ) {
    const github = criarGitHubFalso({ [REPO]: repositorio })
    /** A credencial de cada leitura da árvore, na ordem em que chegaram. */
    const autorizacoes: string[] = []
    let leiturasDoRepositorio = 0
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const endereco = String(url)
      if (sbomQuebrado && endereco.includes('/dependency-graph/sbom')) {
        throw new Error('rede caiu no SBOM')
      }
      // As outras etapas do tique (retrato, quadro...) leem listas e recebem vazio.
      if (/\/repos\/acme\/api\/(pulls|issues)\?/.test(endereco)) {
        return new Response('[]', { status: 200 })
      }
      if (endereco.startsWith('https://api.telegram.org/') || endereco.endsWith('/graphql')) {
        return new Response('{"data":{}}', { status: 200 })
      }
      if (
        new URL(endereco).host === 'api.github.com' ||
        endereco.includes('raw.githubusercontent')
      ) {
        if (portao && endereco === `https://api.github.com/repos/${REPO}`) {
          leiturasDoRepositorio += 1
          await portao
        }
        if (endereco.includes('/git/trees/')) {
          autorizacoes.push(new Headers(init?.headers).get('authorization') ?? '')
        }
        return github.fetchFalso(url, init)
      }
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    return { github, fetchMock, autorizacoes, leiturasDoRepositorio: () => leiturasDoRepositorio }
  }

  async function subir(prisma: ReturnType<typeof buildFakePrisma>) {
    app = Fastify({ logger: { level: 'silent' } })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    const infoSpy = vi.spyOn(app.log, 'info')
    const warnSpy = vi.spyOn(app.log, 'warn')
    await app.register(schedulerPlugin)
    return { infoSpy, warnSpy }
  }

  type Espiao = { mock: { calls: unknown[][] } }
  const etapasMedidas = (infoSpy: Espiao, etapa: string = ETAPA) =>
    infoSpy.mock.calls.filter((c) => (c[0] as { etapa?: string } | undefined)?.etapa === etapa)
      .length

  test('a etapa roda no tique e chama as DUAS peças: grava a nota e a conformidade, com a credencial do cliente', async () => {
    const { autorizacoes } = redeComGitHub(REPOSITORIO)
    const prisma = buildFakePrisma()
    const { infoSpy } = await subir(prisma)

    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })

    const seguranca = prisma._fichas.get('proj_1:seguranca')?.estado
    const conformidade = prisma._fichas.get('proj_1:conformidade')?.estado
    // proteção fora do denominador (plano grátis); CODEOWNERS e Dependabot OK;
    // Actions soltas e permissão write: 2 de 5
    expect(seguranca).toMatchObject({ status: 'medido', nota: 40, maximo: 5 })
    expect(conformidade).toMatchObject({
      status: 'medido',
      licencas: { estado: 'verificado', emAtencaoTotal: 1 },
    })
    expect(prisma._eventos.map((e) => e.chave)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^nota-de-seguranca:acme\/api:40:/),
        expect.stringMatching(/^conformidade:acme\/api:/),
      ])
    )
    // a etapa é medida como as outras e é leve: não pesa no tique
    expect(etapasMedidas(infoSpy)).toBeGreaterThan(0)
    const duracoes = infoSpy.mock.calls
      .map((c) => c[0] as { etapa?: string; duracaoMs?: number } | undefined)
      .filter((l) => l?.etapa === ETAPA)
      .map((l) => l?.duracaoMs ?? 0)
    expect(Math.max(...duracoes)).toBeLessThan(2000)
    // a credencial do cliente leu tudo; a do App nem foi preciso (nada mais faltava medir)
    expect(autorizacoes[0]).toBe(`Bearer ${TOKEN_DO_CLIENTE}`)
  })

  test('os tiques seguintes não chamam o GitHub de novo: o gate é a ficha (24 h / 7 dias)', async () => {
    const { github } = redeComGitHub(REPOSITORIO)
    const prisma = buildFakePrisma()
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })

    const depois = github.chamadas.length
    const etapasAntes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(etapasAntes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.chamadas.length).toBe(depois)
  })

  test('a cadência vem da env GITORCH_SEGURANCA_CADENCIA_MS', async () => {
    process.env['GITORCH_SEGURANCA_CADENCIA_MS'] = '30'
    const { github } = redeComGitHub(REPOSITORIO)
    const prisma = buildFakePrisma()
    await subir(prisma)
    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })
    const primeiras = github.chamadas.length
    await vi.waitFor(() => expect(github.chamadas.length).toBeGreaterThan(primeiras), {
      timeout: 8000,
      interval: 10,
    })
  })

  test('se a leitura de licenças falha, a nota sai e a conformidade vira "não verificado": uma peça não derruba a outra', async () => {
    redeComGitHub(REPOSITORIO, true)
    const prisma = buildFakePrisma()
    const { warnSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })

    expect(prisma._fichas.get('proj_1:seguranca')?.estado).toMatchObject({ nota: 40 })
    expect(prisma._fichas.get('proj_1:conformidade')?.estado).toMatchObject({
      licencas: { estado: 'nao-verificado' },
    })
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes(ETAPA))).toEqual([])
  })

  test.each(['seguranca', 'conformidade'] as const)(
    'se a gravação da peça "%s" falha, só avisa e o tique continua',
    async (peca) => {
      redeComGitHub(REPOSITORIO)
      const prisma = buildFakePrisma({ falharAoGravar: peca })
      const { warnSpy, infoSpy } = await subir(prisma)

      await vi.waitFor(
        () =>
          expect(
            warnSpy.mock.calls.some(
              (c) => String(c[0]).includes(ETAPA) && String(c[0]).includes('falhou')
            )
          ).toBe(true),
        { timeout: 8000, interval: 10 }
      )
      // o tique não morreu: etapas seguintes continuam sendo medidas depois do aviso
      const antes = etapasMedidas(infoSpy, 'varrerPrsDuplicadosDosProjetos')
      await vi.waitFor(
        () =>
          expect(etapasMedidas(infoSpy, 'varrerPrsDuplicadosDosProjetos')).toBeGreaterThan(
            antes + 1
          ),
        { timeout: 8000, interval: 10 }
      )
    }
  )

  test('o tique não espera a etapa: com a leitura do GitHub pendurada, as etapas seguintes e os próximos tiques seguem', async () => {
    const portao = novoPortao()
    const { leiturasDoRepositorio } = redeComGitHub(REPOSITORIO, false, portao.promise)
    const prisma = buildFakePrisma()
    const { infoSpy, warnSpy } = await subir(prisma)

    await vi.waitFor(() => expect(leiturasDoRepositorio()).toBe(1), { timeout: 8000, interval: 10 })
    // a etapa está em voo e NÃO terminou; mesmo assim vários tiques completos passaram
    await vi.waitFor(
      () => expect(etapasMedidas(infoSpy, 'rodarRetrospectiva')).toBeGreaterThanOrEqual(4),
      { timeout: 8000, interval: 10 }
    )
    expect(etapasMedidas(infoSpy)).toBe(0)
    expect(prisma._fichas.size).toBe(0)
    expect(
      warnSpy.mock.calls.filter((c) => String(c[0]).includes('tick anterior ainda em andamento'))
    ).toEqual([])

    portao.resolve()
    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })
  })

  test('com a etapa em voo os tiques seguintes não disparam uma segunda execução; depois de resolvida, voltam a disparar', async () => {
    const portao = novoPortao()
    const { leiturasDoRepositorio } = redeComGitHub(REPOSITORIO, false, portao.promise)
    const prisma = buildFakePrisma()
    const { infoSpy } = await subir(prisma)

    await vi.waitFor(() => expect(leiturasDoRepositorio()).toBe(1), { timeout: 8000, interval: 10 })
    const tiquesAntes = etapasMedidas(infoSpy, 'rodarRetrospectiva')
    await vi.waitFor(
      () =>
        expect(etapasMedidas(infoSpy, 'rodarRetrospectiva')).toBeGreaterThanOrEqual(
          tiquesAntes + 4
        ),
      { timeout: 8000, interval: 10 }
    )
    // vários tiques depois, a etapa começou uma única vez e leu o GitHub uma única vez:
    // a guarda barrou os disparos (conta execuções reais, não linhas de registro)
    expect(prisma._iniciosDaEtapa()).toBe(1)
    expect(leiturasDoRepositorio()).toBe(1)
    expect(etapasMedidas(infoSpy)).toBe(0)

    portao.resolve()
    // resolvida, a guarda se solta e os tiques seguintes iniciam a etapa de novo
    // (agora o gate da ficha a dispensa de ler o GitHub): cada conclusão é uma
    // execução real a mais, e o total só cresce, então ">= 2" não depende da velocidade
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(2), {
      timeout: 8000,
      interval: 10,
    })
    expect(prisma._iniciosDaEtapa()).toBeGreaterThanOrEqual(2)
    expect(leiturasDoRepositorio()).toBe(1)
  })

  test('rejeição da etapa vira aviso, não derruba o processo e o tique segue', async () => {
    const rejeicoes: unknown[] = []
    const aoRejeitar = (motivo: unknown) => rejeicoes.push(motivo)
    process.on('unhandledRejection', aoRejeitar)
    try {
      redeComGitHub(REPOSITORIO)
      const prisma = buildFakePrisma({ falharAoLerFichas: true })
      const { warnSpy, infoSpy } = await subir(prisma)

      await vi.waitFor(
        () =>
          expect(
            warnSpy.mock.calls.some((c) => String(c[1]).includes('varredura de segurança falhou'))
          ).toBe(true),
        { timeout: 8000, interval: 10 }
      )
      const antes = etapasMedidas(infoSpy, 'rodarRetrospectiva')
      await vi.waitFor(
        () => expect(etapasMedidas(infoSpy, 'rodarRetrospectiva')).toBeGreaterThan(antes + 1),
        { timeout: 8000, interval: 10 }
      )
      // a duração da etapa é medida mesmo quando ela falha
      expect(etapasMedidas(infoSpy)).toBeGreaterThan(0)
      expect(rejeicoes).toEqual([])
    } finally {
      process.off('unhandledRejection', aoRejeitar)
    }
  })

  test('rejeição da etapa que cita uma credencial: o aviso no log sai sem ela (nem no erro anexado)', async () => {
    const TOKEN_NO_ERRO = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    redeComGitHub(REPOSITORIO)
    const prisma = buildFakePrisma({
      falharAoLerFichas: true,
      erroAoLerFichas: () =>
        new Error(
          `banco recusou: postgres://usuario:senha-secreta@db/x com Bearer ${TOKEN_NO_ERRO}`
        ),
    })
    const { warnSpy } = await subir(prisma)

    await vi.waitFor(
      () =>
        expect(
          warnSpy.mock.calls.some((c) => String(c[1]).includes('varredura de segurança falhou'))
        ).toBe(true),
      { timeout: 8000, interval: 10 }
    )

    const avisos = warnSpy.mock.calls.filter((c) =>
      String(c[1]).includes('varredura de segurança falhou')
    )
    const saiu = JSON.stringify(avisos, (_chave, valor: unknown) =>
      valor instanceof Error
        ? { name: valor.name, message: valor.message, stack: valor.stack }
        : valor
    )
    // controle positivo: o motivo do aviso está lá
    expect(saiu).toContain('banco recusou')
    expect(saiu).not.toContain(TOKEN_NO_ERRO)
    expect(saiu).not.toContain('senha-secreta')
  })

  test('nenhum token (do cliente ou do App) aparece nas fichas, nos eventos do painel nem em qualquer log', async () => {
    // a proteção só responde à credencial do App: as DUAS credenciais são usadas
    const { fetchMock } = redeComGitHub(
      { ...REPOSITORIO, protecao: 'checks-sem-revisao', protecaoExigeToken: 'token-do-app' },
      true
    )
    const prisma = buildFakePrisma()
    const { infoSpy, warnSpy } = await subir(prisma)
    const errorSpy = vi.spyOn(app!.log, 'error')
    const debugSpy = vi.spyOn(app!.log, 'debug')
    await vi.waitFor(() => expect(prisma._fichas.size).toBe(2), { timeout: 8000, interval: 10 })
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(3), {
      timeout: 8000,
      interval: 10,
    })

    const tudo = JSON.stringify([
      [...prisma._fichas.values()],
      prisma._eventos,
      infoSpy.mock.calls,
      warnSpy.mock.calls,
      errorSpy.mock.calls,
      debugSpy.mock.calls,
    ])
    expect(tudo).toContain('nota-de-seguranca:acme/api')
    // controle positivo: as duas credenciais saíram de verdade nas chamadas
    const enviados = fetchMock.mock.calls.map((c) =>
      new Headers((c[1] as RequestInit | undefined)?.headers).get('authorization')
    )
    expect(enviados).toContain(`Bearer ${TOKEN_DO_CLIENTE}`)
    expect(enviados).toContain('Bearer token-do-app')
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain('token-do-app')
  })

  test('freio de cota ativo: a etapa pula com uma linha de log e não chama o GitHub', async () => {
    const { github } = redeComGitHub({ ...REPOSITORIO, limiteDeTaxa: true })
    const prisma = buildFakePrisma()
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(
      () =>
        expect(
          infoSpy.mock.calls.filter((c) => String(c[0]).includes(`${ETAPA}: GitHub em freio`))
            .length
        ).toBeGreaterThanOrEqual(2),
      { timeout: 8000, interval: 10 }
    )
    const dessaEtapa = github.chamadas.filter(
      (c) => c.includes('/dependency-graph/') || c.includes('/git/trees/')
    )
    expect(dessaEtapa).toEqual([])
    expect(prisma._fichas.size).toBe(0)
  })
})
