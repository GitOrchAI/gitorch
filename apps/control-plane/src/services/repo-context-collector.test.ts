import { describe, it, expect } from 'vitest'
import { RepoContextCollector } from './repo-context-collector.js'
import type { GraphQLRequest, GraphQLResponse, GraphQLTransport } from '@gitorch/github-sync'
import { restDeMentira } from '../test/rest-fake.js'

type ResponseFor = (req: GraphQLRequest) => GraphQLResponse<unknown>

// O collector faz 4 tipos de chamada GraphQL (findProjectId,
// listarQuadrosDoRepositorio, createProjectV2, RepoContext). Este fake roteia
// cada uma pelo conteúdo da query e registra as chamadas — um só transporte
// cobre board + PRs/Issues, igual à produção.
//
// `listar` tem PADRÃO de lista vazia (e não "sem handler"): repositório sem
// quadro ligado é o caso comum, e é justamente quando criar é legítimo.
function routingTransport(handlers: {
  find?: ResponseFor
  listar?: ResponseFor
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
    if (req.query.includes('ListarQuadrosDoRepositorio')) {
      return handlers.listar
        ? handlers.listar(req)
        : { data: { repository: { projectsV2: { nodes: [] } } } }
    }
    if (req.query.includes('CreateProjectV2') && handlers.create) return handlers.create(req)
    if (req.query.includes('RepoContext') && handlers.repo) return handlers.repo(req)
    throw new Error(`fake transport: sem handler para a query:\n${req.query}`)
  }
  return { transport: transport as unknown as GraphQLTransport, calls }
}

/** Um quadro como a listagem do repositório o devolve. */
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
    title: over.title ?? 'quadro',
    closed: over.closed ?? false,
    items: { totalCount: over.itens ?? 0 },
    fields: { totalCount: over.campos ?? 13 },
  }
}

const listagem = (...nodes: ReturnType<typeof quadroLigado>[]): GraphQLResponse<unknown> => ({
  data: { repository: { projectsV2: { nodes } } },
})

const semPrsNemIssues: ResponseFor = () => ({
  data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
})

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

  it('sem App instalado no repositório, o contexto sai sem dívida de segurança — e não tenta a rota', async () => {
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
    const collector = new RepoContextCollector({
      token: 't',
      request: transport,
      fetchImpl,
      mintAppToken: async () => null,
    })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'r',
      ownerType: 'user',
      ownerId: 'U',
    })

    expect(ctx.dividaDeSeguranca).toBeUndefined()
    expect(chamadasRest).toEqual([])
  })

  it('com App instalado, emite token por repositório e inclui a dívida de segurança no retrato', async () => {
    const { transport } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_1', number: 1 } } } }),
      repo: () => ({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      }),
    })
    const fetchImpl = restDeMentira({
      '/repos/o/r/contents/.github/dependabot.yml': { status: 404 },
      '/repos/o/r/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
    })
    const repositoriosSolicitados: string[] = []
    const collector = new RepoContextCollector({
      token: 't',
      request: transport,
      fetchImpl,
      mintAppToken: async ({ repository }) => {
        repositoriosSolicitados.push(repository)
        return 'tok-app-instalacao'
      },
    })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'r',
      ownerType: 'user',
      ownerId: 'U',
    })

    expect(repositoriosSolicitados).toEqual(['o/r'])
    expect(ctx.dividaDeSeguranca?.porSeveridade).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// O LAÇO QUE PIORAVA SOZINHO (medido no repositório do dono em 31/08/2026).
//
// `decidirQuadro` respondia "escolher" quando achava vários quadros ligados —
// "só o dono sabe qual vale". Mas ESTE caminho criava um quadro para resolver a
// falta de quadro, sem nunca perguntar se já havia algum. Criar deixa mais um
// quadro ligado; a volta seguinte acha mais um e trava de novo. Em
// loureng/patinhas-3d-crafts sobraram quatro quadros ligados, dois deles
// criados pelo produto com 42 segundos de diferença.
//
// A regra que fecha o laço: criar SÓ quando não há nenhum. Nunca como saída
// para "não sei qual usar".
// ---------------------------------------------------------------------------
describe('RepoContextCollector: criar quadro nunca é saída para a dúvida', () => {
  it('já há quadro ligado ao repositório: adota o que existe e NÃO cria outro', async () => {
    const { transport, calls } = routingTransport({
      listar: () => listagem(quadroLigado({ id: 'PVT_do_cliente', number: 3, itens: 146 })),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_novo', number: 99 } } } }),
      repo: semPrsNemIssues,
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'loureng',
      repo: 'patinhas-3d-crafts',
      ownerType: 'user',
      ownerId: 'U_1',
    })

    expect(ctx.board).toEqual({ id: 'PVT_do_cliente', number: 3, created: false })
    expect(calls.some((c) => c.query.includes('CreateProjectV2'))).toBe(false)
  })

  it('o Jardim real: quatro quadros ligados, adota o #3 (146 itens) e não cria um quinto', async () => {
    const { transport, calls } = routingTransport({
      listar: () =>
        listagem(
          quadroLigado({ id: 'PVT_12', number: 12, title: 'loureng/patinhas-3d-crafts' }),
          quadroLigado({ id: 'PVT_11', number: 11, title: 'loureng/patinhas-3d-crafts' }),
          quadroLigado({ id: 'PVT_5', number: 5, closed: true }),
          quadroLigado({
            id: 'PVT_3',
            number: 3,
            title: 'Jardim das Patinhas',
            itens: 146,
            campos: 24,
          })
        ),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_13', number: 13 } } } }),
      repo: semPrsNemIssues,
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'loureng',
      repo: 'patinhas-3d-crafts',
      ownerType: 'user',
      ownerId: 'U_1',
    })

    expect(ctx.board).toEqual({ id: 'PVT_3', number: 3, created: false })
    expect(calls.filter((c) => c.query.includes('CreateProjectV2'))).toHaveLength(0)
  })

  it('rodar DUAS vezes não cria um segundo quadro — é o laço fechado', async () => {
    // O quadro que a primeira passada cria passa a estar ligado, exatamente
    // como no GitHub. Antes, a segunda passada criava outro por cima.
    const ligados: ReturnType<typeof quadroLigado>[] = []
    const { transport, calls } = routingTransport({
      listar: () => listagem(...ligados),
      create: () => {
        const numero = 11 + ligados.length
        ligados.push(quadroLigado({ id: `PVT_${numero}`, number: numero }))
        return { data: { createProjectV2: { projectV2: { id: `PVT_${numero}`, number: numero } } } }
      },
      repo: semPrsNemIssues,
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })
    const entrada = {
      owner: 'loureng',
      repo: 'patinhas-3d-crafts',
      ownerType: 'user' as const,
      ownerId: 'U_1',
    }

    const primeira = await collector.collect(entrada)
    const segunda = await collector.collect(entrada)

    expect(primeira.board).toEqual({ id: 'PVT_11', number: 11, created: true })
    // A segunda REUSA o que a primeira criou.
    expect(segunda.board).toEqual({ id: 'PVT_11', number: 11, created: false })
    // Contando os quadros antes e depois: continua UM só.
    expect(calls.filter((c) => c.query.includes('CreateProjectV2'))).toHaveLength(1)
    expect(ligados).toHaveLength(1)
  })

  it('empate de VERDADE entre ligados: recusa dizendo o motivo, e não cria mais um', async () => {
    const { transport, calls } = routingTransport({
      listar: () =>
        listagem(
          quadroLigado({ id: 'PVT_A', number: 7, itens: 9, campos: 13 }),
          quadroLigado({ id: 'PVT_B', number: 8, itens: 9, campos: 13 })
        ),
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_novo', number: 99 } } } }),
      repo: semPrsNemIssues,
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    await expect(
      collector.collect({ owner: 'o', repo: 'r', ownerType: 'user', ownerId: 'U_1' })
    ).rejects.toThrow(/mais de um quadro|só o dono sabe/i)
    expect(calls.some((c) => c.query.includes('CreateProjectV2'))).toBe(false)
  })

  it('nenhum quadro ligado: aí sim cria — criar continua sendo a saída certa quando não há nada', async () => {
    const { transport, calls } = routingTransport({
      create: () => ({ data: { createProjectV2: { projectV2: { id: 'PVT_novo', number: 1 } } } }),
      repo: semPrsNemIssues,
    })
    const collector = new RepoContextCollector({ token: 't', request: transport })

    const ctx = await collector.collect({
      owner: 'o',
      repo: 'r',
      ownerType: 'user',
      ownerId: 'U_1',
    })

    expect(ctx.board).toEqual({ id: 'PVT_novo', number: 1, created: true })
    // E a pergunta foi FEITA antes de criar — não criou às cegas.
    const ordem = calls.map((c) =>
      c.query.includes('ListarQuadrosDoRepositorio')
        ? 'listar'
        : c.query.includes('CreateProjectV2')
          ? 'criar'
          : 'outra'
    )
    expect(ordem.indexOf('listar')).toBeGreaterThanOrEqual(0)
    expect(ordem.indexOf('listar')).toBeLessThan(ordem.indexOf('criar'))
  })
})
