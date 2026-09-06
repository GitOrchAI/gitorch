import { describe, it, expect, vi } from 'vitest'
import {
  encerrarDuvidasLegadasAbertasDoProjeto,
  TEXTO_ENCERRAMENTO_DUVIDA_LEGADA,
  type PrismaParaEncerrarDuvidasLegadas,
} from './encerrar-duvidas-legadas-abertas.js'

/**
 * L4-T30 — item 2 do plano. D75 (05/09) fechou o caminho VIVO da dúvida do
 * dev até o dono (`escalar-duvida-ao-dono.ts`), mas isso não fecha as
 * `agent_question` que a reconciliação LEGADA (`reconciliar-duvidas-
 * escaladas.ts`, L4-T3) já tinha criado antes da decisão — com contexto
 * vazio por desenho (D73/L4-T23). Duas chegaram ao dono hoje; uma delas
 * (tarefa #3866 do Jardim, de ontem) segue genuinamente `open`. Este módulo
 * varre as `agent_question` com dedupKey `duvida-dev:*` ainda abertas e as
 * encerra pelo MESMO mecanismo de "assumida" que o produto já usa
 * (`AgentQuestionService.marcarAssumida`) — nunca `answer()`, porque isto
 * não é uma decisão do dono, é o produto puxando a própria dívida para trás
 * de si mesmo, citando D75 no texto.
 */

const PERGUNTA_ABERTA_1 = { id: 'q_3866', dedupKey: 'duvida-dev:GitOrchAI/jardim:3866:hashA' }
const PERGUNTA_ABERTA_2 = { id: 'q_outra', dedupKey: 'duvida-dev:acme/api:12:hashB' }

function prismaFalso(
  overrides: Partial<PrismaParaEncerrarDuvidasLegadas> = {}
): PrismaParaEncerrarDuvidasLegadas {
  return {
    agentQuestion: {
      findMany: vi.fn(async () => [PERGUNTA_ABERTA_1]),
    },
    ...overrides,
  } as PrismaParaEncerrarDuvidasLegadas
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso(),
    marcarAssumida: vi.fn(async () => ({ id: 'q_3866', status: 'assumida' })),
    onWarn: vi.fn(),
    ...overrides,
  }
}

describe('encerrarDuvidasLegadasAbertasDoProjeto', () => {
  it('pergunta legada aberta (dedupKey duvida-dev:*, status open): encerra via marcarAssumida citando D75', async () => {
    const deps = depsFalso()

    const resumo = await encerrarDuvidasLegadasAbertasDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 1, encerradas: 1, falhas: 0 })
    expect(
      (deps.prisma as PrismaParaEncerrarDuvidasLegadas).agentQuestion.findMany
    ).toHaveBeenCalledWith({
      where: { projectId: 'proj1', status: 'open', dedupKey: { startsWith: 'duvida-dev:' } },
    })
    expect(deps.marcarAssumida).toHaveBeenCalledWith({
      questionId: 'q_3866',
      projectId: 'proj1',
      suposicao: TEXTO_ENCERRAMENTO_DUVIDA_LEGADA,
    })
    expect(TEXTO_ENCERRAMENTO_DUVIDA_LEGADA).toContain('D75')
  })

  it('várias perguntas legadas abertas: encerra cada uma', async () => {
    const prisma = prismaFalso({
      agentQuestion: { findMany: vi.fn(async () => [PERGUNTA_ABERTA_1, PERGUNTA_ABERTA_2]) },
    })
    const deps = depsFalso({ prisma })

    const resumo = await encerrarDuvidasLegadasAbertasDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 2, encerradas: 2, falhas: 0 })
    expect(deps.marcarAssumida).toHaveBeenCalledTimes(2)
  })

  it('marcarAssumida lança para uma pergunta: conta falha, segue para a próxima, nunca derruba', async () => {
    const prisma = prismaFalso({
      agentQuestion: { findMany: vi.fn(async () => [PERGUNTA_ABERTA_1, PERGUNTA_ABERTA_2]) },
    })
    const marcarAssumida = vi
      .fn()
      .mockRejectedValueOnce(new Error('rede caiu'))
      .mockResolvedValueOnce({ id: 'q_outra', status: 'assumida' })
    const deps = depsFalso({ prisma, marcarAssumida })

    const resumo = await encerrarDuvidasLegadasAbertasDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 2, encerradas: 1, falhas: 1 })
    expect(deps.onWarn).toHaveBeenCalledTimes(1)
    const [mensagem] = (deps.onWarn as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(mensagem).toContain('q_3866')
  })

  it('nenhuma pergunta legada aberta: zero em tudo, marcarAssumida nunca chamado', async () => {
    const prisma = prismaFalso({ agentQuestion: { findMany: vi.fn(async () => []) } })
    const deps = depsFalso({ prisma })

    const resumo = await encerrarDuvidasLegadasAbertasDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 0, encerradas: 0, falhas: 0 })
    expect(deps.marcarAssumida).not.toHaveBeenCalled()
  })
})
