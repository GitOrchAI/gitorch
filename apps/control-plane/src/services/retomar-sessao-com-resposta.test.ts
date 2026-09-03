import { describe, it, expect, vi } from 'vitest'
import { aoResponderDuvidaDoDev, type PrismaParaRetomada } from './retomar-sessao-com-resposta.js'

/**
 * L4-T3 (item 3): a resposta do DONO a uma dúvida escalada (agent_question
 * dedupKey `duvida-dev:<repo>:<issue>:<hash>`) precisa RETOMAR a sessão do
 * dev assíncrono — sem isto, a marca `escalada:` (item 1) fica presa para
 * sempre, porque nada nunca a transforma em resposta de verdade.
 */

const SESSAO = {
  sessionName: 'sessions/1',
  issueNumber: 46,
  answeredHash: 'escalada:0:hash123',
  devAccountId: null,
}

function prismaFalso(overrides: Partial<PrismaParaRetomada> = {}): PrismaParaRetomada {
  return {
    project: {
      findFirst: vi.fn(async () => ({ id: 'proj1', encryptedDevApiKey: null })),
    },
    devSession: {
      findFirst: vi.fn(async () => SESSAO),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      update: vi.fn(async () => undefined),
    },
    ...overrides,
  } as PrismaParaRetomada
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso(),
    decifrar: (envelope: string) => envelope.replace('cifrado:', ''),
    julesApiKeyDaInstancia: 'chave-da-instancia',
    responderSessaoJules: vi.fn(async () => true),
    onWarn: vi.fn(),
    ...overrides,
  }
}

const ARGS_BASE = {
  dedupKey: 'duvida-dev:acme/api:46:hash123',
  resposta: 'sim',
  opcoes: [
    { label: 'Sim, pode cobrar', value: 'sim' },
    { label: 'Não', value: 'nao' },
  ],
}

describe('aoResponderDuvidaDoDev', () => {
  it('dedupKey de outro tipo (ex.: automacao:) NUNCA aciona nada', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(
      { dedupKey: 'automacao:acme/api:workflow-x', resposta: 'deletar', opcoes: [] },
      deps as never
    )

    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
    expect((deps.prisma as PrismaParaRetomada).devSession.findFirst).not.toHaveBeenCalled()
  })

  it('dedupKey mal formado (sem hash) NUNCA aciona nada', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(
      { dedupKey: 'duvida-dev:acme/api:naoenumero:hash', resposta: 'sim', opcoes: [] },
      deps as never
    )

    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
  })

  it('sucesso: retoma a sessão com a LABEL da opção escolhida + "Decisão do dono." e marca respondida', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    expect(deps.responderSessaoJules).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'sessions/1',
        texto: expect.stringContaining('Sim, pode cobrar'),
      })
    )
    const chamada = (deps.responderSessaoJules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      texto: string
    }
    expect(chamada.texto).toContain('Decisão do dono.')
    expect((deps.prisma as PrismaParaRetomada).devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/1' },
        data: expect.objectContaining({ answeredHash: 'respondida:0:hash123' }),
      })
    )
  })

  it('resposta livre (valor não bate com nenhuma opção): usa o texto cru da resposta', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(
      { ...ARGS_BASE, resposta: 'só até dezembro, depois revisamos' },
      deps as never
    )

    expect(deps.responderSessaoJules).toHaveBeenCalledWith(
      expect.objectContaining({ texto: expect.stringContaining('só até dezembro') })
    )
  })

  it('ORDEM: a entrega ao dev acontece ANTES de marcar respondida (nunca finge sucesso)', async () => {
    const ordem: string[] = []
    const deps = depsFalso({
      responderSessaoJules: vi.fn(async () => {
        ordem.push('entregou')
        return true
      }),
    })
    ;(deps.prisma as PrismaParaRetomada).devSession.update = vi.fn(async () => {
      ordem.push('marcou-respondida')
    })

    await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    expect(ordem).toEqual(['entregou', 'marcou-respondida'])
  })

  it('falha ao entregar (responderSessaoJules devolve false): LANÇA — a pergunta continua open', async () => {
    const deps = depsFalso({ responderSessaoJules: vi.fn(async () => false) })

    await expect(aoResponderDuvidaDoDev(ARGS_BASE, deps as never)).rejects.toThrow()
    expect((deps.prisma as PrismaParaRetomada).devSession.update).not.toHaveBeenCalled()
  })

  it('nenhuma dev_session AWAITING encontrada: LANÇA — nunca finge sucesso', async () => {
    const prisma = prismaFalso({ devSession: { findFirst: vi.fn(async () => null) } as never })
    const deps = depsFalso({ prisma })

    await expect(aoResponderDuvidaDoDev(ARGS_BASE, deps as never)).rejects.toThrow()
  })

  it('projeto do repositório não encontrado: LANÇA', async () => {
    const prisma = prismaFalso({ project: { findFirst: vi.fn(async () => null) } as never })
    const deps = depsFalso({ prisma })

    await expect(aoResponderDuvidaDoDev(ARGS_BASE, deps as never)).rejects.toThrow()
  })

  it('sem sessão com o hash exato: cai para a mais recente AWAITING_USER_FEEDBACK da issue', async () => {
    const findFirst = vi
      .fn()
      // 1ª chamada: busca pelo hash exato — não acha.
      .mockResolvedValueOnce(null)
      // 2ª chamada: fallback pela mais recente da issue — acha.
      .mockResolvedValueOnce({ ...SESSAO, answeredHash: 'escalada:0:outro-hash' })
    const prisma = prismaFalso({
      devSession: { findFirst, update: vi.fn(async () => undefined) } as never,
    })
    const deps = depsFalso({ prisma })

    await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    expect(findFirst).toHaveBeenCalledTimes(2)
    expect(deps.responderSessaoJules).toHaveBeenCalled()
  })

  /**
   * C1 (fix-up L4-T3): sem o hash exato, a busca reserva pegava a sessão
   * AWAITING_USER_FEEDBACK MAIS RECENTE da issue — mesmo se ela nunca tivesse
   * sido escalada (ex.: uma pergunta comum do dev, ainda esperando o QA
   * responder). Com DUAS sessões AWAITING na mesma issue, a resposta do dono
   * podia ir parar na sessão ERRADA. A regra nova: a busca reserva só aceita
   * sessão com `answeredHash` começando por `escalada:` — nunca adivinha.
   */
  it('duas sessões AWAITING na mesma issue (uma escalada, outra não): só escolhe a ESCALADA — nunca adivinha', async () => {
    const sessaoNaoEscalada = {
      ...SESSAO,
      sessionName: 'sessions/nao-escalada',
      answeredHash: 'tentando:1:outra-pergunta-qualquer',
    }
    const sessaoEscalada = {
      ...SESSAO,
      sessionName: 'sessions/escalada',
      answeredHash: 'escalada:0:outro-hash',
    }
    const findFirst = vi.fn(
      async (args: { where: { answeredHash?: string | { startsWith?: string } } }) => {
        const filtro = args.where.answeredHash
        if (typeof filtro === 'string') {
          return [sessaoNaoEscalada, sessaoEscalada].find((s) => s.answeredHash === filtro) ?? null
        }
        if (filtro && typeof filtro === 'object' && filtro.startsWith === 'escalada:') {
          return (
            [sessaoNaoEscalada, sessaoEscalada].find((s) =>
              s.answeredHash.startsWith('escalada:')
            ) ?? null
          )
        }
        // Busca reserva sem filtro por marca (comportamento antigo) NÃO pode
        // mais acontecer — devolver a não-escalada aqui provaria o defeito.
        return sessaoNaoEscalada
      }
    )
    const prisma = prismaFalso({
      devSession: { findFirst, update: vi.fn(async () => undefined) } as never,
    })
    const deps = depsFalso({ prisma })

    await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    expect(deps.responderSessaoJules).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/escalada' })
    )
  })

  it('nenhuma sessão ESCALADA (só existe uma AWAITING comum): LANÇA erro claro — a pergunta continua open, nunca adivinha', async () => {
    const sessaoNaoEscalada = {
      ...SESSAO,
      sessionName: 'sessions/nao-escalada',
      answeredHash: 'tentando:1:outra-pergunta-qualquer',
    }
    const findFirst = vi.fn(
      async (args: { where: { answeredHash?: string | { startsWith?: string } } }) => {
        const filtro = args.where.answeredHash
        if (typeof filtro === 'string') return null
        if (filtro && typeof filtro === 'object' && filtro.startsWith === 'escalada:') return null
        return sessaoNaoEscalada
      }
    )
    const prisma = prismaFalso({
      devSession: { findFirst, update: vi.fn(async () => undefined) } as never,
    })
    const deps = depsFalso({ prisma })

    await expect(aoResponderDuvidaDoDev(ARGS_BASE, deps as never)).rejects.toThrow(
      /sessão escalada não encontrada para acme\/api#46/
    )
    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
    expect((deps.prisma as PrismaParaRetomada).devSession.update).not.toHaveBeenCalled()
  })
})
