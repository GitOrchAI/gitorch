import { describe, expect, it, vi } from 'vitest'
import { fecharPrsSubstituidosDaEntrega } from './github-webhook.js'
import type { PrismaDevSession } from '../services/dev-session-store.js'
import { marcadorDePrSubstituido } from '../services/pr-substituido.js'

// L4-T5, item 3: PR NOVO nasce (#3917) para uma issue (#3884) que já tinha
// outro PR do dev aberto (#3907, retomada anterior ou corrida de ciclos). O
// antigo fecha como substituído; o novo nunca é tocado.

function prismaFalso(args: {
  sessaoNova: { sessionName: string; issueNumber: number }
  linhasComPr: Array<{ pullRequestNumber: number | null }>
}) {
  const findFirst = vi.fn(async () => args.sessaoNova)
  const findMany = vi.fn(async () => args.linhasComPr)
  return {
    prisma: { devSession: { findFirst, findMany } } as unknown as PrismaDevSession,
    findFirst,
    findMany,
  }
}

describe('fecharPrsSubstituidosDaEntrega', () => {
  it('fecha o PR antigo do dev quando um novo nasce para a mesma issue', async () => {
    const { prisma } = prismaFalso({
      sessaoNova: { sessionName: 'sessions/nova', issueNumber: 3884 },
      linhasComPr: [{ pullRequestNumber: 3907 }, { pullRequestNumber: 3917 }],
    })
    const comentarEFechar = vi.fn(async () => undefined)
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma,
      projectId: 'proj-1',
      sessionName: 'sessions/nova',
      numeroDoNovoPr: 3917,
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar,
      onInfo: () => undefined,
      onWarn: () => undefined,
    })
    expect(r).toEqual([3907])
    expect(comentarEFechar).toHaveBeenCalledWith(
      expect.objectContaining({ numeroDoPr: 3907, comentario: expect.stringContaining('#3917') })
    )
  })

  it('nunca lista o PR novo como candidato a fechar', async () => {
    const { prisma, findMany } = prismaFalso({
      sessaoNova: { sessionName: 'sessions/nova', issueNumber: 3884 },
      linhasComPr: [{ pullRequestNumber: 3917 }],
    })
    const comentarEFechar = vi.fn(async () => undefined)
    await fecharPrsSubstituidosDaEntrega({
      prisma,
      projectId: 'proj-1',
      sessionName: 'sessions/nova',
      numeroDoNovoPr: 3917,
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar,
      onInfo: () => undefined,
      onWarn: () => undefined,
    })
    expect(findMany).toHaveBeenCalled()
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('sessão nova não encontrada → não faz nada (nunca lança)', async () => {
    const findFirst = vi.fn(async () => null)
    const prisma = { devSession: { findFirst } } as unknown as PrismaDevSession
    const comentarEFechar = vi.fn(async () => undefined)
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma,
      projectId: 'proj-1',
      sessionName: 'sessions/fantasma',
      numeroDoNovoPr: 1,
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar,
    })
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('já tem o marcador deste PR novo → idempotente', async () => {
    const { prisma } = prismaFalso({
      sessaoNova: { sessionName: 'sessions/nova', issueNumber: 3884 },
      linhasComPr: [{ pullRequestNumber: 3907 }],
    })
    const comentarEFechar = vi.fn(async () => undefined)
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma,
      projectId: 'proj-1',
      sessionName: 'sessions/nova',
      numeroDoNovoPr: 3917,
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [marcadorDePrSubstituido(3917)],
      comentarEFechar,
    })
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })
})
