import { describe, it, expect, vi } from 'vitest'
import {
  registrarConversaDaSessao,
  sanitizarTextoDoCatalogo,
  TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO,
  type PrismaCatalogoDeDuvidas,
} from './catalogo-de-duvidas.js'

// L5-T5 (D75, 05/09) — "tem que ter sistema que coleta todas essas dúvidas
// pra que nas próximas tasks o RA e PO não gerem dúvidas". Este módulo é a
// PORTA DE ESCRITA única do catálogo: guarda, por sessão/projeto/tarefa, cada
// pergunta do dev (`agentMessaged`) e cada resposta que O TIME deu
// (`userMessaged`) — nunca decide o que fazer com o catálogo depois (isso é
// tarefa seguinte, fora do escopo desta).

function prismaFalso(overrides: Partial<PrismaCatalogoDeDuvidas> = {}): PrismaCatalogoDeDuvidas {
  return {
    catalogoDeDuvidas: {
      createMany: vi.fn(async (args: unknown) => ({
        count: (args as { data: unknown[] }).data.length,
      })),
    },
    ...overrides,
  } as PrismaCatalogoDeDuvidas
}

const ARGS_BASE = {
  projectId: 'proj1',
  sessionName: 'sessions/1',
  issueNumber: 46,
}

describe('registrarConversaDaSessao', () => {
  it('grava cada atividade com originator, momento, projeto e tarefa', async () => {
    const prisma = prismaFalso()

    await registrarConversaDaSessao({
      prisma,
      ...ARGS_BASE,
      atividades: [
        {
          originator: 'agent',
          quando: new Date('2026-01-01T10:00:00Z'),
          texto: 'devo usar bcrypt ou argon2?',
        },
        {
          originator: 'user',
          quando: new Date('2026-01-01T10:05:00Z'),
          texto: 'use argon2',
        },
      ],
    })

    expect(prisma.catalogoDeDuvidas.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectId: 'proj1',
          sessionName: 'sessions/1',
          issueNumber: 46,
          originator: 'agent',
          texto: 'devo usar bcrypt ou argon2?',
          momento: new Date('2026-01-01T10:00:00Z'),
        },
        {
          projectId: 'proj1',
          sessionName: 'sessions/1',
          issueNumber: 46,
          originator: 'user',
          texto: 'use argon2',
          momento: new Date('2026-01-01T10:05:00Z'),
        },
      ],
      skipDuplicates: true,
    })
  })

  it('idempotente: skipDuplicates:true é o que permite chamar de novo com a MESMA janela sem duplicar', async () => {
    const prisma = prismaFalso()

    await registrarConversaDaSessao({
      prisma,
      ...ARGS_BASE,
      atividades: [{ originator: 'agent', quando: new Date('2026-01-01T10:00:00Z'), texto: 'x' }],
    })

    const chamada = (prisma.catalogoDeDuvidas.createMany as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { skipDuplicates: boolean }
    expect(chamada.skipDuplicates).toBe(true)
  })

  it('lista vazia: não chama o banco à toa', async () => {
    const prisma = prismaFalso()

    await registrarConversaDaSessao({ prisma, ...ARGS_BASE, atividades: [] })

    expect(prisma.catalogoDeDuvidas.createMany).not.toHaveBeenCalled()
  })

  it('trunca e neutraliza cada texto antes de gravar — nunca cru sem teto', async () => {
    const prisma = prismaFalso()
    const textoGigante = 'a'.repeat(TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO + 500)

    await registrarConversaDaSessao({
      prisma,
      ...ARGS_BASE,
      atividades: [
        { originator: 'agent', quando: new Date('2026-01-01T10:00:00Z'), texto: textoGigante },
      ],
    })

    const chamada = (prisma.catalogoDeDuvidas.createMany as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { data: Array<{ texto: string }> }
    expect(chamada.data[0]?.texto.length).toBe(TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO)
  })

  it('propaga erro do banco — nunca mascara (o chamador decide best-effort ou não)', async () => {
    const prisma = prismaFalso({
      catalogoDeDuvidas: {
        createMany: vi.fn(async () => Promise.reject(new Error('conexão caiu'))),
      },
    })

    await expect(
      registrarConversaDaSessao({
        prisma,
        ...ARGS_BASE,
        atividades: [{ originator: 'agent', quando: new Date(), texto: 'x' }],
      })
    ).rejects.toThrow('conexão caiu')
  })
})

describe('sanitizarTextoDoCatalogo', () => {
  it('neutraliza menção e comando (mesma disciplina de neutralizarTextoDeTerceiros)', () => {
    expect(sanitizarTextoDoCatalogo('oi @fulano /close')).not.toContain('@fulano')
    expect(sanitizarTextoDoCatalogo('oi @fulano /close')).not.toMatch(/(^|\s)\/close/)
  })

  it('corta no teto', () => {
    const grande = 'x'.repeat(TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO + 100)
    expect(sanitizarTextoDoCatalogo(grande).length).toBe(TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO)
  })
})
