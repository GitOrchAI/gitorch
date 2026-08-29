import { describe, it, expect } from 'vitest'
import {
  lerArvoreDePedidos,
  projetoDaLinha,
  ArvoreIndisponivelError,
  type DepsDaArvoreDePedidos,
} from './arvore-de-pedidos.js'

// Os formatos aqui vieram da resposta REAL da API, disparada antes de escrever
// o serviço (29/08, GitOrchAI/gitorch): 5 pedidos, com um deles em 1 de 3
// partes e outro em 0 de 0.

function issue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 30,
    title: 'Conseguir solicitar wishlist via telegram',
    state: 'OPEN',
    createdAt: '2026-08-06T12:00:00Z',
    url: 'https://github.com/GitOrchAI/gitorch/issues/30',
    subIssuesSummary: { total: 3, completed: 0 },
    ...over,
  }
}

/** fetch falso que devolve o corpo do GraphQL por repositório. */
function githubFake(porRepo: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body ?? '{}')) as {
      variables?: { owner?: string; name?: string }
    }
    const chave = `${corpo.variables?.owner}/${corpo.variables?.name}`
    const resposta = porRepo[chave]
    if (resposta === undefined) throw new Error('rede caiu')
    if (resposta === 'http-500') return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => resposta }
  }) as unknown as typeof fetch
}

function deps(over: Partial<DepsDaArvoreDePedidos> = {}): DepsDaArvoreDePedidos {
  return {
    listarProjetos: async () => [{ nome: 'gitorch', repo: 'GitOrchAI/gitorch' }],
    lerToken: async () => 'token-do-dono',
    fetchImpl: githubFake({
      'GitOrchAI/gitorch': { data: { repository: { issues: { nodes: [issue()] } } } },
    }),
    ...over,
  }
}

describe('lerArvoreDePedidos', () => {
  it('devolve o pedido com o andamento que o GitHub reporta', async () => {
    const r = await lerArvoreDePedidos(deps(), { ownerId: 'u1' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      numero: 30,
      titulo: 'Conseguir solicitar wishlist via telegram',
      situacao: 'andando',
      projeto: 'gitorch',
      partes: { total: 3, concluidas: 0 },
    })
  })

  it('desejo ainda SEM árvore vem 0 de 0 — a tela decide como dizer isso', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        fetchImpl: githubFake({
          'GitOrchAI/gitorch': {
            data: {
              repository: { issues: { nodes: [issue({ subIssuesSummary: null })] } },
            },
          },
        }),
      }),
      { ownerId: 'u1' }
    )
    expect(r[0]?.partes).toEqual({ total: 0, concluidas: 0 })
  })

  it('issue fechada vira entregue', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        fetchImpl: githubFake({
          'GitOrchAI/gitorch': {
            data: { repository: { issues: { nodes: [issue({ state: 'CLOSED' })] } } },
          },
        }),
      }),
      { ownerId: 'u1' }
    )
    expect(r[0]?.situacao).toBe('entregue')
  })

  it('dono sem projeto devolve lista vazia, e nem pede credencial', async () => {
    let pediuToken = false
    const r = await lerArvoreDePedidos(
      deps({
        listarProjetos: async () => [],
        lerToken: async () => {
          pediuToken = true
          return 'x'
        },
      }),
      { ownerId: 'u1' }
    )
    expect(r).toEqual([])
    expect(pediuToken).toBe(false)
  })

  it('projeto sem nenhum desejo devolve lista vazia', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        fetchImpl: githubFake({
          'GitOrchAI/gitorch': { data: { repository: { issues: { nodes: [] } } } },
        }),
      }),
      { ownerId: 'u1' }
    )
    expect(r).toEqual([])
  })

  it('junta os projetos e ordena do mais recente para o mais antigo', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        listarProjetos: async () => [
          { nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
          { nome: 'patinhas', repo: 'loureng/patinhas-3d-crafts' },
        ],
        fetchImpl: githubFake({
          'GitOrchAI/gitorch': {
            data: {
              repository: {
                issues: { nodes: [issue({ number: 30, createdAt: '2026-08-06T12:00:00Z' })] },
              },
            },
          },
          'loureng/patinhas-3d-crafts': {
            data: {
              repository: {
                issues: { nodes: [issue({ number: 7, createdAt: '2026-08-28T12:00:00Z' })] },
              },
            },
          },
        }),
      }),
      { ownerId: 'u1' }
    )
    expect(r.map((p) => p.numero)).toEqual([7, 30])
    expect(r.map((p) => p.projeto)).toEqual(['patinhas', 'gitorch'])
  })

  it('filtra por projeto quando o dono escolhe um', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        listarProjetos: async () => [
          { nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
          { nome: 'patinhas', repo: 'loureng/patinhas-3d-crafts' },
        ],
        fetchImpl: githubFake({
          'loureng/patinhas-3d-crafts': {
            data: { repository: { issues: { nodes: [issue({ number: 7 })] } } },
          },
        }),
      }),
      { ownerId: 'u1', projeto: 'patinhas' }
    )
    expect(r.map((p) => p.numero)).toEqual([7])
  })

  it('um projeto que falha NÃO derruba os outros', async () => {
    const r = await lerArvoreDePedidos(
      deps({
        listarProjetos: async () => [
          { nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
          { nome: 'sumiu', repo: 'loureng/sumiu' },
        ],
        fetchImpl: githubFake({
          'GitOrchAI/gitorch': { data: { repository: { issues: { nodes: [issue()] } } } },
          // 'loureng/sumiu' ausente do fake = rede caiu neste
        }),
      }),
      { ownerId: 'u1' }
    )
    expect(r).toHaveLength(1)
    expect(r[0]?.projeto).toBe('gitorch')
  })

  it('repositório que não existe volta 200 com repository null — conta como falha, não como vazio', async () => {
    await expect(
      lerArvoreDePedidos(
        deps({
          fetchImpl: githubFake({ 'GitOrchAI/gitorch': { data: { repository: null } } }),
        }),
        { ownerId: 'u1' }
      )
    ).rejects.toBeInstanceOf(ArvoreIndisponivelError)
  })

  it('erro de GraphQL no corpo conta como falha, mesmo com status 200', async () => {
    await expect(
      lerArvoreDePedidos(
        deps({
          fetchImpl: githubFake({
            'GitOrchAI/gitorch': { errors: [{ message: 'NOT_FOUND' }], data: null },
          }),
        }),
        { ownerId: 'u1' }
      )
    ).rejects.toBeInstanceOf(ArvoreIndisponivelError)
  })

  it('status ruim do GitHub não vira lista vazia', async () => {
    await expect(
      lerArvoreDePedidos(deps({ fetchImpl: githubFake({ 'GitOrchAI/gitorch': 'http-500' }) }), {
        ownerId: 'u1',
      })
    ).rejects.toBeInstanceOf(ArvoreIndisponivelError)
  })

  it('sem credencial do dono é indisponível, nunca lista vazia', async () => {
    await expect(
      lerArvoreDePedidos(deps({ lerToken: async () => null }), { ownerId: 'u1' })
    ).rejects.toBeInstanceOf(ArvoreIndisponivelError)
  })

  it('endereço de repositório sem forma não quebra o serviço', async () => {
    await expect(
      lerArvoreDePedidos(deps({ listarProjetos: async () => [{ nome: 'x', repo: 'sem-barra' }] }), {
        ownerId: 'u1',
      })
    ).rejects.toBeInstanceOf(ArvoreIndisponivelError)
  })

  it('a credencial vai no cabeçalho e a etiqueta do desejo na consulta', async () => {
    let visto: { headers?: Record<string, string>; body?: string } = {}
    await lerArvoreDePedidos(
      deps({
        fetchImpl: (async (_u: string, init?: RequestInit) => {
          visto = {
            headers: init?.headers as Record<string, string>,
            body: String(init?.body ?? ''),
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { repository: { issues: { nodes: [] } } } }),
          }
        }) as unknown as typeof fetch,
      }),
      { ownerId: 'u1' }
    )
    expect(visto.headers?.['authorization']).toBe('token token-do-dono')
    expect(visto.body).toContain('wishlist')
  })
})

describe('projetoDaLinha — qual campo é o endereço do repositório', () => {
  // Existe por causa de um 503 REAL em produção (29/08): o código mandava
  // `name` como endereço, mas name é o nome curto e quem carrega "owner/repo"
  // é o `wingId`. Sem barra, a consulta nunca resolve e TODOS os projetos
  // falham de uma vez — a tela inteira cai junto.

  it('o endereço vem do wingId; o nome que o dono vê vem do name', () => {
    expect(projetoDaLinha({ name: 'gitorch', wingId: 'GitOrchAI/gitorch' })).toEqual({
      nome: 'gitorch',
      repo: 'GitOrchAI/gitorch',
    })
  })

  it('o endereço sempre tem barra — é o que a consulta ao GitHub exige', () => {
    // Os dois projetos reais do banco, exatamente como estão lá.
    const linhas = [
      { name: 'gitorch', wingId: 'GitOrchAI/gitorch' },
      { name: 'patinhas-3d-crafts', wingId: 'loureng/patinhas-3d-crafts' },
    ]
    for (const p of linhas) expect(projetoDaLinha(p).repo).toContain('/')
  })

  it('trocar os campos quebraria: o name não tem barra', () => {
    // A prova do erro que aconteceu, escrita para nunca mais passar batido.
    expect(projetoDaLinha({ name: 'gitorch', wingId: 'GitOrchAI/gitorch' }).repo).not.toBe(
      'gitorch'
    )
  })
})
