import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { schedulerPlugin } from './scheduler.js'
import { encryptCredential } from '../lib/credential-crypto.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'
import {
  criarGitHubFalso,
  WORKFLOW_FIXADO,
  type RepositorioFalso,
} from '../test/github-de-seguranca-fake.js'
import {
  GitHubDeMelhoriasFalso,
  type ConfiguracaoDoRepositorioFalso,
} from '../test/github-de-melhorias-fake.js'
import { criarPrismaDeSegurancaEmMemoria } from '../test/prisma-de-seguranca-em-memoria.js'

// A aplicação das melhorias de segurança pelo caminho REAL do serviço: o plugin
// do scheduler montando a etapa do tique. A peça existia, passava nos próprios
// testes e ninguém a chamava; estes testes falham se a aplicação sair da etapa
// de segurança, se ela escrever sem as travas, ou se uma falha dela atrapalhar a
// medição da nota. O GitHub é o `global.fetch`, com estado e registro de toda
// requisição: nenhuma escrita sai para o GitHub de verdade.

// O token de instalação do App: só o teste que prova o PR com o App o liga.
const instalacao = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('../services/github-app-token.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/github-app-token.js')>()),
  mintInstallationToken: vi.fn(async () => instalacao.token),
}))

const REPO = 'acme/api'
const TOKEN_DO_CLIENTE = 'ghp_token_do_cliente_da_aplicacao'
const TOKEN_DO_APP = 'token-do-app-da-aplicacao'
const TOKEN_DA_INSTALACAO = 'ghs_instalacao_do_app_da_aplicacao'
const ETAPA = 'varrerSegurancaDosProjetos'

const ARQUIVOS = {
  '.github/CODEOWNERS': '* @acme',
  '.github/dependabot.yml': 'version: 2',
  '.github/workflows/ci.yml': WORKFLOW_FIXADO,
}

const REPOSITORIO_DA_NOTA: RepositorioFalso = {
  protecao: 'plano-gratis',
  permissaoDoToken: 'write',
  arquivos: ARQUIVOS,
  sbom: null,
}

function projeto(niveis: { autonomia?: string; seguranca?: string } = {}) {
  return {
    id: 'proj_1',
    wingId: REPO,
    name: 'Acme API',
    userId: 'user_1',
    runtimeConfig: null,
    devPlan: null,
    autonomia: niveis.autonomia ?? 'cuidar',
    accessSuspendedAt: null,
    accessSuspendedReason: null,
    isActive: true,
    user: null,
    encryptedClientToken: encryptCredential(TOKEN_DO_CLIENTE),
    autonomiaDeSeguranca: niveis.seguranca ?? 'cuidar',
  }
}

function buildFakePrisma(linha: ReturnType<typeof projeto>) {
  const memoria = criarPrismaDeSegurancaEmMemoria()
  return {
    memoria,
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { tokensUsed: 0 } })),
    },
    project: {
      findFirst: vi.fn(async () => linha),
      findUnique: vi.fn(async () => linha),
      findMany: vi.fn(async (args?: { select?: Record<string, unknown> }) =>
        args?.select && 'encryptedClientToken' in args.select ? [linha] : []
      ),
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
      ...memoria.prisma.repoItem,
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    event: {
      ...memoria.prisma.event,
      findMany: vi.fn(async () => []),
    },
    agentQuestion: memoria.prisma.agentQuestion,
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
  'GITORCH_APLICAR_SEGURANCA',
  'GITORCH_APLICAR_SEGURANCA_EM',
  'GITORCH_APLICAR_SEGURANCA_ALERTAS',
]

describe('aplicação das melhorias de segurança no tique (real seam)', () => {
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
    process.env['GITORCH_GITHUB_TOKEN'] = TOKEN_DO_APP
    instalacao.token = null
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

  /** O GitHub com estado (a aplicação) e o antigo (a nota: árvore, proteção, SBOM). */
  function redeComGitHub(config: ConfiguracaoDoRepositorioFalso = {}) {
    const github = new GitHubDeMelhoriasFalso(REPO, {
      privado: false,
      segredos: 'disabled',
      bloqueioDePush: 'disabled',
      alertasDeDependencias: false,
      atualizacoesDeSeguranca: false,
      varreduraDeCodigo: 'not-configured',
      linguagens: { TypeScript: 10 },
      permissaoDoWorkflow: 'write',
      podeAprovarPrs: false,
      arquivos: ARQUIVOS,
      ...config,
    })
    const daNota = criarGitHubFalso({ [REPO]: REPOSITORIO_DA_NOTA })
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const endereco = String(url)
      if (
        /\/repos\/acme\/api\/(pulls|issues)\?/.test(endereco) &&
        !endereco.includes('state=all')
      ) {
        return new Response('[]', { status: 200 })
      }
      if (endereco.startsWith('https://api.telegram.org/') || endereco.endsWith('/graphql')) {
        return new Response('{"data":{}}', { status: 200 })
      }
      const host = new URL(endereco).host
      if (
        host === 'raw.githubusercontent.com' ||
        /\/(git\/trees|branches|dependency-graph)\//.test(endereco)
      ) {
        return daNota.fetchFalso(url, init)
      }
      if (host === 'api.github.com') return github.fetchFalso(url, init)
      return new Response('{}', { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    return { github, fetchMock }
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

  const SO_DA_APLICACAO =
    /\/(vulnerability-alerts|automated-security-fixes|code-scanning|languages)/

  test('a etapa do tique aplica a primeira melhoria: UMA escrita, com a credencial do cliente, na ficha e no painel', async () => {
    const { github } = redeComGitHub()
    const prisma = buildFakePrisma(projeto())
    const { infoSpy } = await subir(prisma)

    await vi.waitFor(() => expect(github.escritas()).toHaveLength(1), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()[0]).toMatchObject({
      metodo: 'PUT',
      caminho: `/repos/${REPO}/vulnerability-alerts`,
      autorizacao: `Bearer ${TOKEN_DO_CLIENTE}`,
    })
    expect(github.config.alertasDeDependencias).toBe(true)
    await vi.waitFor(
      () =>
        expect(prisma.memoria.chavesDeEventos()).toContain(
          `melhoria-de-seguranca:${REPO}:alertas-de-dependencias:aplicado`
        ),
      { timeout: 8000, interval: 10 }
    )
    expect(prisma.memoria.estadoDe('proj_1', 'melhorias')).toMatchObject({
      melhorias: { 'alertas-de-dependencias': { estado: 'aplicado' } },
    })

    // a medição da nota continua acontecendo no mesmo lugar
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })

    // e a etapa é medida e não pesa: os tiques seguintes não escrevem de novo (30 min entre passadas)
    const antes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(antes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()).toHaveLength(1)
  })

  test.each([
    ['autonomia de segurança em so_olhar', { seguranca: 'so_olhar' }],
    ['autonomia de segurança em sugerir', { seguranca: 'sugerir' }],
    ['autonomia geral em so_olhar', { autonomia: 'so_olhar' }],
    ['autonomia geral em sugerir', { autonomia: 'sugerir' }],
  ])('%s: a aplicação não faz nenhuma requisição (nem de leitura)', async (_n, niveis) => {
    const { github } = redeComGitHub()
    const prisma = buildFakePrisma(projeto(niveis))
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })
    const antes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(antes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()).toEqual([])
    expect(github.registro.filter((r) => SO_DA_APLICACAO.test(r.caminho))).toEqual([])
    expect(prisma.memoria.fichas.has('proj_1|melhorias|0')).toBe(false)
    expect(prisma.memoria.estadoDe('proj_1', 'sondagem')).toBeUndefined()
  })

  test('interruptor geral desligado: nenhuma requisição da aplicação', async () => {
    process.env['GITORCH_APLICAR_SEGURANCA'] = 'off'
    const { github } = redeComGitHub()
    const prisma = buildFakePrisma(projeto())
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })
    const antes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(antes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()).toEqual([])
    expect(github.registro.filter((r) => SO_DA_APLICACAO.test(r.caminho))).toEqual([])
  })

  test('projeto fora da lista de projetos: nenhuma requisição da aplicação', async () => {
    process.env['GITORCH_APLICAR_SEGURANCA_EM'] = 'outro/repositorio'
    const { github } = redeComGitHub()
    const prisma = buildFakePrisma(projeto())
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })
    const antes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(antes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()).toEqual([])
  })

  test('o interruptor de uma peça pula só ela: a próxima da fila é aplicada', async () => {
    process.env['GITORCH_APLICAR_SEGURANCA_ALERTAS'] = 'off'
    const { github } = redeComGitHub()
    const prisma = buildFakePrisma(projeto())
    await subir(prisma)
    await vi.waitFor(() => expect(github.escritas()).toHaveLength(1), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()[0]).toMatchObject({ metodo: 'PATCH', caminho: `/repos/${REPO}` })
    expect(github.config.alertasDeDependencias).toBe(false)
  })

  test('uma falha na aplicação (GitHub devolve 500) não impede a nota nem o tique', async () => {
    const { github } = redeComGitHub({
      forcar: { 'PUT /vulnerability-alerts': { status: 500, mensagem: 'boom' } },
    })
    const prisma = buildFakePrisma(projeto())
    const { infoSpy, warnSpy } = await subir(prisma)
    await vi.waitFor(() => expect(github.escritas()).toHaveLength(1), {
      timeout: 8000,
      interval: 10,
    })
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })
    const antes = etapasMedidas(infoSpy, 'rodarRetrospectiva')
    await vi.waitFor(
      () => expect(etapasMedidas(infoSpy, 'rodarRetrospectiva')).toBeGreaterThan(antes + 1),
      { timeout: 8000, interval: 10 }
    )
    expect(prisma.memoria.estadoDe('proj_1', 'melhorias')).toMatchObject({
      melhorias: { 'alertas-de-dependencias': { estado: 'falhou' } },
    })
    expect(
      warnSpy.mock.calls.filter((c) => String(c[0]).includes('aplicar segurança falhou'))
    ).toEqual([])
  })

  test('nenhum token do cliente ou do App em ficha, painel ou log, mesmo quando a aplicação erra', async () => {
    instalacao.token = TOKEN_DA_INSTALACAO
    const { github } = redeComGitHub({
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 422,
          mensagem: `erro com Authorization: Bearer ${TOKEN_DO_CLIENTE} / ${TOKEN_DA_INSTALACAO}`,
        },
      },
    })
    const prisma = buildFakePrisma(projeto())
    const { infoSpy, warnSpy } = await subir(prisma)
    const errorSpy = vi.spyOn(app!.log, 'error')
    const debugSpy = vi.spyOn(app!.log, 'debug')
    await vi.waitFor(() => expect(github.escritas()).toHaveLength(1), {
      timeout: 8000,
      interval: 10,
    })
    await vi.waitFor(
      () =>
        expect(prisma.memoria.chavesDeEventos()).toContain(
          `melhoria-de-seguranca:${REPO}:alertas-de-dependencias:recusado`
        ),
      { timeout: 8000, interval: 10 }
    )
    const tudo = JSON.stringify([
      [...prisma.memoria.fichas.values()],
      prisma.memoria.eventos,
      infoSpy.mock.calls,
      warnSpy.mock.calls,
      errorSpy.mock.calls,
      debugSpy.mock.calls,
    ])
    expect(tudo).toContain('melhoria-de-seguranca')
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DA_INSTALACAO)
  })

  // O token global do produto (GITORCH_GITHUB_TOKEN) lê a nota de segurança, mas
  // NENHUMA escrita da aplicação o usa: nem configuração, nem pull request.
  test('o token global do produto, mesmo sendo o único administrador, NUNCA faz escrita nenhuma', async () => {
    const { github } = redeComGitHub({ tokenDeAdmin: TOKEN_DO_APP })
    const prisma = buildFakePrisma(projeto())
    const { infoSpy } = await subir(prisma)
    await vi.waitFor(() => expect(prisma.memoria.fichas.has('proj_1|seguranca|0')).toBe(true), {
      timeout: 8000,
      interval: 10,
    })
    const antes = etapasMedidas(infoSpy)
    await vi.waitFor(() => expect(etapasMedidas(infoSpy)).toBeGreaterThanOrEqual(antes + 3), {
      timeout: 8000,
      interval: 10,
    })
    expect(github.escritas()).toEqual([])
    expect(github.escritas().some((r) => r.autorizacao === `Bearer ${TOKEN_DO_APP}`)).toBe(false)
  })

  test('o pull request sai com o token de instalação do App; a configuração, com a credencial do cliente', async () => {
    instalacao.token = TOKEN_DA_INSTALACAO
    // repositório privado em plano grátis: a alternativa gratuita é um pull request
    const { github } = redeComGitHub({
      privado: true,
      advancedSecurity: 'disabled',
      alertasDeDependencias: true,
      atualizacoesDeSeguranca: true,
    })
    const prisma = buildFakePrisma(projeto())
    await subir(prisma)
    await vi.waitFor(() => expect(github.pulls.length).toBeGreaterThan(0), {
      timeout: 8000,
      interval: 10,
    })
    await vi.waitFor(() => expect(github.escritas().length).toBeGreaterThanOrEqual(3), {
      timeout: 8000,
      interval: 10,
    })
    const doPr = github.escritas().filter((e) => /\/(git\/refs|contents\/|pulls)/.test(e.caminho))
    expect(doPr.length).toBeGreaterThanOrEqual(3)
    expect(new Set(doPr.map((e) => e.autorizacao))).toEqual(
      new Set([`Bearer ${TOKEN_DA_INSTALACAO}`])
    )
    // nenhuma escrita de nenhum tipo saiu com o token global nem com o do cliente em pull request
    expect(github.escritas().some((r) => r.autorizacao === `Bearer ${TOKEN_DO_APP}`)).toBe(false)
    expect(github.pulls[0]?.autor.type).toBe('Bot')
  })

  test('sem o App instalado: nenhum pull request é aberto, mesmo com o token global e o do cliente presentes', async () => {
    instalacao.token = null
    const { github } = redeComGitHub({
      privado: true,
      advancedSecurity: 'disabled',
      alertasDeDependencias: true,
      atualizacoesDeSeguranca: true,
    })
    const prisma = buildFakePrisma(projeto())
    await subir(prisma)
    await vi.waitFor(
      () =>
        expect(prisma.memoria.chavesDeEventos()).toContain(
          `melhoria-de-seguranca:${REPO}:alternativa-de-varredura-de-senhas:recusado`
        ),
      { timeout: 8000, interval: 10 }
    )
    expect(github.pulls).toEqual([])
    expect(github.escritas()).toEqual([])
  })
})
