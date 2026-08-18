import { describe, it, expect, vi } from 'vitest'
import type { CortexDrawer } from '@gitorch/cortex'
import type { GraphQLTransport } from '@gitorch/github-sync'
import { rememberRepoContext, collectAndRememberRepoContext } from './repo-context-cortex.js'
import type { CollectedRepoContext } from './repo-context-collector.js'
import type { DividaDeSeguranca } from './security-debt-collector.js'

function fakeCortex() {
  const drawers: CortexDrawer[] = []
  const writeDrawer = vi.fn(async (d: CortexDrawer) => {
    drawers.push(d)
  })
  return { writeDrawer, drawers }
}

function routingTransport(routes: {
  owner?: () => unknown
  create?: () => unknown
  repo?: () => unknown
}): GraphQLTransport {
  return async <T>(req: { query: string }): Promise<T> => {
    if (req.query.includes('RepoOwner')) {
      return (routes.owner ? routes.owner() : { data: {} }) as T
    }
    if (req.query.includes('CreateProjectV2')) {
      return (routes.create ? routes.create() : { data: {} }) as T
    }
    if (req.query.includes('RepoContext') || req.query.includes('RepoWorkItems')) {
      return (routes.repo ? routes.repo() : { data: {} }) as T
    }
    return { data: {} } as T
  }
}

function restDeMentira(
  respostas: Record<string, { status: number; corpo?: unknown }>
): typeof fetch {
  return (async (url: string | URL) => {
    const caminho = String(url).replace('https://api.github.com', '')
    const resposta = respostas[caminho]
    if (!resposta) {
      return new Response(JSON.stringify({ message: `não mapeado no fake: ${caminho}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(resposta.corpo !== undefined ? JSON.stringify(resposta.corpo) : null, {
      status: resposta.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('rememberRepoContext (ponte GitHub → Cortex)', () => {
  it('grava uma gaveta para o board, uma por PR e uma por Issue, carimbadas pelo wingId', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: true },
      pullRequests: [
        {
          number: 10,
          title: 'Adiciona auth',
          state: 'OPEN',
          url: 'https://github.com/o/r/pull/10',
          updatedAt: '2026-07-01T10:00:00Z',
          author: 'alice',
        },
      ],
      issues: [
        {
          number: 2,
          title: 'Bug no login',
          state: 'CLOSED',
          url: 'https://github.com/o/r/issues/2',
          updatedAt: '2026-06-30T10:00:00Z',
          author: null,
        },
      ],
    }

    await rememberRepoContext(
      { writeDrawer },
      'loureng/patinhas',
      context,
      () => '2026-07-05T12:00:00Z'
    )

    expect(writeDrawer).toHaveBeenCalledTimes(3)
    expect(drawers.map((d) => d.id)).toEqual([
      'github:loureng/patinhas:board',
      'github:loureng/patinhas:pull-request:10',
      'github:loureng/patinhas:issue:2',
    ])
    expect(drawers.every((d) => d.wingId === 'loureng/patinhas')).toBe(true)
    expect(drawers.every((d) => d.roomId === 'contexto-github')).toBe(true)
    expect(drawers.every((d) => d.hallId === 'onboarding')).toBe(true)
  })

  it('grava a dívida de segurança como gaveta própria, com resumo por severidade e a lista dos alertas', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const divida: DividaDeSeguranca = {
      temConfiguracao: true,
      alertas: [
        {
          numero: 42,
          severidade: 'critical',
          pacote: 'pacote-x',
          ecossistema: 'npm',
          manifesto: 'pnpm-lock.yaml',
          resumo: 'resumo do problema',
          versaoCorrigida: '2.0.0',
          url: 'https://exemplo.invalido/alerta/42',
          criadoEm: '2026-01-01T00:00:00Z',
        },
      ],
      porSeveridade: { critical: 1, high: 0, medium: 0, low: 0 },
      naoVerificado: [],
      vigilanciaLigada: true,
      correcaoAutomaticaLigada: null,
      codeScanningHabilitado: null,
      codeScanningMensagem: null,
      alertasDeCodigo: [],
      secretScanningHabilitado: null,
      secretScanningMensagem: null,
      alertasDeSegredo: [],
    }
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: false },
      pullRequests: [],
      issues: [],
      dividaDeSeguranca: divida,
    }

    await rememberRepoContext({ writeDrawer }, 'loureng/gitorch', context, () => 'TS')

    expect(drawers).toHaveLength(2) // board + dívida (sem PR/Issue neste caso)
    const gaveta = drawers.find((d) => d.id === 'github:loureng/gitorch:divida-de-seguranca')
    expect(gaveta).toBeDefined()
    expect(gaveta?.wingId).toBe('loureng/gitorch')
    expect(gaveta?.content).toContain('1 crítico(s)')
    expect(gaveta?.content).toContain('#42 pacote-x (critical)')
  })

  it('preserva naoVerificado na gaveta — nunca finge zero alertas quando ninguém verificou', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const dividaSemAlcance: DividaDeSeguranca = {
      temConfiguracao: false,
      alertas: [],
      porSeveridade: { critical: 0, high: 0, medium: 0, low: 0 },
      naoVerificado: ['configuracao', 'alertas'],
      vigilanciaLigada: null,
      correcaoAutomaticaLigada: null,
      codeScanningHabilitado: null,
      codeScanningMensagem: null,
      alertasDeCodigo: [],
      secretScanningHabilitado: null,
      secretScanningMensagem: null,
      alertasDeSegredo: [],
    }
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: false },
      pullRequests: [],
      issues: [],
      dividaDeSeguranca: dividaSemAlcance,
    }

    await rememberRepoContext({ writeDrawer }, 'o/r', context, () => 'TS')

    const gaveta = drawers.find((d) => d.id === 'github:o/r:divida-de-seguranca')
    // "0 alertas" sozinho, sem o aviso, mentiria: ninguém verificou —
    // não é a mesma coisa que "verificado, zero encontrado".
    expect(gaveta?.content).toContain('0 alerta(s)')
    expect(gaveta?.content).toContain('configuracao')
    expect(gaveta?.content).toContain('alertas')
  })

  it('sem dívida de segurança no contexto (undefined), não grava gaveta extra', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: false },
      pullRequests: [],
      issues: [],
    }

    await rememberRepoContext({ writeDrawer }, 'o/r', context, () => 'TS')

    expect(drawers).toHaveLength(1) // só o board
    expect(drawers.some((d) => d.id.includes('divida-de-seguranca'))).toBe(false)
  })
})

describe('collectAndRememberRepoContext (orquestração best-effort)', () => {
  it('resolve o dono → coleta board+PRs+Issues → grava, e devolve o resumo', async () => {
    const { writeDrawer } = fakeCortex()
    const transport = routingTransport({
      owner: () => ({ data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } } }),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 9 } } } }),
      repo: () => ({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 1,
                  title: 'p',
                  state: 'OPEN',
                  url: 'u',
                  updatedAt: 't',
                  author: { login: 'a' },
                },
              ],
            },
            issues: { nodes: [] },
          },
        },
      }),
    })

    const result = await collectAndRememberRepoContext({
      token: 't',
      wingId: 'loureng/gitorch',
      cortex: { writeDrawer },
      request: transport,
      now: () => 'TS',
    })

    expect(result).toEqual({
      collected: true,
      boardNumber: 9,
      boardCreated: true,
      prCount: 1,
      issueCount: 0,
    })
    // board + 1 PR gravados.
    expect(writeDrawer).toHaveBeenCalledTimes(2)
  })

  it('com o App instalado no repositório, a dívida de segurança entra no contexto e vira gaveta própria', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const transport = routingTransport({
      owner: () => ({ data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } } }),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 9 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const fetchImpl = restDeMentira({
      '/repos/loureng/gitorch/contents/.github/dependabot.yml': { status: 404 },
      '/repos/loureng/gitorch/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [],
      },
    })

    const result = await collectAndRememberRepoContext({
      token: 't',
      mintAppToken: async () => 'ghs_app_installation_token',
      wingId: 'loureng/gitorch',
      cortex: { writeDrawer },
      request: transport,
      fetchImpl,
      now: () => 'TS',
    })

    expect(result.collected).toBe(true)
    const gaveta = drawers.find((d) => d.id === 'github:loureng/gitorch:divida-de-seguranca')
    expect(gaveta).toBeDefined()
  })

  it('sem o App instalado no repositório, o contexto sai sem dívida de segurança (comportamento best-effort preservado)', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const transport = routingTransport({
      owner: () => ({ data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } } }),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 9 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const chamadasRest: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      chamadasRest.push(String(url))
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    await collectAndRememberRepoContext({
      token: 't',
      mintAppToken: async () => null,
      wingId: 'loureng/gitorch',
      cortex: { writeDrawer },
      request: transport,
      fetchImpl,
      now: () => 'TS',
    })

    expect(chamadasRest).toEqual([])
    expect(drawers.some((d) => d.id.includes('divida-de-seguranca'))).toBe(false)
  })

  it('best-effort: wingId inválido (sem "/") → collected:false, não grava nada', async () => {
    const { writeDrawer } = fakeCortex()
    const result = await collectAndRememberRepoContext({
      token: 't',
      wingId: 'sem-barra',
      cortex: { writeDrawer },
    })
    expect(result.collected).toBe(false)
    expect(result.reason).toContain('wingId inválido')
    expect(writeDrawer).not.toHaveBeenCalled()
  })

  it('best-effort: dono não resolvido (repository null) → collected:false, não lança', async () => {
    const { writeDrawer } = fakeCortex()
    const transport = routingTransport({ owner: () => ({ data: { repository: null } }) })
    const result = await collectAndRememberRepoContext({
      token: 't',
      wingId: 'o/r',
      cortex: { writeDrawer },
      request: transport,
    })
    expect(result.collected).toBe(false)
    expect(result.reason).toContain('não resolvido')
    expect(writeDrawer).not.toHaveBeenCalled()
  })

  it('best-effort: erro real de API (errors[]) → collected:false com o motivo, NUNCA lança', async () => {
    const { writeDrawer } = fakeCortex()
    const transport = routingTransport({
      owner: () => ({ errors: [{ message: 'Bad credentials' }] }),
    })
    const result = await collectAndRememberRepoContext({
      token: 't',
      wingId: 'o/r',
      cortex: { writeDrawer },
      request: transport,
    })
    expect(result.collected).toBe(false)
    expect(result.reason).toContain('Bad credentials')
    expect(writeDrawer).not.toHaveBeenCalled()
  })
})
