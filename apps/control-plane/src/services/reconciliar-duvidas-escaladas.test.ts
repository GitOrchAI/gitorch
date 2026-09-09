import { describe, it, expect, vi } from 'vitest'
import {
  reconciliarDuvidasEscaladasDoProjeto,
  type PrismaParaReconciliacao,
} from './reconciliar-duvidas-escaladas.js'
import { marcarRespondida, marcarEscalada } from './pergunta-sem-resposta.js'

/**
 * L4-T3, item 4: as 24 sessões medidas em 02/09 — marcadas "respondida" ao
 * escalar, ZERO `agent_question` real — ficam presas para sempre se nada
 * migrar a marca. `reconciliarDuvidasEscaladasDoProjeto` varre UMA VEZ (por
 * projeto) as sessões AWAITING_USER_FEEDBACK com esse padrão exato — ainda
 * presas na Jules (state não avançou) E marcadas `respondida:` sem a
 * `agent_question` correspondente — e cria a pergunta de verdade que devia
 * ter existido desde o início.
 */

const SESSAO_LEGADA = {
  sessionName: 'sessions/legada',
  issueNumber: 46,
  answeredHash: marcarRespondida('hash123'),
  devAccountId: null,
}

function prismaFalso(overrides: Partial<PrismaParaReconciliacao> = {}): PrismaParaReconciliacao {
  return {
    devSession: {
      findMany: vi.fn(async () => [SESSAO_LEGADA]),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      update: vi.fn(async () => undefined),
    },
    agentQuestion: {
      findFirst: vi.fn(async () => null),
    },
    project: {
      findUnique: vi.fn(async () => ({ encryptedDevApiKey: null })),
      findFirst: vi.fn(async () => null),
    },
    ...overrides,
  } as PrismaParaReconciliacao
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso(),
    agentQuestionService: {
      ask: vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } as never })),
    },
    decifrar: (e: string) => e.replace('cifrado:', ''),
    julesApiKeyDaInstancia: 'chave-da-instancia',
    ultimaMensagemDoDevJules: vi.fn(async () => 'Should I use bcrypt or argon2?'),
    onWarn: vi.fn(),
    ...overrides,
  }
}

const ARGS = { projectId: 'proj1', repository: 'acme/api', userId: 'user1' }

describe('reconciliarDuvidasEscaladasDoProjeto', () => {
  it('sessão legada (respondida sem agent_question): cria a pergunta de verdade e migra a marca', async () => {
    const deps = depsFalso()

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 1, criadas: 1, falhas: 0 })
    expect(deps.agentQuestionService.ask).toHaveBeenCalledWith(
      'user1',
      'proj1',
      expect.objectContaining({ dedupKey: 'duvida-dev:acme/api:46:hash123' })
    )
    expect((deps.prisma as PrismaParaReconciliacao).devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/legada' },
        data: expect.objectContaining({ answeredHash: 'escalada:0:hash123' }),
      })
    )
  })

  // D72 (02/09) — SUBSTITUI o teste antigo, que esperava a pergunta CRUA do
  // dev embutida no texto. A reconciliação agora usa a MESMA pergunta
  // executiva de reserva (3 opções), NUNCA a mensagem do dev — mesmo quando
  // ela está disponível.
  it('D72: NUNCA embute a última mensagem do dev — sempre a pergunta executiva de reserva com 3 opções', async () => {
    const deps = depsFalso()

    await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    const chamada = (
      deps.agentQuestionService.ask.mock.calls[0] as unknown as [
        string,
        string,
        { text: string; options: Array<{ label: string; value: string }> },
      ]
    )[2]
    expect(chamada.text).not.toContain('Should I use bcrypt or argon2?')
    expect(chamada.text).toContain('tarefa #46 de acme/api')
    expect(chamada.options).toHaveLength(4)
    expect(chamada.options.slice(0, 3).map((o) => o.label)).toEqual([
      'Pausar esta tarefa até eu decidir com calma',
      'Seguir com a melhor decisão da equipe por agora',
      'Entregar o que já está pronto para revisão',
    ])
  })

  it('sem conseguir ler a última mensagem: usa o texto genérico de reserva (nunca falha por isso)', async () => {
    const deps = depsFalso({
      ultimaMensagemDoDevJules: vi.fn(async () => {
        throw new Error('Jules API fora do ar')
      }),
    })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo.criadas).toBe(1)
    const chamada = (
      deps.agentQuestionService.ask.mock.calls[0] as unknown as [string, string, { text: string }]
    )[2]
    expect(chamada.text).toContain('tarefa #46 de acme/api')
  })

  it('já marcada escalada: NÃO reprocessa (idempotente)', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [
          { ...SESSAO_LEGADA, answeredHash: marcarEscalada('hash123') },
        ]),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async () => undefined),
      } as never,
    })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 0, criadas: 0, falhas: 0 })
    expect(deps.agentQuestionService.ask).not.toHaveBeenCalled()
  })

  it('marca não é "respondida" (ex.: "tentando" ou "desisti"): não é o padrão do defeito, ignora', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [{ ...SESSAO_LEGADA, answeredHash: 'tentando:1:hash123' }]),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async () => undefined),
      } as never,
    })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 0, criadas: 0, falhas: 0 })
  })

  it('agent_question já existe para o dedupKey (idempotência entre boots): só migra a marca, não pergunta de novo', async () => {
    const prisma = prismaFalso({
      agentQuestion: { findFirst: vi.fn(async () => ({ id: 'q_existente' })) },
    })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(deps.agentQuestionService.ask).not.toHaveBeenCalled()
    expect((deps.prisma as PrismaParaReconciliacao).devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ answeredHash: 'escalada:0:hash123' }),
      })
    )
    expect(resumo).toEqual({ presas: 1, criadas: 0, falhas: 0 })
  })

  it('sem agentQuestionService ou sem userId: conta falha, nunca lança (o tique não pode cair por causa disto)', async () => {
    const deps = depsFalso({ agentQuestionService: undefined })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 1, criadas: 0, falhas: 1 })
  })

  /**
   * C3 (fix-up L4-T3): a falha do `ask()` já era contada como falha e a
   * marca já ficava inalterada — mas ia só para `onWarn`, sem nível `error`
   * nem repo/issue explícitos. Sem isso a MESMA sessão é reprocessada a
   * cada 6h em silêncio (warn se perde em qualquer monitoramento real).
   */
  it('C3: ask() lança: falhas=1, onError chamado com repo/issue (nunca engole), marca INALTERADA', async () => {
    const erro = new Error('rede caiu')
    const onError = vi.fn()
    const deps = depsFalso({
      agentQuestionService: { ask: vi.fn(async () => Promise.reject(erro)) },
      onError,
    })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 1, criadas: 0, falhas: 1 })
    expect(onError).toHaveBeenCalledTimes(1)
    const [errArg, mensagem] = onError.mock.calls[0] as [unknown, string]
    expect(errArg).toBe(erro)
    expect(mensagem).toContain('acme/api#46')
    expect((deps.prisma as PrismaParaReconciliacao).devSession.update).not.toHaveBeenCalled()
  })

  it('ask() lança: conta falha, segue para a próxima sessão, nunca derruba a reconciliação', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [
          SESSAO_LEGADA,
          {
            ...SESSAO_LEGADA,
            sessionName: 'sessions/legada-2',
            issueNumber: 47,
            answeredHash: marcarRespondida('hash456'),
          },
        ]),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async () => undefined),
      } as never,
    })
    const ask = vi
      .fn()
      .mockRejectedValueOnce(new Error('falhou'))
      .mockResolvedValueOnce({ deduped: false, question: { id: 'q2', answer: null } })
    const deps = depsFalso({ prisma, agentQuestionService: { ask } })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 2, criadas: 1, falhas: 1 })
  })

  it('nenhuma sessão presa: zero em tudo, nenhuma chamada de rede', async () => {
    const prisma = prismaFalso({ devSession: { findMany: vi.fn(async () => []) } as never })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps as never)

    expect(resumo).toEqual({ presas: 0, criadas: 0, falhas: 0 })
    expect(deps.ultimaMensagemDoDevJules).not.toHaveBeenCalled()
  })
})
