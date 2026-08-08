import { describe, it, expect, vi } from 'vitest'
import type { CortexDrawer } from '@gitorch/cortex'
import type { GraphQLRequest, GraphQLResponse, GraphQLTransport } from '@gitorch/github-sync'
import { collectAndRememberRepoContext, rememberRepoContext } from './repo-context-cortex.js'
import type { CollectedRepoContext } from './repo-context-collector.js'
import type { DividaDeSeguranca } from './security-debt-collector.js'

type ResponseFor = (req: GraphQLRequest) => GraphQLResponse<unknown>

// O orquestrador faz 4 tipos de chamada (RepoOwner, findProjectId,
// createProjectV2, RepoContext). Este fake roteia cada uma pela query.
function routingTransport(handlers: {
  owner?: ResponseFor
  find?: ResponseFor
  create?: ResponseFor
  repo?: ResponseFor
}): GraphQLTransport {
  const transport = async (req: GraphQLRequest): Promise<GraphQLResponse<unknown>> => {
    if (req.query.includes('RepoOwner') && handlers.owner) return handlers.owner(req)
    if (req.query.includes('GetProjectId') && handlers.find) return handlers.find(req)
    if (req.query.includes('CreateProjectV2') && handlers.create) return handlers.create(req)
    if (req.query.includes('RepoContext') && handlers.repo) return handlers.repo(req)
    throw new Error(`fake transport: sem handler para a query:\n${req.query}`)
  }
  return transport as unknown as GraphQLTransport
}

function fakeCortex() {
  const drawers: CortexDrawer[] = []
  // Sem anotação de tipo aqui: deixa o vitest inferir o Mock TIPADO (com a
  // assinatura de writeDrawer), senão ele alarga pro Mock genérico e deixa de
  // ser atribuível a CortexWriter.
  const writeDrawer = vi.fn(async (d: CortexDrawer) => {
    drawers.push(d)
  })
  return { writeDrawer, drawers }
}

describe('rememberRepoContext (ponte GitHub → Cortex)', () => {
  it('grava uma gaveta por PR e por Issue + uma do board, com ids determinísticos e carimbo de wingId', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: true },
      pullRequests: [
        {
          number: 7,
          title: 'feat: x',
          state: 'OPEN',
          url: 'u1',
          updatedAt: 't1',
          author: 'loureng',
        },
      ],
      issues: [
        { number: 3, title: 'bug: y', state: 'CLOSED', url: 'u2', updatedAt: 't2', author: null },
      ],
    }

    await rememberRepoContext({ writeDrawer }, 'loureng/gitorch', context, () => 'TS')

    expect(drawers).toHaveLength(3)
    const ids = drawers.map((d) => d.id)
    expect(ids).toContain('github:loureng/gitorch:board')
    expect(ids).toContain('github:loureng/gitorch:pull-request:7')
    expect(ids).toContain('github:loureng/gitorch:issue:3')
    // Isolamento por projeto: toda gaveta carimbada com o wingId.
    expect(drawers.every((d) => d.wingId === 'loureng/gitorch')).toBe(true)
    // Timestamp determinístico propagado.
    expect(drawers.every((d) => d.createdAt === 'TS' && d.validFrom === 'TS')).toBe(true)
    // Autor nulo (bot/conta apagada) não quebra o conteúdo.
    expect(drawers.find((d) => d.id.endsWith(':issue:3'))?.content).toContain('autor desconhecido')
    expect(drawers.find((d) => d.id.endsWith(':pull-request:7'))?.content).toContain(
      'autor loureng'
    )
  })

  it('ids determinísticos → recoletar faz upsert (mesmo id), não duplica na memória', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const context: CollectedRepoContext = {
      board: { id: 'PVT_1', number: 5, created: false },
      pullRequests: [
        { number: 7, title: 'p', state: 'OPEN', url: 'u', updatedAt: 't', author: 'a' },
      ],
      issues: [],
    }

    await rememberRepoContext({ writeDrawer }, 'o/r', context, () => 'T1')
    await rememberRepoContext({ writeDrawer }, 'o/r', context, () => 'T2')

    // 2 gavetas por rodada (board + 1 PR) × 2 rodadas = 4 escritas, mas só 2 ids
    // distintos (upsert) — a memória não polui.
    expect(drawers).toHaveLength(4)
    expect(new Set(drawers.map((d) => d.id)).size).toBe(2)
  })

  it('grava a dívida de segurança como gaveta própria, com resumo por severidade e a lista dos alertas', async () => {
    const { writeDrawer, drawers } = fakeCortex()
    const divida: DividaDeSeguranca = {
      vigilanciaLigada: true,
      correcaoAutomaticaLigada: true,
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
      vigilanciaLigada: null,
      correcaoAutomaticaLigada: null,
      temConfiguracao: false,
      alertas: [],
      porSeveridade: { critical: 0, high: 0, medium: 0, low: 0 },
      naoVerificado: ['vigilancia', 'alertas'],
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
    expect(gaveta?.content).toContain('vigilancia')
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
