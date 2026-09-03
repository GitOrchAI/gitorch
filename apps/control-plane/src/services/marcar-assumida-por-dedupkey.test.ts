import { describe, expect, it, vi } from 'vitest'
import { marcarAssumidaPorDedupKey } from './marcar-assumida-por-dedupkey.js'
import type { AgentQuestionRecord } from './agent-question.js'

// C2 (fix-up 3, task a13a42f8-2953-4259-b41f-3f8cddb304cd).
//
// CAUSA RAIZ que este arquivo prova fechada: o `findFirst` que resolvia
// `(projectId, dedupKey)` para um `questionId`, dentro de `scheduler.ts`,
// não filtrava `status` nem ordenava — com duas `agent_question` do MESMO
// dedupKey (uma escalada + uma reconciliação por cima), a linha escolhida
// era INDETERMINADA. E o retorno de `marcarAssumida` nunca era checado: um
// `null` (pergunta sumiu na corrida) virava sucesso silencioso.

function questao(overrides: Partial<AgentQuestionRecord> = {}): AgentQuestionRecord {
  return {
    id: 'q_1',
    projectId: 'p1',
    userId: 'u1',
    text: 'x',
    context: null,
    options: [],
    dedupKey: 'duvida-dev:acme/api:93:hash',
    status: 'open',
    answer: null,
    answeredAt: null,
    answeredVia: null,
    telegramMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('marcarAssumidaPorDedupKey (C2, fix-up 3)', () => {
  it('acha a pergunta ABERTA mais recente para (projectId, dedupKey) — nunca uma indeterminada', async () => {
    const findFirst = vi.fn(async (args: unknown) => {
      // Prova que o filtro e a ordenação corretos foram pedidos ao Prisma —
      // é o próprio banco quem escolhe a mais recente, não este código.
      expect(args).toEqual({
        where: { projectId: 'p1', dedupKey: 'duvida-dev:acme/api:93:hash', status: 'open' },
        orderBy: { createdAt: 'desc' },
      })
      return { id: 'q_mais_recente' }
    })
    const marcarAssumida = vi.fn(async () => questao({ id: 'q_mais_recente' }))

    await marcarAssumidaPorDedupKey(
      { projectId: 'p1', dedupKey: 'duvida-dev:acme/api:93:hash', suposicao: 'suposição real' },
      { prisma: { agentQuestion: { findFirst } }, marcarAssumida }
    )

    expect(marcarAssumida).toHaveBeenCalledWith({
      questionId: 'q_mais_recente',
      projectId: 'p1',
      suposicao: 'suposição real',
    })
  })

  // S1 (fix-up 4, CSO): o `projectId` do PRÓPRIO chamador — nunca um valor
  // adivinhado — tem que chegar a `marcarAssumida`, para o serviço poder
  // confirmar que a pergunta encontrada de fato pertence a este projeto
  // (defesa em profundidade: mesmo que o `findFirst` acima já filtre por
  // `projectId`, `marcarAssumida` confere de novo antes de gravar).
  it('S1: propaga o projectId do chamador para marcarAssumida (nunca um projeto diferente)', async () => {
    const findFirst = vi.fn(async () => ({ id: 'q_1' }))
    const marcarAssumida = vi.fn(async () => questao({ id: 'q_1', projectId: 'p_outro_dono' }))

    await marcarAssumidaPorDedupKey(
      { projectId: 'p_outro_dono', dedupKey: 'duvida-dev:acme/api:93:hash', suposicao: 'x' },
      { prisma: { agentQuestion: { findFirst } }, marcarAssumida }
    )

    expect(marcarAssumida).toHaveBeenCalledWith({
      questionId: 'q_1',
      projectId: 'p_outro_dono',
      suposicao: 'x',
    })
  })

  it('nenhuma pergunta ABERTA para o dedupKey: lança (nunca silêncio)', async () => {
    const findFirst = vi.fn(async () => null)
    const marcarAssumida = vi.fn()

    await expect(
      marcarAssumidaPorDedupKey(
        { projectId: 'p1', dedupKey: 'duvida-dev:acme/api:93:hash', suposicao: 'x' },
        { prisma: { agentQuestion: { findFirst } }, marcarAssumida }
      )
    ).rejects.toThrow('pergunta não encontrada para dedupKey duvida-dev:acme/api:93:hash')

    expect(marcarAssumida).not.toHaveBeenCalled()
  })

  it('marcarAssumida devolve null (corrida rara): lança em vez de fingir sucesso', async () => {
    const findFirst = vi.fn(async () => ({ id: 'q_sumiu' }))
    const marcarAssumida = vi.fn(async () => null)

    await expect(
      marcarAssumidaPorDedupKey(
        { projectId: 'p1', dedupKey: 'duvida-dev:acme/api:93:hash', suposicao: 'x' },
        { prisma: { agentQuestion: { findFirst } }, marcarAssumida }
      )
    ).rejects.toThrow('pergunta não encontrada para dedupKey duvida-dev:acme/api:93:hash')
  })

  it('caminho feliz: marca e não lança', async () => {
    const findFirst = vi.fn(async () => ({ id: 'q_1' }))
    const marcarAssumida = vi.fn(async () => questao())

    await expect(
      marcarAssumidaPorDedupKey(
        { projectId: 'p1', dedupKey: 'duvida-dev:acme/api:93:hash', suposicao: 'x' },
        { prisma: { agentQuestion: { findFirst } }, marcarAssumida }
      )
    ).resolves.toBeUndefined()
  })
})
