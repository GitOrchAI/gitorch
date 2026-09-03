import { describe, it, expect, vi } from 'vitest'
import { aoResponderDuvidaDoDev, type PrismaParaRetomada } from './retomar-sessao-com-resposta.js'

/**
 * L4-T3 (item 3): a resposta do DONO a uma dúvida escalada (agent_question
 * dedupKey `duvida-dev:<repo>:<issue>:<hash>`) precisa RETOMAR a sessão do
 * dev assíncrono — sem isto, a marca `escalada:` (item 1) fica presa para
 * sempre, porque nada nunca a transforma em resposta de verdade.
 *
 * S1 (fix-up 2, CSO — CRÍTICO, cross-tenant): `wingId` (nome do repositório)
 * NÃO é único globalmente — o schema só garante `@@unique([userId, wingId])`
 * — então dois donos podem cadastrar o MESMO `acme/api`. Resolver o projeto
 * por `wingId` (como o código fazia antes deste fix-up) podia entregar a
 * resposta de UM dono à sessão do dev do OUTRO. A partir de agora, `projectId`
 * (e `userId`) vêm DIRETO da `agent_question` (via `ManipuladorDeRespostaArgs`,
 * agent-question.ts) — nunca adivinhados por nome — e TODAS as queries usam
 * `projectId`. O `repo` do dedupKey só CONFERE contra o `wingId` do projeto
 * da pergunta (diverge → erro claro, pergunta continua open).
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
      findUnique: vi.fn(async () => ({ id: 'proj1', wingId: 'acme/api' })),
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
  projectId: 'proj1',
  userId: 'user1',
  opcoes: [
    { label: 'Sim, pode cobrar', value: 'sim' },
    { label: 'Não', value: 'nao' },
  ],
}

describe('aoResponderDuvidaDoDev', () => {
  it('dedupKey de outro tipo (ex.: automacao:) NUNCA aciona nada', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(
      {
        dedupKey: 'automacao:acme/api:workflow-x',
        resposta: 'deletar',
        projectId: 'proj1',
        userId: 'user1',
        opcoes: [],
      },
      deps as never
    )

    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
    expect((deps.prisma as PrismaParaRetomada).devSession.findFirst).not.toHaveBeenCalled()
  })

  it('dedupKey mal formado (sem hash) NUNCA aciona nada', async () => {
    const deps = depsFalso()

    await aoResponderDuvidaDoDev(
      {
        dedupKey: 'duvida-dev:acme/api:naoenumero:hash',
        resposta: 'sim',
        projectId: 'proj1',
        userId: 'user1',
        opcoes: [],
      },
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

  it('projeto da pergunta (por projectId) não encontrado: LANÇA', async () => {
    const prisma = prismaFalso({ project: { findUnique: vi.fn(async () => null) } as never })
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

  // ---------------------------------------------------------------------
  // S1 (fix-up 2, CSO — CRÍTICO, cross-tenant)
  // ---------------------------------------------------------------------

  it('S1: nunca resolve o projeto pelo wingId — usa o projectId da PERGUNTA em todas as queries de dev_session', async () => {
    const findUniqueProject = vi.fn(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      wingId: 'acme/api',
    }))
    const findFirstDevSession = vi.fn(async (args: { where: { projectId: string } }) => {
      expect(args.where.projectId).toBe('proj1')
      return SESSAO
    })
    const prisma = prismaFalso({
      project: { findUnique: findUniqueProject } as never,
      devSession: { findFirst: findFirstDevSession, update: vi.fn(async () => undefined) } as never,
    })
    const deps = depsFalso({ prisma })

    await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    // Resolve o projeto por ID (nunca por wingId/nome do repositório).
    expect(findUniqueProject).toHaveBeenCalledWith({ where: { id: 'proj1' } })
    expect(deps.responderSessaoJules).toHaveBeenCalled()
  })

  it('S1: dois projetos com o MESMO wingId (donos diferentes), sessões AWAITING escaladas nos dois — a resposta vai SÓ para o projeto da PERGUNTA (projectId), nunca por nome do repo', async () => {
    const sessaoDoDonoCerto = { ...SESSAO, sessionName: 'sessions/dono-certo' }
    const sessaoDoDonoErrado = { ...SESSAO, sessionName: 'sessions/dono-errado' }

    // Os DOIS projetos declaram o MESMO wingId — é exatamente a colisão que
    // `@@unique([userId, wingId])` permite (dois donos, mesmo repositório).
    const findUniqueProject = vi.fn(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      wingId: 'acme/api',
    }))
    const findFirstDevSession = vi.fn(
      async (args: {
        where: { projectId: string; answeredHash?: string | { startsWith?: string } }
      }) => {
        const doDono = args.where.projectId === 'proj1' ? sessaoDoDonoCerto : sessaoDoDonoErrado
        const filtro = args.where.answeredHash
        if (typeof filtro === 'string') return filtro === doDono.answeredHash ? doDono : null
        return doDono
      }
    )
    const prisma = prismaFalso({
      project: { findUnique: findUniqueProject } as never,
      devSession: { findFirst: findFirstDevSession, update: vi.fn(async () => undefined) } as never,
    })
    const deps = depsFalso({ prisma })

    // A pergunta é do dono do projeto 'proj1' (agent-question.ts já resolveu
    // isso corretamente ao criar a pergunta — `projectId` é fonte de verdade).
    await aoResponderDuvidaDoDev({ ...ARGS_BASE, projectId: 'proj1' }, deps as never)

    expect(deps.responderSessaoJules).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/dono-certo' })
    )
  })

  it('S1: repo do dedupKey diverge do wingId do projeto DA PERGUNTA: LANÇA erro claro, nunca entrega — a pergunta continua open', async () => {
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => ({ id: 'proj1', wingId: 'outra-org/outro-repo' })),
      } as never,
    })
    const deps = depsFalso({ prisma })

    await expect(aoResponderDuvidaDoDev(ARGS_BASE, deps as never)).rejects.toThrow(/diverge/)
    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
    expect((deps.prisma as PrismaParaRetomada).devSession.update).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // S2 (fix-up 2, CSO — ALTO): teto de 2000 caracteres na resposta do dono
  // ---------------------------------------------------------------------

  it('S2: resposta livre do dono maior que 2000 caracteres é truncada com sufixo antes de ir ao dev, e loga warn', async () => {
    const respostaGigante = 'x'.repeat(5000)
    const deps = depsFalso()

    await aoResponderDuvidaDoDev({ ...ARGS_BASE, resposta: respostaGigante }, deps as never)

    const chamada = (deps.responderSessaoJules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      texto: string
    }
    const [conteudo] = chamada.texto.split('\n\nDecisão do dono.')
    expect(conteudo!.length).toBeLessThanOrEqual(2000)
    expect(conteudo!.endsWith('[… resposta truncada]')).toBe(true)
    expect(deps.onWarn).toHaveBeenCalled()
  })

  it('S2: resposta com exatamente 2000 caracteres passa intacta, sem truncar nem avisar', async () => {
    const respostaNoTeto = 'y'.repeat(2000)
    const deps = depsFalso()

    await aoResponderDuvidaDoDev({ ...ARGS_BASE, resposta: respostaNoTeto }, deps as never)

    const chamada = (deps.responderSessaoJules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      texto: string
    }
    expect(chamada.texto).toContain(respostaNoTeto)
    expect(deps.onWarn).not.toHaveBeenCalled()
  })
})
