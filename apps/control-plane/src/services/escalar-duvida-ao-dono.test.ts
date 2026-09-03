import { describe, it, expect, vi } from 'vitest'
import { escalarDuvidaAoDono, type PrismaParaEscalarDuvida } from './escalar-duvida-ao-dono.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'

/**
 * CAUSA RAIZ (L4-T3, item 0) — medido 02/09: 30 dev_sessions em
 * AWAITING_USER_FEEDBACK, 24 com `answered_hash` gravado (marcado
 * "respondida") no instante da escalada, e `agent_questions` com ZERO linhas
 * de dedupKey `duvida-dev:*`. O produto achava que tinha perguntado ao dono;
 * ninguém nunca viu nada.
 *
 * Reconstrução exata: `destinoAposRa` (services/duvida-do-dev.ts, chamado
 * quando nem o QA nem o RA sabem responder) NUNCA popula `perguntaExecutiva`
 * — a função não tem esse campo. O próprio QA também pode deixar
 * `perguntaExecutivaPtBr` vazio de propósito (o prompt em
 * duvida-rails-mission.ts autoriza: "leave both empty rather than forcing a
 * bad one"). Nos dois casos, `plugins/scheduler.ts` (`responderDuvidaPendente`,
 * ramo `perguntar-ao-dono`) caía para `avisarDonoDoProjeto` — um aviso de
 * TEXTO SOLTO, sem `agent_question`, sem dedupKey `duvida-dev:*`, sem botão —
 * violando D71 ("toda pergunta ao dono é agent_question com opções, nunca
 * texto solto"). E pior: a marca `respondida:0:<hash>` era gravada ANTES e
 * INCONDICIONALMENTE, então mesmo quando `perguntador.ask(...)` FALHAVA
 * (rede, Prisma), a sessão ficava marcada como respondida do mesmo jeito.
 *
 * A primeira versão desta função (rodada contra o teste abaixo antes do
 * conserto) reproduziu o defeito byte a byte: `ask` nunca era chamado neste
 * cenário — ficou RED. O conserto: `perguntar-ao-dono` SEMPRE vira uma
 * pergunta de verdade (usa `textoDeEscaladaParaODono` como PT-BR de reserva
 * quando falta `perguntaExecutiva`), e a marca vira `escalada:` (nunca
 * `respondida:`) — só gravada DEPOIS que a pergunta nasceu.
 */

function prismaFalso(overrides: Partial<PrismaParaEscalarDuvida> = {}): PrismaParaEscalarDuvida {
  return {
    project: {
      findUnique: vi.fn(async () => ({
        id: 'proj1',
        wingId: 'acme/api',
        userId: 'user1',
        runtimeConfig: null,
      })),
    },
    devSession: {
      update: vi.fn(async () => undefined),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    ...overrides,
  } as PrismaParaEscalarDuvida
}

const ARGS_BASE = {
  sessionName: 'sessions/1',
  issueNumber: 46,
  repository: 'acme/api',
  hashDaPergunta: 'hash123',
  projectId: 'proj1',
  pergunta: 'Should I use bcrypt or argon2?',
  apiKey: 'jules-key',
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso(),
    agentQuestionService: {
      ask: vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } as never })),
    },
    responderSessaoJules: vi.fn(async () => true),
    onInfo: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

describe('escalarDuvidaAoDono — causa raiz medida 02/09 (destinoAposRa sem perguntaExecutiva)', () => {
  it('SEMPRE cria uma agent_question de verdade — nunca cai para aviso de texto solto', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      {
        destino: {
          tipo: 'perguntar-ao-dono',
          motivo: 'nem o QA nem o RA conseguiram responder lendo o repositório.',
        },
        ...ARGS_BASE,
      },
      deps as never
    )

    // A PROVA do defeito original: sem `perguntaExecutiva`, `ask` nunca era
    // chamado — o código caía direto para um aviso de texto solto.
    expect(deps.agentQuestionService.ask).toHaveBeenCalledTimes(1)
    expect(deps.agentQuestionService.ask).toHaveBeenCalledWith(
      'user1',
      'proj1',
      expect.objectContaining({ dedupKey: 'duvida-dev:acme/api:46:hash123' })
    )
  })

  // D72 (02/09) — SUBSTITUI o teste antigo, que esperava a pergunta CRUA do
  // dev (em inglês) no texto de reserva. O dono flagrou isso ao vivo, com
  // print do painel/Telegram, exatamente na tarefa #309 de GitOrchAI/gitorch:
  // "Pergunta original do dev: 'I have successfully modified...'" com UM
  // botão só. A reserva agora é sempre a pergunta executiva determinística,
  // com 3 opções — NUNCA cita o texto do dev.
  it('D72: sem perguntaExecutiva do modelo — pergunta executiva de RESERVA, nunca a pergunta crua do dev', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    const chamada = deps.agentQuestionService.ask.mock.calls[0] as unknown as [
      string,
      string,
      { text: string; options: Array<{ label: string; value: string }> },
    ]
    expect(chamada[2].text).toBe(
      'O dev está travado numa dúvida técnica na tarefa #46 de acme/api e nem o RA conseguiu ' +
        'resolver. O que fazer?'
    )
    expect(chamada[2].text).not.toContain('Should I use bcrypt or argon2?')
    // 3 opções executivas + a 4ª "Outro" (D71: 3 objetivas + 1 aberta).
    expect(chamada[2].options).toHaveLength(4)
    expect(chamada[2].options.slice(0, 3).map((o) => o.label)).toEqual([
      'Pausar a tarefa e revisar depois',
      'Seguir com a melhor suposição do RA mesmo assim',
      'Pedir ao dev que abra o PR com o que tem',
    ])
  })

  it('com perguntaExecutiva do modelo E exatamente 3 opções: usa a tradução do modelo, não a reserva', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      {
        destino: {
          tipo: 'perguntar-ao-dono',
          motivo: 'decisão de negócio',
          perguntaExecutiva: 'Podemos cobrar taxa extra por esta feature?',
          opcoes: [
            { label: 'Sim', value: 'sim' },
            { label: 'Não', value: 'nao' },
            { label: 'Só para o plano Pro', value: 'so-pro' },
          ],
        },
        ...ARGS_BASE,
      },
      deps as never
    )

    const chamada = deps.agentQuestionService.ask.mock.calls[0] as unknown as [
      string,
      string,
      { text: string; options: Array<{ value: string }> },
    ]
    expect(chamada[2].text).toBe('Podemos cobrar taxa extra por esta feature?')
    // as 3 opções do modelo + a 4ª "Outro" sempre presente (D71).
    expect(chamada[2].options.map((o) => o.value)).toEqual([
      'sim',
      'nao',
      'so-pro',
      FREE_TEXT_OPTION_VALUE,
    ])
  })

  // D72: 1-2 opções do modelo NÃO bastam mais — sem as 3, a tradução do
  // modelo é descartada e vale a pergunta executiva de reserva (nunca manda
  // ao dono uma pergunta traduzida mas com menos de 3 opções reais).
  it('D72: perguntaExecutiva do modelo mas com só 1 opção — cai para a reserva de 3 opções', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      {
        destino: {
          tipo: 'perguntar-ao-dono',
          motivo: 'decisão de negócio',
          perguntaExecutiva: 'Podemos cobrar taxa extra por esta feature?',
          opcoes: [{ label: 'Sim', value: 'sim' }],
        },
        ...ARGS_BASE,
      },
      deps as never
    )

    const chamada = deps.agentQuestionService.ask.mock.calls[0] as unknown as [
      string,
      string,
      { text: string; options: Array<{ label: string; value: string }> },
    ]
    expect(chamada[2].text).not.toBe('Podemos cobrar taxa extra por esta feature?')
    expect(chamada[2].options.slice(0, 3).map((o) => o.label)).toEqual([
      'Pausar a tarefa e revisar depois',
      'Seguir com a melhor suposição do RA mesmo assim',
      'Pedir ao dev que abra o PR com o que tem',
    ])
  })

  /**
   * C2 (fix-up L4-T3): D71 é "3 objetivas + 1 aberta" — SEMPRE. Sem o teto,
   * um RA que devolvesse 4+ opções faria `ask()` juntar TODAS + a opção
   * livre, estourando o formato que o dono sempre pede.
   */
  it('C2: RA devolve 4 opções — só as 3 primeiras entram, mais a opção livre (D71: 3 + 1)', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      {
        destino: {
          tipo: 'perguntar-ao-dono',
          motivo: 'decisão de negócio',
          perguntaExecutiva: 'Qual plano de cobrança usar?',
          opcoes: [
            { label: 'Mensal', value: 'mensal' },
            { label: 'Anual', value: 'anual' },
            { label: 'Vitalício', value: 'vitalicio' },
            { label: 'Gratuito', value: 'gratuito' },
          ],
        },
        ...ARGS_BASE,
      },
      deps as never
    )

    const chamada = deps.agentQuestionService.ask.mock.calls[0] as unknown as [
      string,
      string,
      { options: Array<{ value: string }> },
    ]
    expect(chamada[2].options.map((o) => o.value)).toEqual([
      'mensal',
      'anual',
      'vitalicio',
      FREE_TEXT_OPTION_VALUE,
    ])
    expect(chamada[2].options.length).toBe(4)
  })

  it('a marca ESCALADA só é gravada DEPOIS que a pergunta nasceu de verdade — nunca antes', async () => {
    const ordem: string[] = []
    const prisma = prismaFalso()
    ;(prisma.devSession.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ordem.push('gravou-marca')
    })
    const ask = vi.fn(async () => {
      ordem.push('perguntou')
      return { deduped: false, question: { id: 'q1', answer: null } as never }
    })
    const deps = depsFalso({ prisma, agentQuestionService: { ask } })

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    expect(ordem).toEqual(['perguntou', 'gravou-marca'])
    expect(prisma.devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ answeredHash: 'escalada:0:hash123' }),
      })
    )
  })

  it('ask() falha: erro ALTO (nunca silêncio) e a marca NÃO é gravada — a sessão continua tentando', async () => {
    const erro = new Error('rede caiu')
    const deps = depsFalso({
      agentQuestionService: { ask: vi.fn(async () => Promise.reject(erro)) },
    })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow()

    expect(deps.onError).toHaveBeenCalled()
    expect((deps.prisma as PrismaParaEscalarDuvida).devSession.update).not.toHaveBeenCalled()
  })

  it('sem agentQuestionService ligado: erro ALTO e lança — nunca finge que perguntou', async () => {
    const deps = depsFalso({ agentQuestionService: undefined })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow()

    expect(deps.onError).toHaveBeenCalled()
  })

  it('projeto sem userId (sem dono vinculado): erro ALTO e lança', async () => {
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => ({
          id: 'proj1',
          wingId: 'acme/api',
          userId: null,
          runtimeConfig: null,
        })),
      },
    })
    const deps = depsFalso({ prisma })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow()

    expect(deps.onError).toHaveBeenCalled()
  })

  it('projeto não encontrado: erro ALTO e lança', async () => {
    const prisma = prismaFalso({ project: { findUnique: vi.fn(async () => null) } })
    const deps = depsFalso({ prisma })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow()

    expect(deps.onError).toHaveBeenCalled()
  })

  it('ask() devolve deduped=true (mesma pergunta já respondida antes): entrega a resposta anterior direto ao dev', async () => {
    const ask = vi.fn(async () => ({
      deduped: true,
      question: { id: 'q1', answer: 'Use argon2.' } as never,
    }))
    const responderSessaoJules = vi.fn(async () => true)
    const deps = depsFalso({ agentQuestionService: { ask }, responderSessaoJules })

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    expect(responderSessaoJules).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'jules-key',
        sessionName: 'sessions/1',
        texto: expect.stringContaining('Use argon2.'),
      })
    )
    // Entregue de verdade ao dev: marca RESPONDIDA (não escalada) — o ciclo fechou.
    expect((deps.prisma as PrismaParaEscalarDuvida).devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ answeredHash: 'respondida:0:hash123' }),
      })
    )
  })

  it('C5: deduped mas a entrega ao dev falha: LANÇA (nunca finge sucesso) — não marca respondida', async () => {
    const ask = vi.fn(async () => ({
      deduped: true,
      question: { id: 'q1', answer: 'Use argon2.' } as never,
    }))
    const responderSessaoJules = vi.fn(async () => false)
    const deps = depsFalso({ agentQuestionService: { ask }, responderSessaoJules })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow()

    expect((deps.prisma as PrismaParaEscalarDuvida).devSession.update).not.toHaveBeenCalled()
    expect(deps.onError).toHaveBeenCalled()
  })

  /**
   * C5 (fix-up L4-T3): `!resultado.question.answer` só barrava `null`/`''` —
   * uma resposta gravada como espaço em branco (`'   '`) é truthy em JS e
   * passava direto, entregando um texto vazio ao dev. Trata como corrompida:
   * nunca entrega, erro ALTO (nunca silêncio).
   */
  it('C5: resposta anterior vazia/só espaço (dedupado): NÃO entrega texto vazio ao dev — lança erro claro', async () => {
    const ask = vi.fn(async () => ({
      deduped: true,
      question: { id: 'q1', answer: '   ' } as never,
    }))
    const responderSessaoJules = vi.fn(async () => true)
    const deps = depsFalso({ agentQuestionService: { ask }, responderSessaoJules })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).rejects.toThrow(/resposta.*vazia/i)

    expect(responderSessaoJules).not.toHaveBeenCalled()
    expect(deps.onError).toHaveBeenCalled()
    expect((deps.prisma as PrismaParaEscalarDuvida).devSession.update).not.toHaveBeenCalled()
  })
})
