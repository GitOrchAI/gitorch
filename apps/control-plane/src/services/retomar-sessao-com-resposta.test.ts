import { describe, it, expect, vi } from 'vitest'
import {
  aoResponderDuvidaDoDev,
  manipuladorDeResultadoDeRetomada,
  AVISO_CORRECAO_SEM_SESSAO_VIVA,
  type PrismaParaRetomada,
} from './retomar-sessao-com-resposta.js'

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
      findMany: vi.fn(async () => [SESSAO]),
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
  // D2 (fix-up 6, task a13a42f8-2953-4259-b41f-3f8cddb304cd): status da
  // pergunta ANTES desta resposta — 'open' é o fluxo comum (dono responde
  // pela primeira vez). Ver describe dedicado abaixo para 'assumida'
  // (correção de uma suposição do RA já entregue ao dev).
  statusAnterior: 'open' as const,
}

describe('aoResponderDuvidaDoDev', () => {
  // Fix-up (revisão): antes deste teste, os dois casos abaixo (dedupKey de
  // outro assunto vs. dedupKey do assunto CERTO mas corrompido) devolviam o
  // MESMO `{ entregue: false }` sem motivo — o chamador (plugins/telegram.ts)
  // só sabe avisar o dono quando `motivo === 'sem-sessao-viva'`, então uma
  // correção do dono numa pergunta com chave malformada sumia sem aviso
  // nenhum, igualzinho ao caso "nem era meu assunto" (que É certo ficar em
  // silêncio). Agora os dois têm motivo PRÓPRIO e distinto.
  it('dedupKey de outro tipo (ex.: automacao:) NUNCA aciona nada — não é assunto deste manipulador (motivo nao-aplicavel)', async () => {
    const deps = depsFalso()

    const resultado = await aoResponderDuvidaDoDev(
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
    expect(resultado).toEqual({ entregue: false, motivo: 'nao-aplicavel' })
  })

  it('dedupKey COM o prefixo duvida-dev: mas malformado (issue não é número) NUNCA aciona nada — mas é falha DE VERDADE (motivo chave-malformada)', async () => {
    const deps = depsFalso()

    const resultado = await aoResponderDuvidaDoDev(
      {
        dedupKey: 'duvida-dev:acme/api:naoenumero:hash',
        resposta: 'sim',
        projectId: 'proj1',
        userId: 'user1',
        opcoes: [],
      },
      deps as never
    )

    expect(resultado).toEqual({ entregue: false, motivo: 'chave-malformada' })

    expect(deps.responderSessaoJules).not.toHaveBeenCalled()
  })

  it('sucesso: retoma a sessão com a LABEL da opção escolhida + "Decisão do dono." e marca respondida', async () => {
    const deps = depsFalso()

    const resultado = await aoResponderDuvidaDoDev(ARGS_BASE, deps as never)

    // L4-T21: o caminho feliz continua devolvendo `entregue: true` — a
    // correção do dono passa a devolver um RESULTADO em vez de void, mas o
    // caminho feliz (sessão viva encontrada) nunca muda de comportamento.
    expect(resultado).toEqual({ entregue: true })
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

  // ---------------------------------------------------------------------
  // D2 (fix-up 6, task a13a42f8-2953-4259-b41f-3f8cddb304cd): o dono corrige
  // uma pergunta já ASSUMIDA (o RA formou suposição depois de 24h de
  // silêncio, L4-T4/D64, e já entregou ao dev via `supor-duvida-pendente.ts`).
  //
  // Depois da suposição, a marca da sessão NÃO é mais `escalada:<n>:<hash>`
  // — `suporDuvidaPendente` grava `marcarRespondida(marca.hash)`, que é
  // `respondida:0:<hash>` (MESMO hash, situação diferente). A busca do fluxo
  // normal (acima, por `escalada:` exato e depois por `startsWith('escalada:')`)
  // NUNCA acharia essa sessão — e a correção do dono falharia com "sessão
  // escalada não encontrada" mesmo com a sessão viva e esperando. A regra
  // nova: quando `statusAnterior === 'assumida'`, a busca ignora a SITUAÇÃO
  // da marca (`lerMarca(...).situacao` pode ser `respondida`, `escalada`,
  // `tentando` ou `desisti`) e casa só pelo HASH — o que identifica ESTA
  // pergunta de forma estável entre a suposição e a correção.
  // ---------------------------------------------------------------------
  describe('D2: correção do dono depois da suposição do RA (statusAnterior "assumida")', () => {
    const SESSAO_POS_SUPOSICAO = {
      ...SESSAO,
      sessionName: 'sessions/pos-suposicao',
      // A marca NÃO começa mais por 'escalada:' — é isto que o fluxo normal
      // (statusAnterior 'open') nunca encontra.
      answeredHash: 'respondida:0:hash123',
    }

    it('localiza a sessão pela marca "respondida:" (mesmo hash) — o fluxo normal por "escalada:" nunca acharia', async () => {
      const findMany = vi.fn(async () => [SESSAO_POS_SUPOSICAO])
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => {
            throw new Error('statusAnterior=assumida NUNCA deve usar findFirst por escalada:')
          }),
          findMany,
          update: vi.fn(async () => undefined),
        } as never,
      })
      const deps = depsFalso({ prisma })

      await aoResponderDuvidaDoDev({ ...ARGS_BASE, statusAnterior: 'assumida' }, deps as never)

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'proj1',
            issueNumber: 46,
            state: 'AWAITING_USER_FEEDBACK',
          }),
        })
      )
      expect(deps.responderSessaoJules).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: 'sessions/pos-suposicao' })
      )
    })

    it('a mensagem ao dev usa a moldura "Correção do dono (substitui a suposição do RA): ..." — nunca "Decisão do dono."', async () => {
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => [SESSAO_POS_SUPOSICAO]),
          update: vi.fn(async () => undefined),
        } as never,
      })
      const deps = depsFalso({ prisma })

      await aoResponderDuvidaDoDev({ ...ARGS_BASE, statusAnterior: 'assumida' }, deps as never)

      const chamada = (deps.responderSessaoJules as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        texto: string
      }
      expect(chamada.texto).toContain('Correção do dono (substitui a suposição do RA):')
      expect(chamada.texto).toContain('Sim, pode cobrar')
      expect(chamada.texto).not.toContain('Decisão do dono.')
    })

    it('grava respondida normalmente ao final (mesmo formato de marca do fluxo comum)', async () => {
      const update = vi.fn(async () => undefined)
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => [SESSAO_POS_SUPOSICAO]),
          update,
        } as never,
      })
      const deps = depsFalso({ prisma })

      await aoResponderDuvidaDoDev({ ...ARGS_BASE, statusAnterior: 'assumida' }, deps as never)

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionName: 'sessions/pos-suposicao' },
          data: expect.objectContaining({ answeredHash: 'respondida:0:hash123' }),
        })
      )
    })

    // L4-T21 — defeito medido em produção (21:07 UTC, issue #309): o dono
    // corrigiu a suposição do RA, a sessão do dev já tinha morrido, e o
    // manipulador LANÇAVA — a rota devolvia HTTP 500 e a correção do dono
    // se perdia (a `agent_question` nunca virava `answered`, o clique dele
    // não valeu nada). A partir de agora: NUNCA lança neste ramo — registra
    // a correção de forma durável (comentário na issue, pelo helper
    // guardado pela autonomia) e devolve `{ entregue: false, motivo:
    // 'sem-sessao-viva' }`. Quem chama (`answer()`, agent-question.ts)
    // segue e grava a resposta na própria `agent_question` — é ISSO que
    // torna a correção durável mesmo sem sessão viva (nunca finge que
    // entregou ao dev).
    it('nenhuma sessão viva com o hash desta pergunta: NUNCA lança — comenta na issue e devolve entregue:false/motivo sem-sessao-viva', async () => {
      const sessaoDeOutraPergunta = {
        ...SESSAO,
        sessionName: 'sessions/outra-pergunta',
        answeredHash: 'respondida:0:hash-de-outra-pergunta',
      }
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => [sessaoDeOutraPergunta]),
          update: vi.fn(async () => undefined),
        } as never,
      })
      const comentarNaIssue = vi.fn(async () => undefined)
      const deps = depsFalso({ prisma, comentarNaIssue })

      const resultado = await aoResponderDuvidaDoDev(
        { ...ARGS_BASE, statusAnterior: 'assumida' },
        deps as never
      )

      expect(resultado).toEqual({ entregue: false, motivo: 'sem-sessao-viva' })
      expect(deps.responderSessaoJules).not.toHaveBeenCalled()
      expect(comentarNaIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 46,
          texto: expect.stringContaining('Sim, pode cobrar'),
        })
      )
    })

    it('sem comentarNaIssue configurado: ainda assim NUNCA lança — avisa pelo onWarn e devolve entregue:false', async () => {
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
          update: vi.fn(async () => undefined),
        } as never,
      })
      const deps = depsFalso({ prisma, comentarNaIssue: undefined })

      const resultado = await aoResponderDuvidaDoDev(
        { ...ARGS_BASE, statusAnterior: 'assumida' },
        deps as never
      )

      expect(resultado).toEqual({ entregue: false, motivo: 'sem-sessao-viva' })
      expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('acme/api#46'))
    })

    it('comentarNaIssue falha (issue apagada, rede fora): best-effort — ainda assim devolve entregue:false, nunca lança', async () => {
      const prisma = prismaFalso({
        devSession: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
          update: vi.fn(async () => undefined),
        } as never,
      })
      const comentarNaIssue = vi.fn(async () => {
        throw new Error('GitHub 404')
      })
      const deps = depsFalso({ prisma, comentarNaIssue })

      const resultado = await aoResponderDuvidaDoDev(
        { ...ARGS_BASE, statusAnterior: 'assumida' },
        deps as never
      )

      expect(resultado).toEqual({ entregue: false, motivo: 'sem-sessao-viva' })
      expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('GitHub 404'))
    })

    it('regressão: com statusAnterior "open" (fluxo comum), uma sessão só com marca "respondida:" (sem nenhuma "escalada:") NUNCA é encontrada — prova que os dois fluxos de busca são mesmo diferentes', async () => {
      const findFirst = vi.fn(async () => null) // nem hash exato, nem startsWith('escalada:') acham nada
      const prisma = prismaFalso({
        devSession: {
          findFirst,
          findMany: vi.fn(async () => [SESSAO_POS_SUPOSICAO]),
          update: vi.fn(async () => undefined),
        } as never,
      })
      const deps = depsFalso({ prisma })

      await expect(
        aoResponderDuvidaDoDev({ ...ARGS_BASE, statusAnterior: 'open' }, deps as never)
      ).rejects.toThrow(/sessão escalada não encontrada/)
      expect(deps.responderSessaoJules).not.toHaveBeenCalled()
    })
  })
})

/**
 * Fix-up (revisão) do defeito 5: `plugins/telegram.ts` registra
 * `aoResponderDuvidaDoDev` (este arquivo) como o manipulador do prefixo
 * `duvida-dev:` em `AgentQuestionService`, e precisa decidir o que FAZER com
 * cada `ResultadoDeRetomada` — extraído aqui (em vez de ficar um `if` solto
 * dentro do plugin Fastify) para ser testável sem montar app/prisma/telegram
 * inteiros, mesmo padrão de `parseDedupKeyDeDuvidaDoDev`/`criarComentarNaIssue`.
 *
 * Contrato (doc de `ResultadoDoManipuladorDeResposta`, agent-question.ts):
 * `aviso` só faz sentido numa resposta de SUCESSO; um manipulador que falha
 * DE VERDADE continua lançando — nunca finge sucesso com um aviso.
 */
describe('manipuladorDeResultadoDeRetomada', () => {
  it('entregue:true (caminho feliz) — nada a avisar', () => {
    expect(manipuladorDeResultadoDeRetomada({ entregue: true })).toBeUndefined()
  })

  it('motivo sem-sessao-viva — sucesso durável, mas não entregue de imediato: aviso em português', () => {
    expect(
      manipuladorDeResultadoDeRetomada({ entregue: false, motivo: 'sem-sessao-viva' })
    ).toEqual({ aviso: AVISO_CORRECAO_SEM_SESSAO_VIVA })
  })

  it('motivo nao-aplicavel — dedupKey nem era deste manipulador: silêncio, de propósito (nunca aviso)', () => {
    expect(
      manipuladorDeResultadoDeRetomada({ entregue: false, motivo: 'nao-aplicavel' })
    ).toBeUndefined()
  })

  it('motivo chave-malformada — falha DE VERDADE: LANÇA (nunca devolve aviso fingindo sucesso)', () => {
    expect(() =>
      manipuladorDeResultadoDeRetomada({ entregue: false, motivo: 'chave-malformada' })
    ).toThrow()
  })
})
