import { describe, it, expect, vi, afterEach } from 'vitest'
import { createGithubBacklog } from './github-backlog.js'

// A MORDAÇA do `iterations[sprintNumber - 1]`.
//
// Medido em 31/08/2026 no quadro #2 do dono: o campo Sprint tinha UMA iteração
// configurada ("Sprint 1", 30/08, 3 dias). Toda task que o PO planejou para a
// sprint 2 ou adiante caía em `if (!iteration) return` e saía sem ciclo, sem
// erro, sem log — o card ficava no quadro com o campo Sprint vazio e ninguém
// nunca soube por quê.

/** Anota o que foi de fato ESCRITO no GitHub, não que o cliente foi chamado. */
function githubDeMentira(
  iterations: Array<{ id: string; title: string; startDate: string; duration: number }>
) {
  const iteracoesEscritas: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const corpo = typeof init?.body === 'string' ? init.body : ''
    if (!String(url).includes('/graphql')) {
      return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
    }
    if (corpo.includes('GetIterationField')) {
      return new Response(
        JSON.stringify({
          data: {
            node: {
              fields: {
                nodes: [
                  {
                    __typename: 'ProjectV2IterationField',
                    name: 'Sprint',
                    id: 'PVTIF_1',
                    configuration: { iterations },
                  },
                ],
              },
            },
          },
        }),
        { status: 200 }
      )
    }
    if (corpo.includes('SetProjectV2Iteration')) {
      const iterationId = JSON.parse(corpo).variables.iterationId as string
      iteracoesEscritas.push(iterationId)
      return new Response(
        JSON.stringify({
          data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } },
        }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  })
  return { iteracoesEscritas, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const CORRENTE = { id: 'c1434f3d', title: 'Sprint 1', startDate: '2026-08-30', duration: 3 }
const VELHA = { id: 'velha', title: 'Sprint 0', startDate: '2026-08-20', duration: 3 }

afterEach(() => vi.restoreAllMocks())

describe('setSprint além do horizonte de iterações', () => {
  it('sprint 2 com UMA iteração configurada cai na iteração CORRENTE', async () => {
    const { iteracoesEscritas, fetchImpl } = githubDeMentira([CORRENTE])
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl,
      hoje: () => '2026-08-31',
    })

    await backlog.setSprint('PVTI_1', 2)

    expect(iteracoesEscritas).toEqual(['c1434f3d'])
  })

  it('sprint 1 com duas iterações continua usando a primeira', async () => {
    const { iteracoesEscritas, fetchImpl } = githubDeMentira([VELHA, CORRENTE])
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl,
      hoje: () => '2026-08-31',
    })

    await backlog.setSprint('PVTI_1', 1)

    expect(iteracoesEscritas).toEqual(['velha'])
  })

  it('sem ciclo correndo hoje, não escreve E DIZ por que não entrou', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { iteracoesEscritas, fetchImpl } = githubDeMentira([CORRENTE])
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl,
      // Depois do fim da única iteração: 30/08 + 3 dias termina em 02/09.
      hoje: () => '2026-09-05',
    })

    await backlog.setSprint('PVTI_1', 2)

    expect(iteracoesEscritas).toEqual([])
    const dito = aviso.mock.calls.map((c) => String(c[0])).join(' | ')
    expect(dito).toContain('PVTI_1')
    expect(dito).toContain('sprint 2')
    expect(dito).toContain('1 iteração')
  })
})
