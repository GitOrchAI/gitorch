import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import { nascerDesejo, type PrismaLikeParaNascerDesejo } from './nascer-desejo.js'

// Achado A (revisão do fix-up 2) — o nascimento ÚNICO de uma issue de
// desejo. Antes desta extração, os 4 nascimentos (routes/index.ts,
// plugins/telegram.ts, plugins/scheduler.ts×2) reimplementavam o MESMO
// trio: resolver o quadro, montar o fetch guardado pela autonomia REAL do
// projeto e criar a issue. Um deles (`pedirOAvisoDePublicacao`) nem
// chegava a montar o fetch guardado — a issue nunca nascia, em NENHUM
// nível de autonomia (L4-T19).

const REPO = 'acme/api'
const PROJECT_ID = 'proj_1'

function fakePrisma(opts: {
  wingId?: string | null
  userId?: string | null
  autonomia?: string | null
}): PrismaLikeParaNascerDesejo {
  return {
    project: {
      findUnique: vi.fn(async () => ({
        wingId: opts.wingId ?? REPO,
        userId: opts.userId ?? 'user_1',
        encryptedClientToken: null,
      })),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ autonomia: opts.autonomia ?? null })),
    },
  }
}

/** Um `fetch` fake que atende as três chamadas que `nascerDesejo` pode
 *  disparar: listar quadros (GraphQL), criar a issue (REST) e anexar ao
 *  quadro (GraphQL) — as mesmas três de `quadro-do-repositorio.test.ts`. */
function fakeFetch(opts: {
  quadros: Array<Record<string, unknown>>
  issueNumber?: number
  issueNodeId?: string | null
  addItemByIdImpl?: () => Response | Promise<Response>
}) {
  const chamadas: Array<{ url: string; method: string; body?: string }> = []
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? String(init.body) : undefined
    chamadas.push({ url, method, ...(body !== undefined ? { body } : {}) })

    if (url === 'https://api.github.com/graphql') {
      const corpo = JSON.parse(body ?? '{}') as { query?: string }
      if (corpo.query?.includes('ListarQuadrosDoRepositorio')) {
        return new Response(
          JSON.stringify({ data: { repository: { projectsV2: { nodes: opts.quadros } } } }),
          { status: 200 }
        )
      }
      if (corpo.query?.includes('addProjectV2ItemById')) {
        if (opts.addItemByIdImpl) return opts.addItemByIdImpl()
        return new Response(
          JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'ITEM_1' } } } }),
          { status: 200 }
        )
      }
      throw new Error(`GraphQL inesperado no teste: ${corpo.query}`)
    }

    if (url.endsWith('/issues') && method === 'POST') {
      return new Response(
        JSON.stringify({
          number: opts.issueNumber ?? 99,
          node_id: opts.issueNodeId === undefined ? 'ISSUE_NODE' : opts.issueNodeId,
        }),
        { status: 201 }
      )
    }

    throw new Error(`fetch inesperado no teste: ${method} ${url}`)
  })
  return { impl: impl as unknown as typeof fetch, chamadas }
}

describe('nascerDesejo', () => {
  const originalSelfRepo = process.env['GITORCH_SELF_REPO']
  beforeEach(() => {
    process.env['GITORCH_SELF_REPO'] = 'GitOrchAI/gitorch'
  })
  afterEach(() => {
    if (originalSelfRepo === undefined) delete process.env['GITORCH_SELF_REPO']
    else process.env['GITORCH_SELF_REPO'] = originalSelfRepo
  })

  it('cuidar: cria a issue E anexa ao quadro, com o fetch guardado', async () => {
    const prisma = fakePrisma({ autonomia: 'cuidar' })
    const getRawGithubToken = vi.fn(async () => 'token-do-login')
    const { impl, chamadas } = fakeFetch({
      quadros: [{ id: 'PVT_1', number: 2, title: REPO, closed: false }],
    })

    const resultado = await nascerDesejo(
      {
        projectId: PROJECT_ID,
        repo: REPO,
        titulo: 'quero busca por cor',
        corpo: 'corpo do pedido',
        etiquetas: ['wishlist'],
      },
      {
        prisma,
        engineConnections: { getRawGithubToken },
        fetchImpl: impl,
        obterToken: async () => 'token-da-issue',
      }
    )

    expect(resultado).toEqual({ numero: 99 })
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/issues'))).toBe(true)
    expect(chamadas.some((c) => c.body?.includes('addProjectV2ItemById'))).toBe(true)
  })

  it('so_olhar: a escrita real é recusada — EscritaNaoAutorizadaError propaga (o 403 de 065d779 continua funcionando)', async () => {
    const prisma = fakePrisma({ autonomia: 'so_olhar' })
    const getRawGithubToken = vi.fn(async () => 'token-do-login')
    const { impl } = fakeFetch({
      quadros: [{ id: 'PVT_1', number: 2, title: REPO, closed: false }],
    })

    await expect(
      nascerDesejo(
        {
          projectId: PROJECT_ID,
          repo: REPO,
          titulo: 'quero busca por cor',
          corpo: 'corpo do pedido',
          etiquetas: ['wishlist'],
        },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: impl,
          obterToken: async () => 'token-da-issue',
        }
      )
    ).rejects.toBeInstanceOf(EscritaNaoAutorizadaError)
  })

  it('sem quadro decidido: a issue nasce igual, e o motivo vira log — nunca lança por causa do quadro', async () => {
    const prisma = fakePrisma({ autonomia: 'cuidar' })
    const getRawGithubToken = vi.fn(async () => null) // sem credencial => sem quadro
    const onInfo = vi.fn()
    const { impl, chamadas } = fakeFetch({ quadros: [] })

    const resultado = await nascerDesejo(
      {
        projectId: PROJECT_ID,
        repo: REPO,
        titulo: 'quero busca por cor',
        corpo: 'corpo do pedido',
        etiquetas: ['wishlist'],
      },
      {
        prisma,
        engineConnections: { getRawGithubToken },
        fetchImpl: impl,
        onInfo,
        obterToken: async () => 'token-da-issue',
      }
    )

    expect(resultado).toEqual({ numero: 99 })
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/issues'))).toBe(true)
    expect(chamadas.some((c) => c.body?.includes('addProjectV2ItemById'))).toBe(false)
    expect(onInfo).toHaveBeenCalledTimes(1)
    expect(onInfo.mock.calls[0]?.[0]).toContain(`quadro não decidido para ${REPO}`)
  })

  it('anexo ao quadro falha: a issue nasce igual, e a falha vira warn — nunca desfaz a issue', async () => {
    const prisma = fakePrisma({ autonomia: 'cuidar' })
    const getRawGithubToken = vi.fn(async () => 'token-do-login')
    const onWarn = vi.fn()
    const { impl } = fakeFetch({
      quadros: [{ id: 'PVT_1', number: 2, title: REPO, closed: false }],
      addItemByIdImpl: () =>
        new Response(JSON.stringify({ errors: [{ message: 'boom de rede' }] }), { status: 200 }),
    })

    const resultado = await nascerDesejo(
      {
        projectId: PROJECT_ID,
        repo: REPO,
        titulo: 'quero busca por cor',
        corpo: 'corpo do pedido',
        etiquetas: ['wishlist'],
        log: { onWarn },
      },
      {
        prisma,
        engineConnections: { getRawGithubToken },
        fetchImpl: impl,
        obterToken: async () => 'token-da-issue',
      }
    )

    expect(resultado).toEqual({ numero: 99 })
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('99')
  })
})
