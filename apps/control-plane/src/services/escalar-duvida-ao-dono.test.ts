import { describe, it, expect, vi } from 'vitest'
import { escalarDuvidaAoDono, type PrismaParaEscalarDuvida } from './escalar-duvida-ao-dono.js'

/**
 * D75 (05/09) — DECISÃO DO DONO, palavras dele: "os agentes do gitorch nao
 * podem mandar essas duvidas pra mim, o jules (DEV assincrono) eles (QA, SM,
 * PO e RA) algum deles tem que resolver isso, responder o jules. E não
 * passar por mim, se o dev assincrono tem duvidas, é pq foi mal planejado la
 * atras com o PO e RA."
 *
 * ATÉ esta tarefa (L5-T5), `escalarDuvidaAoDono` SEMPRE criava uma
 * `agent_question` de verdade (`agentQuestionService.ask(...)`) — era
 * literalmente a função que subia a dúvida do dev ao dono. O conserto
 * anterior (L4-T3, 02-03/09) tinha fechado o buraco de "achava que perguntou
 * e não perguntou"; esta tarefa fecha o caminho por INTEIRO: a função NUNCA
 * MAIS pergunta ao dono. Quando QA/RA/PO não resolvem, a sessão ESPERA — e
 * isto é FALHA DO TIME (planejamento malfeito lá atrás), sempre registrada
 * (nunca silêncio), nunca uma pergunta ao dono.
 *
 * Os testes ANTIGOS deste arquivo (pré-D75) afirmavam o oposto — que `ask()`
 * era SEMPRE chamado. Removidos/reescritos de propósito: são a MESMA classe
 * de regressão que este arquivo existe para travar, só que na direção nova.
 */

function prismaFalso(overrides: Partial<PrismaParaEscalarDuvida> = {}): PrismaParaEscalarDuvida {
  return {
    catalogoDeDuvidas: {
      createMany: vi.fn(async (args: unknown) => ({
        count: (args as { data: unknown[] }).data.length,
      })),
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

const CONVERSA_PADRAO = [
  { originator: 'agent' as const, quando: new Date('2026-01-01T10:00:00Z'), texto: 'pergunta' },
]

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso(),
    buscarConversa: vi.fn(async () => CONVERSA_PADRAO),
    onInfo: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

describe('escalarDuvidaAoDono — D75 (05/09): o caminho ao dono está FECHADO', () => {
  it('NUNCA cria agent_question — a interface de deps nem aceita agentQuestionService (fechado na estrutura, não só no comportamento)', async () => {
    const deps = depsFalso()

    // Nenhuma das chaves de deps tem relação com agent-question/ask — a
    // prova estrutural de que este caminho foi removido, não só desviado.
    expect(Object.keys(deps)).toEqual(
      expect.not.arrayContaining(['agentQuestionService', 'montarContexto'])
    )

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'decisão de negócio' }, ...ARGS_BASE },
      deps as never
    )

    // Nada no fake de prisma tem `ask` nem `agentQuestion` — se o código
    // tentasse chamar algo assim, o teste quebraria por TypeError, não por
    // uma asserção que alguém possa esquecer de escrever.
  })

  it('QA/RA/PO não resolveram: registra FALHA DO TIME via onError, nunca lança (a sessão espera)', async () => {
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

    expect(deps.onError).toHaveBeenCalledTimes(1)
    const [erro, mensagem] = (deps.onError as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      string,
    ]
    expect(erro).toBeInstanceOf(Error)
    expect(mensagem).toContain('#46')
    expect(mensagem).toContain('acme/api')
    expect(mensagem).toMatch(/falha do time/i)
    expect(mensagem).not.toMatch(/agent.?question/i)
  })

  it('motivo do destino "escalar-ao-ra" (sem perguntar-ao-dono): usa "sem resposta útil" no relato', async () => {
    const deps = depsFalso()

    await escalarDuvidaAoDono(
      { destino: { tipo: 'escalar-ao-ra', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    const [, mensagem] = (deps.onError as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      string,
    ]
    expect(mensagem).toContain('sem resposta útil')
  })

  it('persiste a conversa da sessão no catálogo (pergunta do dev + resposta do time) antes de registrar a falha', async () => {
    const conversa = [
      { originator: 'agent' as const, quando: new Date('2026-01-01T10:00:00Z'), texto: 'pergunta' },
      { originator: 'user' as const, quando: new Date('2026-01-01T10:05:00Z'), texto: 'resposta' },
    ]
    const buscarConversa = vi.fn(async () => conversa)
    const prisma = prismaFalso()
    const deps = depsFalso({ buscarConversa, prisma })

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    expect(buscarConversa).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'jules-key', sessionName: 'sessions/1' })
    )
    expect(prisma.catalogoDeDuvidas.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectId: 'proj1',
          sessionName: 'sessions/1',
          issueNumber: 46,
          originator: 'agent',
          texto: 'pergunta',
          momento: new Date('2026-01-01T10:00:00Z'),
        },
        {
          projectId: 'proj1',
          sessionName: 'sessions/1',
          issueNumber: 46,
          originator: 'user',
          texto: 'resposta',
          momento: new Date('2026-01-01T10:05:00Z'),
        },
      ],
      skipDuplicates: true,
    })
  })

  it('falha ao buscar a conversa (rede do Jules caiu): best-effort — a falha do time é registrada do mesmo jeito, nunca lança', async () => {
    const buscarConversa = vi.fn(async () => {
      throw new Error('rede do jules caiu')
    })
    const deps = depsFalso({ buscarConversa })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).resolves.toBeUndefined()

    expect(deps.onInfo).toHaveBeenCalledWith(expect.stringContaining('rede do jules caiu'))
    expect(deps.onError).toHaveBeenCalledTimes(1)
  })

  it('falha ao gravar o catálogo (banco fora do ar): best-effort — a falha do time é registrada do mesmo jeito, nunca lança', async () => {
    const prisma = prismaFalso({
      catalogoDeDuvidas: {
        createMany: vi.fn(async () => Promise.reject(new Error('banco fora do ar'))),
      },
    })
    const deps = depsFalso({ prisma })

    await expect(
      escalarDuvidaAoDono(
        { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
        deps as never
      )
    ).resolves.toBeUndefined()

    expect(deps.onInfo).toHaveBeenCalledWith(expect.stringContaining('banco fora do ar'))
    expect(deps.onError).toHaveBeenCalledTimes(1)
  })

  it('conversa vazia (Jules ainda sem histórico legível): não grava nada no catálogo, mas ainda registra a falha do time', async () => {
    const buscarConversa = vi.fn(async () => [])
    const prisma = prismaFalso()
    const deps = depsFalso({ buscarConversa, prisma })

    await escalarDuvidaAoDono(
      { destino: { tipo: 'perguntar-ao-dono', motivo: 'x' }, ...ARGS_BASE },
      deps as never
    )

    expect(prisma.catalogoDeDuvidas.createMany).not.toHaveBeenCalled()
    expect(deps.onError).toHaveBeenCalledTimes(1)
  })
})
