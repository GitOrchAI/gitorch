import { describe, it, expect, vi } from 'vitest'
import { createGithubBacklog } from './github-backlog.js'

// O plano vale sem a vitrine.
//
// Enquanto o backlog exigiu quadro, todo repositório de conta pessoal ficava
// sem nada: a credencial do produto não cria nem enxerga quadro lá, o passo
// falhava e o cliente não recebia issue nenhuma — em silêncio. Issue, árvore e
// marco são trabalho de repositório e não dependem de board; o que o board
// acrescenta é card, coluna, iteração e recado de sprint.

/** Responde REST e GraphQL, e anota tudo que foi chamado. */
function githubDeMentira() {
  const chamadas: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url)
    const corpo = typeof init?.body === 'string' ? init.body : ''
    chamadas.push(endereco.includes('/graphql') ? `graphql:${corpo.slice(0, 60)}` : endereco)

    if (endereco.includes('/graphql')) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }
    return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
  })
  return { chamadas, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('backlog sem quadro', () => {
  it('cria a issue normalmente — o trabalho de repositório não depende do board', async () => {
    const { chamadas, fetchImpl } = githubDeMentira()
    const backlog = createGithubBacklog({ token: 't', repository: 'dono/repo', fetchImpl })

    const ref = await backlog.createIssue({ title: 'uma tarefa', body: 'corpo' })

    expect(ref).toEqual({ number: 1, nodeId: 'I_1' })
    expect(chamadas.some((c) => c.includes('/repos/dono/repo/issues'))).toBe(true)
  })

  it('não tenta pendurar card em quadro que não existe', async () => {
    const { chamadas, fetchImpl } = githubDeMentira()
    const backlog = createGithubBacklog({ token: 't', repository: 'dono/repo', fetchImpl })

    const item = await backlog.addToBoard('I_1')

    expect(item).toBe('')
    expect(chamadas.filter((c) => c.startsWith('graphql'))).toEqual([])
  })

  it('sprint, status e recado de sprint viram silêncio, não erro', async () => {
    const { chamadas, fetchImpl } = githubDeMentira()
    const backlog = createGithubBacklog({ token: 't', repository: 'dono/repo', fetchImpl })

    await expect(backlog.setSprint('', 1)).resolves.toBeUndefined()
    await expect(backlog.setStatus?.('', 'todo')).resolves.toBeUndefined()
    await expect(backlog.postSprintGoal?.('entregar o funil')).resolves.toBeUndefined()

    expect(chamadas.filter((c) => c.startsWith('graphql'))).toEqual([])
  })

  it('com quadro, o card volta a ser pendurado', async () => {
    const chamadas: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endereco = String(url)
      const corpo = typeof init?.body === 'string' ? init.body : ''
      if (endereco.includes('/graphql')) {
        chamadas.push(corpo)
        return new Response(
          JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } } }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
    }) as unknown as typeof fetch

    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl,
    })

    await expect(backlog.addToBoard('I_1')).resolves.toBe('PVTI_9')
    expect(chamadas.join(' ')).toContain('PVT_1')
  })
})

describe('teto de tempo (leva D)', () => {
  it('REST direto (createIssue) e via ProjectV2Client (addToBoard) carregam um AbortSignal não abortado', async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const endereco = String(url)
        if (endereco.includes('/graphql')) {
          return new Response(
            JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } } }),
            { status: 200 }
          )
        }
        return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
      }
    )

    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await backlog.createIssue({ title: 't', body: 'b' })
    await backlog.addToBoard('I_1')

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})
