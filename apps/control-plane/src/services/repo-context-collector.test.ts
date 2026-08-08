import { describe, it, expect } from 'vitest'
import { RepoContextCollector } from './repo-context-collector.js'
import type { GraphQLRequest, GraphQLResponse, GraphQLTransport } from '@gitorch/github-sync'
import { restDeMentira } from '../test/rest-fake.js'

type ResponseFor = (req: GraphQLRequest) => GraphQLResponse<unknown>

// O collector faz 3 tipos de chamada GraphQL (findProjectId, createProjectV2,
// RepoContext). Este fake roteia cada uma pelo conteúdo da query e registra as
// chamadas — um só transporte cobre board + PRs/Issues, igual à produção.
function routingTransport(handlers: {
  find?: ResponseFor
  create?: ResponseFor
  repo?: ResponseFor
}): {
  transport: GraphQLTransport
  calls: GraphQLRequest[]
} {
  const calls: GraphQLRequest[] = []
  const transport = async (req: GraphQLRequest): Promise<GraphQLResponse<unknown>> => {
    calls.push(req)
    if (req.query.includes('GetProjectId') && handlers.find) return handlers.find(req)
    if (req.query.includes('CreateProjectV2') && handlers.create) return handlers.create(req)
    if (req.query.includes('RepoContext') && handlers.repo) return handlers.repo(req)
    throw new Error(`fake transport: sem handler para a query:\n${req.query}`)
  }
  return { transport: transport as unknown as GraphQLTransport, calls }
}

describe('RepoContextCollector', () => {
  it('acha o board existente pelo número e coleta PRs + Issues', async () => {
    const { transport, calls } = routingTransport({
      find: () => ({ data: { user: { projectV2: { id: 'PVT_existing' } } } }),
      repo: () => ({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 7,
                  title: 'feat: x',
                  state: 'OPEN',
                  url: 'https://github.com/o/r/pull/7',
                  updatedAt: '2026-07-10T00:00:00Z',
                  author: { login: 'loureng' },
                },
              ],
            },
            issues: {
              nodes: [
                {
                  number: 3,
                  title: 'bug: y',
                  state: 'CLOSED',
                  url: 'https://github.com/o/r/issues/3',
                  updatedAt: '2026-07-09T00:00:00Z',
                  author: { login: 'octocat' },
                },
              ],
            },
          },
        },
      }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'loureng',
      repo: 'gitorch',
      ownerType: 'user',
      ownerId: 'U_1',
      boardNumber: 2,
    })

    expect(ctx.board).toEqual({ id: 'PVT_existing', number: 2, created: false })
    expect(ctx.pullRequests).toEqual([
      {
        number: 7,
        title: 'feat: x',
        state: 'OPEN',
        url: 'https://github.com/o/r/pull/7',
        updatedAt: '2026-07-10T00:00:00Z',
        author: 'loureng',
      },
    ])
    expect(ctx.issues).toEqual([
      {
        number: 3,
        title: 'bug: y',
        state: 'CLOSED',
        url: 'https://github.com/o/r/issues/3',
        updatedAt: '2026-07-09T00:00:00Z',
        author: 'octocat',
      },
    ])
    // Board já existia → NÃO criou outro.
    expect(calls.some((c) => c.query.includes('CreateProjectV2'))).toBe(false)
  })

  it('cria o board quando não há número conhecido (boardNumber ausente) e deriva o título do repo', async () => {
    const { transport, calls } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 12 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'loureng',
      repo: 'gitorch',
      ownerType: 'user',
      ownerId: 'U_1',
    })

    expect(ctx.board).toEqual({ id: 'PVT_new', number: 12, created: true })
    const createCall = calls.find((c) => c.query.includes('CreateProjectV2'))
    expect(createCall?.variables).toEqual({ ownerId: 'U_1', title: 'GitOrch — gitorch' })
    // Sem número conhecido → nem tentou o findProjectId.
    expect(calls.some((c) => c.query.includes('GetProjectId'))).toBe(false)
  })

  it('cria o board quando o número conhecido não existe mais (findProjectId → null)', async () => {
    const { transport } = routingTransport({
      find: () => ({ data: { organization: { projectV2: null } } }),
      create: () => ({
        data: { createProjectV2: { projectV2: { id: 'PVT_recreated', number: 9 } } },
      }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'org',
      repo: 'r',
      ownerType: 'organization',
      ownerId: 'O_1',
      boardNumber: 4,
    })

    expect(ctx.board).toEqual({ id: 'PVT_recreated', number: 9, created: true })
  })

  it('trata autor nulo (bot / conta apagada) sem quebrar', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 1,
                  title: 'dependabot bump',
                  state: 'MERGED',
                  url: 'u',
                  updatedAt: 't',
                  author: null,
                },
              ],
            },
            issues: { nodes: [] },
          },
        },
      }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({ owner: 'o', repo: 'r', ownerType: 'user', ownerId: 'U' })
    expect(ctx.pullRequests[0]?.author).toBeNull()
  })

  it('repository null → PRs/Issues vazios (best-effort, não quebra o aceite)', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({ data: { repository: null } }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'ghost',
      ownerType: 'user',
      ownerId: 'U',
    })
    expect(ctx.pullRequests).toEqual([])
    expect(ctx.issues).toEqual([])
  })

  it('erro real do GraphQL (errors[]) na leitura de PRs/Issues propaga — não mascara', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({ errors: [{ message: 'API rate limit exceeded' }] }),
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    await expect(
      collector.collect({ owner: 'o', repo: 'r', ownerType: 'user', ownerId: 'U' })
    ).rejects.toThrow('GitHub GraphQL request failed: API rate limit exceeded')
  })

  // As rotas de segurança recusam a credencial do App do produto com 403 — só
  // a do cliente alcança. Sem ela, tentar a rota só produziria naoVerificado
  // por 403 disfarçado; o correto é nem chamar.
  it('sem credencial do cliente, o contexto sai sem dívida de segurança — e não tenta a rota', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const chamadasRest: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      chamadasRest.push(String(url))
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const collector = new RepoContextCollector({ token: 't', request: transport, fetchImpl })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'r',
      ownerType: 'user',
      ownerId: 'U',
      clientToken: null,
    })

    expect(ctx.dividaDeSeguranca).toBeUndefined()
    expect(chamadasRest).toEqual([])
  })

  it('com credencial do cliente, a dívida de segurança entra no retrato', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const fetchImpl = restDeMentira({
      '/repos/o/r/vulnerability-alerts': { status: 204 },
      '/repos/o/r/automated-security-fixes': { status: 404 },
      '/repos/o/r/contents/.github/dependabot.yml': { status: 404 },
      '/repos/o/r/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
    })
    const collector = new RepoContextCollector({ token: 't', request: transport, fetchImpl })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'r',
      ownerType: 'user',
      ownerId: 'U',
      clientToken: 'tok-cliente',
    })

    expect(ctx.dividaDeSeguranca?.porSeveridade).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    })
    expect(ctx.dividaDeSeguranca?.vigilanciaLigada).toBe(true)
  })
})
