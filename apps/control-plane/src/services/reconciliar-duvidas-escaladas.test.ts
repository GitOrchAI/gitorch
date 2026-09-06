import { describe, it, expect, vi } from 'vitest'
import {
  reconciliarDuvidasEscaladasDoProjeto,
  type PrismaParaReconciliacao,
  type DepsDeReconciliacao,
} from './reconciliar-duvidas-escaladas.js'
import { marcarRespondida, marcarEscalada } from './pergunta-sem-resposta.js'

/**
 * L4-T30 — REESCRITA COMPLETA pós-D75 (05/09, decisão do dono).
 *
 * ATÉ L5-T5 esta função criava uma `agent_question` DE VERDADE
 * (`agentQuestionService.ask`) para migrar as 24 sessões presas medidas em
 * 02/09 (L4-T3) — mas D75 fechou de vez o caminho da dúvida do dev até o
 * dono, e este caminho LEGADO continuava criando pergunta com contexto
 * VAZIO (D73/L4-T23) a cada tique, para todo projeto ativo — foi ele que
 * mandou as duas perguntas vazias de 05/09.
 *
 * A reescrita muda o contrato por completo: `DepsDeReconciliacao` não tem
 * MAIS NENHUM jeito de tocar `agentQuestion` — nem no tipo do Prisma
 * injetado, nem em nenhuma dependência — é uma GARANTIA ESTRUTURAL (o
 * TypeScript não deixaria compilar um `deps.agentQuestionService.ask(...)`
 * aqui mesmo que alguém tentasse). A sessão presa (mesma assinatura exata:
 * AWAITING_USER_FEEDBACK, marcada `respondida:` sem pergunta real por trás)
 * é ENCERRADA diretamente (`fecharSessao`, motivo `pergunta-sem-resposta` —
 * o MESMO motivo redelegante que `session-watch.ts` já usa para "a resposta
 * não destravou", devolvendo a issue à fila em vez de perdê-la) — nunca
 * mais um caminho que fala com o dono.
 */

const SESSAO_LEGADA = {
  sessionName: 'sessions/legada',
  issueNumber: 46,
  answeredHash: marcarRespondida('hash123'),
}

function prismaFalso(overrides: Partial<PrismaParaReconciliacao> = {}): PrismaParaReconciliacao {
  return {
    devSession: {
      findMany: vi.fn(async () => [SESSAO_LEGADA]),
    },
    ...overrides,
  } as PrismaParaReconciliacao
}

function depsFalso(overrides: Partial<DepsDeReconciliacao> = {}): DepsDeReconciliacao {
  return {
    prisma: prismaFalso(),
    fecharSessao: vi.fn(async () => undefined),
    onWarn: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as DepsDeReconciliacao
}

const ARGS = { projectId: 'proj1', repository: 'acme/api' }

describe('reconciliarDuvidasEscaladasDoProjeto', () => {
  it('sessão legada (respondida sem pergunta real): encerra a sessão direto, nunca cria pergunta', async () => {
    const deps = depsFalso()

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 1, encerradas: 1, falhas: 0 })
    expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/legada' })
    )
  })

  it('garantia estrutural: DepsDeReconciliacao não tem NENHUM campo agentQuestionService', () => {
    const deps = depsFalso()
    expect('agentQuestionService' in deps).toBe(false)
  })

  it('marca "escalada:" (já passou pelo caminho vivo, D75): não é a assinatura do defeito, ignora', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [
          { ...SESSAO_LEGADA, answeredHash: marcarEscalada('hash123') },
        ]),
      },
    })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 0, encerradas: 0, falhas: 0 })
    expect(deps.fecharSessao).not.toHaveBeenCalled()
  })

  it('marca não é "respondida" (ex.: "tentando" ou "desisti"): não é o padrão do defeito, ignora', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [{ ...SESSAO_LEGADA, answeredHash: 'tentando:1:hash123' }]),
      },
    })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 0, encerradas: 0, falhas: 0 })
    expect(deps.fecharSessao).not.toHaveBeenCalled()
  })

  it('fecharSessao lança: falhas=1, onError chamado com repo/issue (nunca engole)', async () => {
    const erro = new Error('rede caiu')
    const onError = vi.fn()
    const deps = depsFalso({ fecharSessao: vi.fn(async () => Promise.reject(erro)), onError })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 1, encerradas: 0, falhas: 1 })
    expect(onError).toHaveBeenCalledTimes(1)
    const [errArg, mensagem] = onError.mock.calls[0] as [unknown, string]
    expect(errArg).toBe(erro)
    expect(mensagem).toContain('acme/api#46')
  })

  it('fecharSessao lança para uma sessão: conta falha, segue para a próxima, nunca derruba a reconciliação', async () => {
    const prisma = prismaFalso({
      devSession: {
        findMany: vi.fn(async () => [
          SESSAO_LEGADA,
          {
            sessionName: 'sessions/legada-2',
            issueNumber: 47,
            answeredHash: marcarRespondida('hash456'),
          },
        ]),
      },
    })
    const fecharSessao = vi
      .fn()
      .mockRejectedValueOnce(new Error('falhou'))
      .mockResolvedValueOnce(undefined)
    const deps = depsFalso({ prisma, fecharSessao })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 2, encerradas: 1, falhas: 1 })
  })

  it('nenhuma sessão presa: zero em tudo, fecharSessao nunca chamado', async () => {
    const prisma = prismaFalso({ devSession: { findMany: vi.fn(async () => []) } })
    const deps = depsFalso({ prisma })

    const resumo = await reconciliarDuvidasEscaladasDoProjeto(ARGS, deps)

    expect(resumo).toEqual({ encontradas: 0, encerradas: 0, falhas: 0 })
    expect(deps.fecharSessao).not.toHaveBeenCalled()
  })
})
