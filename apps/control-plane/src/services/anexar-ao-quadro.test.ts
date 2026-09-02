import { describe, it, expect, vi } from 'vitest'
import { anexarAoQuadro, criarGqlDoGithub } from './anexar-ao-quadro.js'
import { GithubExecutionError } from './github-errors.js'

// Extraído de board-status.ts (createCardMover): a MESMA lógica idempotente
// de "adiciona ao board, e se já existir, acha o item existente" — agora
// reusável por qualquer chamador que precise pendurar uma issue recém-criada
// no quadro (desejo, incidente, varredura), sem duplicar o try/catch.

function fakeClient(opts: {
  addItemByIdImpl: (args: { projectId: string; contentId: string }) => Promise<string>
}) {
  return { addItemById: vi.fn(opts.addItemByIdImpl) }
}

describe('anexarAoQuadro', () => {
  it('anexa a issue nova e devolve o id do item — caminho feliz', async () => {
    const client = fakeClient({ addItemByIdImpl: async () => 'ITEM_1' })
    const gql = vi.fn()

    const resultado = await anexarAoQuadro({ projectId: 'P1', issueNodeId: 'I1' }, { client, gql })

    expect(resultado.itemId).toBe('ITEM_1')
    expect(client.addItemById).toHaveBeenCalledWith({ projectId: 'P1', contentId: 'I1' })
    expect(gql).not.toHaveBeenCalled()
  })

  it('idempotência: "already exists" reencontra o item existente via GraphQL', async () => {
    const client = fakeClient({
      addItemByIdImpl: async () => {
        throw new Error('Content already exists in this project')
      },
    })
    const gql = vi.fn().mockResolvedValue({
      node: { projectItems: { nodes: [{ id: 'ITEM_JA_EXISTIA', project: { id: 'P1' } }] } },
    })

    const resultado = await anexarAoQuadro({ projectId: 'P1', issueNodeId: 'I1' }, { client, gql })

    expect(resultado.itemId).toBe('ITEM_JA_EXISTIA')
    expect(gql).toHaveBeenCalledTimes(1)
  })

  it('"already exists" mas o item não pertence a ESTE quadro → relança o erro original', async () => {
    const erroOriginal = new Error('Content already exists in this project')
    const client = fakeClient({
      addItemByIdImpl: async () => {
        throw erroOriginal
      },
    })
    const gql = vi.fn().mockResolvedValue({
      node: {
        projectItems: { nodes: [{ id: 'ITEM_DE_OUTRO_QUADRO', project: { id: 'OUTRO_P' } }] },
      },
    })

    await expect(
      anexarAoQuadro({ projectId: 'P1', issueNodeId: 'I1' }, { client, gql })
    ).rejects.toBe(erroOriginal)
  })

  it('erro que NÃO é "already exists" propaga sem tentar reencontrar (nunca engole falha real)', async () => {
    const erroDeRede = new Error('ECONNRESET')
    const client = fakeClient({
      addItemByIdImpl: async () => {
        throw erroDeRede
      },
    })
    const gql = vi.fn()

    await expect(
      anexarAoQuadro({ projectId: 'P1', issueNodeId: 'I1' }, { client, gql })
    ).rejects.toBe(erroDeRede)
    expect(gql).not.toHaveBeenCalled()
  })

  it('statusInicial + setStatus: seta a coluna depois de anexar', async () => {
    const client = fakeClient({ addItemByIdImpl: async () => 'ITEM_1' })
    const gql = vi.fn()
    const setStatus = vi.fn().mockResolvedValue('set')

    const resultado = await anexarAoQuadro(
      { projectId: 'P1', issueNodeId: 'I1', statusInicial: 'todo' },
      { client, gql, setStatus }
    )

    expect(setStatus).toHaveBeenCalledWith('ITEM_1', 'todo')
    expect(resultado.statusResultado).toBe('set')
  })

  it('sem statusInicial → nunca chama setStatus, mesmo que a dependência exista', async () => {
    const client = fakeClient({ addItemByIdImpl: async () => 'ITEM_1' })
    const gql = vi.fn()
    const setStatus = vi.fn()

    const resultado = await anexarAoQuadro(
      { projectId: 'P1', issueNodeId: 'I1' },
      { client, gql, setStatus }
    )

    expect(setStatus).not.toHaveBeenCalled()
    expect(resultado.statusResultado).toBeUndefined()
  })

  it('statusInicial pedido mas SEM dependência setStatus → não lança, só não seta coluna', async () => {
    const client = fakeClient({ addItemByIdImpl: async () => 'ITEM_1' })
    const gql = vi.fn()

    const resultado = await anexarAoQuadro(
      { projectId: 'P1', issueNodeId: 'I1', statusInicial: 'todo' },
      { client, gql }
    )

    expect(resultado.itemId).toBe('ITEM_1')
    expect(resultado.statusResultado).toBeUndefined()
  })
})

describe('criarGqlDoGithub', () => {
  it('POST único para /graphql, autorização Bearer, devolve data já desembrulhado', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }))
    const gql = criarGqlDoGithub(f as unknown as typeof fetch, 'TOKEN_X')

    const data = await gql<{ ok: boolean }>('query { x }', { a: 1 })

    expect(data).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer TOKEN_X')
    expect(JSON.parse(String(init.body))).toEqual({ query: 'query { x }', variables: { a: 1 } })
  })

  it('errors[] do GraphQL nunca vira sucesso silencioso', async () => {
    const f = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Resource not accessible' }] }), {
          status: 200,
        })
    )
    const gql = criarGqlDoGithub(f as unknown as typeof fetch, 'TOKEN_X')

    await expect(gql('query { x }', {})).rejects.toBeInstanceOf(GithubExecutionError)
    await expect(gql('query { x }', {})).rejects.toThrow(/Resource not accessible/)
  })

  it('resposta sem data e sem errors também não vira sucesso', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    const gql = criarGqlDoGithub(f as unknown as typeof fetch, 'TOKEN_X')

    await expect(gql('query { x }', {})).rejects.toBeInstanceOf(GithubExecutionError)
  })
})
