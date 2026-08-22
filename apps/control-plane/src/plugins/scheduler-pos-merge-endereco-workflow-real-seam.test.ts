import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Item 1/Leva B2 (Menor 9 da revisão final da branch): "o ensaio do endereço
// no ar é inerte para metade de todos os repositórios".
//
// `acompanharPorWorkflow` (publicacao.ts) NUNCA devolve endereço — nenhuma
// leitura que ele usa (execuções do workflow, etapas da execução) traz uma
// URL. No caminho de DEPLOYMENT o GitHub entrega o endereço de graça
// (`environment_url`); no caminho de WORKFLOW esse presente não existe, e
// antes desta correção `testarAmbiente` recebia sempre `enderecos: []` —
// respondendo `sem-endereco` para TODO repositório que publica por workflow,
// inclusive um projeto real do cliente. A Tarefa 14 inteira (o juiz abre o
// site e confere) não fazia nada nesse caminho.
//
// Este arquivo prova, pelo "real seam" de sempre (schedulerPlugin de
// VERDADE, `setInterval` real disparando o tick — nada de `varrerPublicacoes`
// reimplementado), os três desfechos que a correção precisa garantir:
// 1. endereço declarado em `runtimeConfig.ambientes.endereco`: o ensaio
//    TESTA de verdade, pela guarda de rede (a mesma chamada de `fetch` global
//    que intercepta tudo neste teste também intercepta `buscarComGuarda`), e
//    o veredito ("passou") chega ao dono.
// 2. endereço declarado mas de rede interna: a guarda RECUSA antes de
//    qualquer chamada — "inalcançável" (gap registrado), nunca "testado".
// 3. sem endereço nenhum configurado: comportamento honesto de sempre —
//    "sem-endereco", visível ao dono na mesma nota que já acompanha o
//    veredito da publicação.
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

function sessaoBase(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  }
}

function buildFakePrisma(projeto: Record<string, unknown>, sessaoInicial: Record<string, unknown>) {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let sessaoAtual: Record<string, unknown> = { ...sessaoInicial }
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => projeto),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) {
          return sessaoAtual['closedAt'] === null ? [sessaoAtual] : []
        }
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        sessaoAtual = { ...sessaoAtual, ...args.data }
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

/**
 * Mecanismo de workflow que resolve em `no-ar` — sem nenhum endereço vindo
 * do GitHub (nenhuma das rotas do workflow devolve URL nenhuma). Captura
 * URL+init de TODA chamada, para as asserções lerem o corpo real enviado ao
 * Telegram e provarem, sem ambiguidade, o veredito exato que chegou ao dono.
 */
function fetchMockWorkflowNoAr(opts: { enderecoConfigurado?: string; statusDoEndereco?: number }) {
  const chamadas: Array<{ url: string; init?: RequestInit | undefined }> = []
  const impl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url)
    chamadas.push({ url: u, init })
    if (u.endsWith('/repos/acme/api/environments')) {
      return new Response(JSON.stringify({ environments: [] }), { status: 200 })
    }
    if (u.endsWith('/repos/acme/api/actions/workflows')) {
      return new Response(
        JSON.stringify({
          workflows: [{ name: 'CD', path: '.github/workflows/cd.yml', state: 'active' }],
        }),
        { status: 200 }
      )
    }
    if (u.includes('/repos/acme/api/actions/workflows/cd.yml/runs')) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              name: 'CD',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'deadbeef',
              run_started_at: '2026-08-16T10:00:00Z',
            },
          ],
        }),
        { status: 200 }
      )
    }
    if (u.endsWith('/repos/acme/api/actions/runs/99/jobs')) {
      return new Response(
        JSON.stringify({ jobs: [{ name: 'Deploy', status: 'completed', conclusion: 'success' }] }),
        { status: 200 }
      )
    }
    if (u.startsWith('https://api.telegram.org/')) {
      return new Response('{"ok":true}', { status: 200 })
    }
    // O próprio endereço configurado pelo projeto — a guarda de rede chega
    // até aqui só quando o endereço é público de verdade.
    if (opts.enderecoConfigurado && u === opts.enderecoConfigurado) {
      return new Response('<html>ok</html>', { status: opts.statusDoEndereco ?? 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { impl: impl as unknown as typeof fetch, chamadas }
}

function corpoDoAvisoAoDono(
  chamadas: Array<{ url: string; init?: RequestInit | undefined }>
): string {
  const chamada = chamadas.find((c) => c.url.startsWith('https://api.telegram.org/'))
  const corpo = JSON.parse(String(chamada?.init?.body)) as { text: string }
  return corpo.text
}

describe('Item 1/Leva B2 — ensaio do endereço no caminho de publicação por WORKFLOW (real seam)', () => {
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
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
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

  test('endereço declarado em runtimeConfig.ambientes.endereco: o ensaio TESTA de verdade pela guarda de rede, e o veredito ("passou") chega ao dono', async () => {
    const { impl, chamadas } = fetchMockWorkflowNoAr({
      enderecoConfigurado: 'https://loja-do-cliente.exemplo.com/',
      statusDoEndereco: 200,
    })
    global.fetch = impl

    const projeto = {
      id: 'proj_1',
      wingId: 'acme/api',
      name: 'Acme API',
      userId: 'user_1',
      runtimeConfig: { ambientes: { endereco: 'https://loja-do-cliente.exemplo.com' } },
      isActive: true,
    }
    const prisma = buildFakePrisma(projeto, sessaoBase())
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // A prova central: a chamada de rede real ACONTECEU contra o endereço
    // configurado pelo projeto — sem a correção, `veredito.enderecos` do
    // caminho de workflow é sempre `[]` e esta chamada NUNCA acontece.
    expect(chamadas.some((c) => c.url === 'https://loja-do-cliente.exemplo.com/')).toBe(true)

    // E o veredito do ensaio ("passou") viaja até o dono na MESMA nota do
    // veredito de publicação — não fica preso num log interno.
    expect(corpoDoAvisoAoDono(chamadas)).toMatch(/Ensaio do ambiente: passou/)
  })

  test('endereço declarado mas de rede interna: a guarda RECUSA — "inalcançável" registrado, NUNCA "testado" em silêncio', async () => {
    const { impl, chamadas } = fetchMockWorkflowNoAr({
      enderecoConfigurado: 'http://127.0.0.1:3011/',
    })
    global.fetch = impl

    const projeto = {
      id: 'proj_1',
      wingId: 'acme/api',
      name: 'Acme API',
      userId: 'user_1',
      // Endereço interno — o cenário real que motivou o terceiro veredito
      // (docs/esteira/README.md): o ensaio de um cliente rodando em
      // 127.0.0.1, que o produto JAMAIS alcança a partir daqui.
      runtimeConfig: { ambientes: { endereco: 'http://127.0.0.1:3011' } },
      isActive: true,
    }
    const prisma = buildFakePrisma(projeto, sessaoBase({ sessionName: 'sessions/interno' }))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const chamouTelegram = chamadas.some((c) => c.url.startsWith('https://api.telegram.org/'))
        expect(chamouTelegram).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Nunca uma chamada de rede real para o endereço interno — a guarda
    // recusa ANTES de qualquer tentativa (o endereço nem aparece na lista de
    // chamadas feitas, porque `enderecoPermitido` barra antes do `fetch`).
    expect(chamadas.some((c) => c.url.includes('127.0.0.1'))).toBe(false)

    const texto = corpoDoAvisoAoDono(chamadas)
    expect(texto).toMatch(/Ensaio do ambiente: inalcancavel/)
    expect(texto).toMatch(/127\.0\.0\.1/)
  })

  test('sem endereço nenhum configurado: comportamento honesto de sempre — "sem-endereco", visível ao dono, nunca inventado', async () => {
    const { impl, chamadas } = fetchMockWorkflowNoAr({})
    global.fetch = impl

    const projeto = {
      id: 'proj_1',
      wingId: 'acme/api',
      name: 'Acme API',
      userId: 'user_1',
      // SEM `ambientes.endereco` — o caso honesto: nada para testar.
      runtimeConfig: null,
      isActive: true,
    }
    const prisma = buildFakePrisma(projeto, sessaoBase({ sessionName: 'sessions/sem-config' }))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechou = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechou).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    // Nunca chama o endereço do outro teste — não existe endereço nenhum
    // para chamar, nem pela guarda nem por qualquer outra via.
    expect(chamadas.some((c) => c.url === 'https://loja-do-cliente.exemplo.com/')).toBe(false)

    expect(corpoDoAvisoAoDono(chamadas)).toMatch(/Ensaio do ambiente: sem-endereco/)
  })
})
