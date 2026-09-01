import { describe, it, expect, vi } from 'vitest'
import { fetchDoRepositorio } from './guarda-de-autonomia.js'
import {
  resolveBoardColumns,
  createBoardStatus,
  createCardMover,
  DEFAULT_BOARD_COLUMNS,
} from './board-status.js'

describe('resolveBoardColumns', () => {
  it('sem config → defaults nativos do Projects v2', () => {
    expect(resolveBoardColumns(null)).toEqual(DEFAULT_BOARD_COLUMNS)
    expect(resolveBoardColumns({})).toEqual(DEFAULT_BOARD_COLUMNS)
  })

  it('config do projeto sobrescreve por nome (dinâmico, nunca hardcoded)', () => {
    const cols = resolveBoardColumns({
      board: { columns: { done: 'Concluído', inProgress: 'Em desenvolvimento' } },
    })
    expect(cols.done).toBe('Concluído')
    expect(cols.inProgress).toBe('Em desenvolvimento')
    expect(cols.todo).toBe('Todo')
  })
})

interface GqlCall {
  query: string
  variables: Record<string, unknown>
}

function fakeGithub(opts: { fieldName?: string; options?: Array<{ id: string; name: string }> }) {
  const calls: { gql: GqlCall[]; rest: string[] } = { gql: [], rest: [] }
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    if (u.endsWith('/graphql')) {
      const body = JSON.parse(String(init?.body)) as GqlCall
      calls.gql.push(body)
      if (body.query.includes('fields(first: 50)')) {
        return json({
          data: {
            node: {
              fields: {
                nodes: opts.fieldName
                  ? [{ id: 'F1', name: opts.fieldName, options: opts.options ?? [] }]
                  : [],
              },
            },
          },
        })
      }
      if (body.query.includes('UpdateProjectV2SingleSelectField')) {
        return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } } })
      }
      if (body.query.includes('addProjectV2ItemById')) {
        return json({ data: { addProjectV2ItemById: { item: { id: 'IT1' } } } })
      }
      if (body.query.includes('GetProjectId') || body.query.includes('projectV2(number')) {
        return json({
          data: { repositoryOwner: { __typename: 'User', projectV2: { id: 'P1' } } },
        })
      }
      return json({ data: {} })
    }
    calls.rest.push(u)
    if (u.includes('/issues/')) return json({ node_id: 'I_node' })
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { calls: typeof calls }).calls = calls
  return impl
}

describe('createBoardStatus', () => {
  it('seta a coluna quando campo e opção existem', async () => {
    const f = fakeGithub({
      fieldName: 'Status',
      options: [
        { id: 'O1', name: 'Todo' },
        { id: 'O2', name: 'Done' },
      ],
    })
    const status = createBoardStatus({ token: 't', projectId: 'P1', fetchImpl: f })
    expect(await status.setStatus('IT1', 'done')).toBe('set')
  })

  it('campo ausente → field-missing (tolerado, nunca lança)', async () => {
    const f = fakeGithub({})
    const status = createBoardStatus({ token: 't', projectId: 'P1', fetchImpl: f })
    expect(await status.setStatus('IT1', 'todo')).toBe('field-missing')
  })

  it('coluna ausente no board do cliente → column-missing', async () => {
    const f = fakeGithub({ fieldName: 'Status', options: [{ id: 'O1', name: 'Todo' }] })
    const status = createBoardStatus({ token: 't', projectId: 'P1', fetchImpl: f })
    expect(await status.setStatus('IT1', 'done')).toBe('column-missing')
  })
})

describe('createCardMover', () => {
  it('issue → item do board → coluna do veredito', async () => {
    const f = fakeGithub({
      fieldName: 'Status',
      options: [
        { id: 'O1', name: 'In Progress' },
        { id: 'O2', name: 'Done' },
      ],
    })
    const move = createCardMover({ repository: 'o/r', board: 'o/9', token: 't', fetchImpl: f })
    const outcome = await move(42, 'done')
    expect(outcome).toContain('card #42 -> Done (set)')
  })
})

describe('teto de tempo (leva D)', () => {
  it('createCardMover SEM fetchImpl passado (os dois call sites de scheduler.ts que nunca passavam) ainda embrulha o `fetch` global com um teto', async () => {
    // Simula exatamente scheduler.ts:~1855 e ~2044 (achado do despacho):
    // nenhum `fetchImpl` é passado. A guarda tem que morar em
    // `createCardMover`/`createBoardStatus`, não no chamador.
    const original = global.fetch
    const chamadas: Array<{ init: RequestInit | undefined }> = []
    global.fetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      chamadas.push({ init })
      const u = String(_url)
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (u.endsWith('/graphql')) {
        const body = JSON.parse(String(init?.body)) as GqlCall
        if (body.query.includes('fields(first: 50)')) {
          return json({
            data: {
              node: {
                fields: {
                  nodes: [{ id: 'F1', name: 'Status', options: [{ id: 'O2', name: 'Done' }] }],
                },
              },
            },
          })
        }
        if (body.query.includes('UpdateProjectV2SingleSelectField')) {
          return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } } })
        }
        if (body.query.includes('addProjectV2ItemById')) {
          return json({ data: { addProjectV2ItemById: { item: { id: 'IT1' } } } })
        }
        if (body.query.includes('GetProjectId') || body.query.includes('projectV2(number')) {
          return json({
            data: { repositoryOwner: { __typename: 'User', projectV2: { id: 'P1' } } },
          })
        }
        return json({ data: {} })
      }
      if (u.includes('/issues/')) return json({ node_id: 'I_node' })
      return json({})
    }) as unknown as typeof fetch
    // O CONTRATO MUDOU (bloco 4): sem um `fetch` com permissão, mover card no
    // quadro do cliente não é mais "sai com teto de tempo" — é RECUSADO. O
    // default deixou de ser o `fetch` cru e passou a ser `fetchSemPermissao()`,
    // que representa o nível mais restrito.
    //
    // Este teste guardava o comportamento antigo, e por isso foi reescrito em
    // vez de removido: os dois call sites de scheduler.ts que "nunca passavam"
    // fetchImpl agora passam, e o que precisa de guarda aqui é o esquecimento
    // FUTURO — que tem que falhar fechado, não sair calado.
    let recusa: unknown
    try {
      const move = createCardMover({ repository: 'o/r', board: 'o/9', token: 't' })
      await move(42, 'done').catch((e: unknown) => {
        recusa = e
      })
    } finally {
      global.fetch = original
    }

    expect((recusa as Error | undefined)?.name).toBe('EscritaNaoAutorizadaError')

    // E o teto de tempo continua valendo em tudo que chegou a sair: a leitura
    // do quadro acontece antes da escrita e passa normalmente.
    for (const { init } of chamadas) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })

  it('COM um fetch autorizado, o card é movido e o teto continua em cada chamada', async () => {
    // O par do teste acima: prova que a recusa vem da autonomia e não de o
    // caminho ter quebrado.
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    const chamadas: Array<{ init: RequestInit | undefined }> = []
    const fetchAutorizado = (async (u: string, init?: RequestInit) => {
      chamadas.push({ init })
      const body = init?.body ? (JSON.parse(String(init.body)) as { query: string }) : { query: '' }
      if (String(u).includes('/graphql')) {
        // A ORDEM importa: 'UpdateProjectV2SingleSelectField' CONTÉM
        // 'ProjectV2SingleSelectField'. Testar o genérico primeiro faz o ramo
        // de leitura engolir a mutation — e o teste falha por um erro que não
        // existe no código de verdade.
        if (body.query.includes('UpdateProjectV2SingleSelectField')) {
          return json({
            data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } },
          })
        }
        if (body.query.includes('addProjectV2ItemById')) {
          return json({ data: { addProjectV2ItemById: { item: { id: 'IT1' } } } })
        }
        if (body.query.includes('GetProjectId') || body.query.includes('projectV2(number')) {
          return json({
            data: { repositoryOwner: { __typename: 'User', projectV2: { id: 'P1' } } },
          })
        }
        if (body.query.includes('fields(')) {
          return json({
            data: {
              node: {
                fields: {
                  nodes: [{ id: 'F1', name: 'Status', options: [{ id: 'O2', name: 'Done' }] }],
                },
              },
            },
          })
        }
        return json({ data: {} })
      }
      if (String(u).includes('/issues/')) return json({ node_id: 'I_node' })
      return json({})
    }) as unknown as typeof fetch

    const move = createCardMover({
      repository: 'o/r',
      board: 'o/9',
      token: 't',
      fetchImpl: fetchDoRepositorio({ nivel: () => 'cuidar', fetchImpl: fetchAutorizado }),
    })
    await move(42, 'done')

    expect(chamadas.length).toBeGreaterThan(0)
    for (const { init } of chamadas) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })
})
