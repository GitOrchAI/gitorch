import { describe, it, expect, vi } from 'vitest'
import {
  coletarDesejoParaMensagemDeStakeholder,
  coletarTamanhoDoDesejoDaTask,
  type DepsDoColetorPelaTask,
  type IssueMinimaParaAcharWish,
} from './coletor-de-desejo-para-stakeholder.js'
import type { DepsDaArvoreDePedidos } from './arvore-de-pedidos.js'

// D76b (T10) — o coletor REAL: conta fases/épicos/features/tarefas a partir
// da MESMA árvore de issues que o painel já lê (`lerArvoreDoPedido`,
// arvore-de-pedidos.ts — reaproveitada aqui, nunca reimplementada). O fake
// abaixo só substitui o `fetch` na borda de rede — a função que bate na API
// (`lerArvoreDoPedido`) é a mesma que roda em produção, mesmo padrão de
// `arvore-de-pedidos.test.ts`.

function subIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 31,
    title: 'Fase 1',
    state: 'OPEN',
    url: 'https://github.com/GitOrchAI/gitorch/issues/31',
    subIssuesSummary: { total: 0, completed: 0 },
    ...over,
  }
}

function githubFake(porRepo: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body ?? '{}')) as {
      variables?: { owner?: string; name?: string }
    }
    const chave = `${corpo.variables?.owner}/${corpo.variables?.name}`
    const resposta = porRepo[chave]
    if (resposta === undefined) throw new Error('rede caiu')
    return { ok: true, status: 200, json: async () => resposta }
  }) as unknown as typeof fetch
}

function deps(over: Partial<DepsDaArvoreDePedidos> = {}): DepsDaArvoreDePedidos {
  return {
    listarProjetos: async () => [{ nome: 'gitorch', repo: 'GitOrchAI/gitorch' }],
    lerToken: async () => 'token-do-dono',
    ...over,
  }
}

/** fase(31) → 2 épicos(41,42) → épico 41 tem 2 features(51,52), épico 42 tem
 *  1 feature(53) → feature 51 tem 3 tasks, as demais 0. Total esperado:
 *  1 fase, 2 épicos, 3 features, 3 tarefas. */
function arvoreComContagensConhecidas(): Record<string, unknown> {
  return {
    data: {
      repository: {
        issue: {
          subIssues: {
            nodes: [
              subIssue({
                number: 31,
                title: 'Fase 1',
                subIssuesSummary: { total: 2, completed: 0 },
                subIssues: {
                  nodes: [
                    subIssue({
                      number: 41,
                      title: 'Épico 1',
                      subIssuesSummary: { total: 2, completed: 0 },
                      subIssues: {
                        nodes: [
                          subIssue({
                            number: 51,
                            title: 'Feature 1',
                            subIssuesSummary: { total: 3, completed: 1 },
                            subIssues: {
                              nodes: [
                                subIssue({ number: 61, title: 'Task 1' }),
                                subIssue({ number: 62, title: 'Task 2', state: 'CLOSED' }),
                                subIssue({ number: 63, title: 'Task 3' }),
                              ],
                            },
                          }),
                          subIssue({
                            number: 52,
                            title: 'Feature 2',
                            subIssuesSummary: { total: 0, completed: 0 },
                          }),
                        ],
                      },
                    }),
                    subIssue({
                      number: 42,
                      title: 'Épico 2',
                      subIssuesSummary: { total: 1, completed: 0 },
                      subIssues: {
                        nodes: [
                          subIssue({
                            number: 53,
                            title: 'Feature 3',
                            subIssuesSummary: { total: 0, completed: 0 },
                          }),
                        ],
                      },
                    }),
                  ],
                },
              }),
            ],
          },
        },
      },
    },
  }
}

describe('coletarDesejoParaMensagemDeStakeholder — conta de verdade na árvore real', () => {
  it('soma fases/épicos/features/tarefas descendo a árvore inteira (1/2/3/3)', async () => {
    const desejo = await coletarDesejoParaMensagemDeStakeholder(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numero: 30,
        titulo: 'lembrete de pagamento por e-mail',
        prioridade: null,
        sprintsEstimadas: null,
      },
      deps({ fetchImpl: githubFake({ 'GitOrchAI/gitorch': arvoreComContagensConhecidas() }) })
    )

    expect(desejo).toEqual({
      titulo: 'lembrete de pagamento por e-mail',
      prioridade: null,
      fases: 1,
      epicos: 2,
      features: 3,
      tarefas: 3,
      sprintsEstimadas: null,
    })
  })

  it('desejo ainda sem árvore nenhuma (0 sub-issues): tudo 0, nunca lança', async () => {
    const semArvore = {
      data: { repository: { issue: { subIssues: { nodes: [] } } } },
    }
    const desejo = await coletarDesejoParaMensagemDeStakeholder(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numero: 99,
        titulo: 'desejo recém-pedido',
        prioridade: null,
        sprintsEstimadas: null,
      },
      deps({ fetchImpl: githubFake({ 'GitOrchAI/gitorch': semArvore }) })
    )
    expect(desejo).toEqual({
      titulo: 'desejo recém-pedido',
      prioridade: null,
      fases: 0,
      epicos: 0,
      features: 0,
      tarefas: 0,
      sprintsEstimadas: null,
    })
  })

  it('repassa prioridade e sprintsEstimadas exatamente como recebidos (nunca inventa nem descarta)', async () => {
    const desejo = await coletarDesejoParaMensagemDeStakeholder(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numero: 30,
        titulo: 'motor de recomendação',
        prioridade: 0,
        sprintsEstimadas: 10,
      },
      deps({ fetchImpl: githubFake({ 'GitOrchAI/gitorch': arvoreComContagensConhecidas() }) })
    )
    expect(desejo.prioridade).toBe(0)
    expect(desejo.sprintsEstimadas).toBe(10)
  })

  it('reaproveita lerArvoreDoPedido de verdade: erro de rede sobe como ArvoreIndisponivelError, nunca mascarado', async () => {
    await expect(
      coletarDesejoParaMensagemDeStakeholder(
        {
          ownerId: 'u1',
          projeto: 'gitorch',
          numero: 30,
          titulo: 'x',
          prioridade: null,
          sprintsEstimadas: null,
        },
        deps({ fetchImpl: githubFake({}) })
      )
    ).rejects.toThrow(/ARVORE_INDISPONIVEL/)
  })
})

// Achado de QA (T10) — o único chamador de produção pergunta sobre a TASK
// candidata (`CandidatoDeTroca.pedido`), nunca sobre o desejo direto:
// `coletarTamanhoDoDesejoDaTask` é a costura que sobe da task até o desejo
// pai (marker `gitorch:node:<wish>:task:<i>`) antes de contar a árvore.

function issuesFake(porNumero: Record<number, IssueMinimaParaAcharWish>) {
  return vi.fn(async (numero: number): Promise<IssueMinimaParaAcharWish | null> => {
    return porNumero[numero] ?? null
  })
}

function depsPelaTask(
  buscarIssue: DepsDoColetorPelaTask['buscarIssue'],
  over: Partial<DepsDaArvoreDePedidos> = {}
): DepsDoColetorPelaTask {
  return {
    buscarIssue,
    listarProjetos: async () => [{ nome: 'gitorch', repo: 'GitOrchAI/gitorch' }],
    lerToken: async () => 'token-do-dono',
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { repository: { issue: { subIssues: { nodes: [] } } } } }),
    })) as unknown as typeof fetch,
    ...over,
  }
}

describe('coletarTamanhoDoDesejoDaTask — sobe da TASK candidata até o desejo pai', () => {
  it('task com marker gitorch:node:<wish>:task:<i>: acha o desejo pai e conta a árvore dele', async () => {
    const buscarIssue = issuesFake({
      // Task candidata (#102), marcada com o desejo #30 (mesmo formato que
      // backlog-executor.ts grava: `<!-- gitorch:node:<wish>:task:<i> -->`).
      102: { titulo: 'Task perdida na fila', corpo: '<!-- gitorch:node:30:task:2 -->' },
      30: { titulo: 'lembrete de pagamento por e-mail', corpo: null },
    })

    const desejo = await coletarTamanhoDoDesejoDaTask(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numeroDaTask: 102,
        prioridade: null,
        sprintsEstimadas: null,
      },
      depsPelaTask(buscarIssue)
    )

    expect(buscarIssue).toHaveBeenCalledWith(102)
    expect(buscarIssue).toHaveBeenCalledWith(30)
    expect(desejo).toMatchObject({
      titulo: 'lembrete de pagamento por e-mail',
      fases: 0,
      epicos: 0,
      features: 0,
      tarefas: 0,
    })
  })

  it('task SEM marker (não nasceu da árvore do PO): devolve null, nunca inventa um desejo', async () => {
    const buscarIssue = issuesFake({
      102: { titulo: 'Task criada à mão no quadro', corpo: 'sem marker nenhum aqui' },
    })

    const desejo = await coletarTamanhoDoDesejoDaTask(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numeroDaTask: 102,
        prioridade: null,
        sprintsEstimadas: null,
      },
      depsPelaTask(buscarIssue)
    )

    expect(desejo).toBeNull()
  })

  it('task não encontrada (buscarIssue devolve null): devolve null, nunca lança', async () => {
    const buscarIssue = issuesFake({})

    const desejo = await coletarTamanhoDoDesejoDaTask(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numeroDaTask: 102,
        prioridade: null,
        sprintsEstimadas: null,
      },
      depsPelaTask(buscarIssue)
    )

    expect(desejo).toBeNull()
  })

  it('desejo pai não encontrado (issue apagada/renumerada): devolve null, nunca lança', async () => {
    const buscarIssue = issuesFake({
      102: { titulo: 'Task perdida na fila', corpo: '<!-- gitorch:node:30:task:2 -->' },
      // 30 ausente do fake -> issuesFake devolve null.
    })

    const desejo = await coletarTamanhoDoDesejoDaTask(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numeroDaTask: 102,
        prioridade: null,
        sprintsEstimadas: null,
      },
      depsPelaTask(buscarIssue)
    )

    expect(desejo).toBeNull()
  })

  it('repassa prioridade/sprintsEstimadas para o coletor de verdade, sem inventar nada', async () => {
    const buscarIssue = issuesFake({
      102: { titulo: 'Task perdida na fila', corpo: '<!-- gitorch:node:30:task:2 -->' },
      30: { titulo: 'motor de recomendação', corpo: null },
    })

    const desejo = await coletarTamanhoDoDesejoDaTask(
      {
        ownerId: 'u1',
        projeto: 'gitorch',
        numeroDaTask: 102,
        prioridade: 0,
        sprintsEstimadas: 10,
      },
      depsPelaTask(buscarIssue)
    )

    expect(desejo?.prioridade).toBe(0)
    expect(desejo?.sprintsEstimadas).toBe(10)
  })
})
