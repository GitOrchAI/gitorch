import { describe, it, expect, vi } from 'vitest'
import {
  registrarJulgamento,
  lerHistoricoDoProjeto,
  JANELA_DE_JULGAMENTOS,
  TIPO_DO_EVENTO,
  type PrismaDoHistorico,
} from './historico-de-julgamento.js'

function prismaFake(over: Partial<PrismaDoHistorico> = {}): PrismaDoHistorico {
  return {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj_1' }) },
    event: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  } as PrismaDoHistorico
}

describe('registrarJulgamento', () => {
  it('guarda o julgamento no projeto do repositório', async () => {
    const prisma = prismaFake()
    await registrarJulgamento({
      prisma,
      repositorio: 'loureng/patinhas-3d-crafts',
      peloPortao: true,
    })
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj_1',
          type: TIPO_DO_EVENTO,
          payload: { peloPortao: true },
        }),
      })
    )
  })

  // Inventar um projeto para pendurar o evento seria pior que não guardar.
  it('repositório que não é projeto nosso não vira evento', async () => {
    const prisma = prismaFake({ project: { findFirst: vi.fn().mockResolvedValue(null) } })
    await registrarJulgamento({ prisma, repositorio: 'estranho/repo', peloPortao: true })
    expect(prisma.event.create).not.toHaveBeenCalled()
  })
})

describe('lerHistoricoDoProjeto', () => {
  it('devolve do mais recente para o mais antigo, dentro da janela', async () => {
    const prisma = prismaFake({
      event: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          { payload: { peloPortao: true }, createdAt: new Date('2026-08-24T04:00:00Z') },
          { payload: { peloPortao: false }, createdAt: new Date('2026-08-23T04:00:00Z') },
        ]),
      },
    })
    const h = await lerHistoricoDoProjeto({ prisma, repositorio: 'dono/r' })
    expect(h).toHaveLength(2)
    expect(h[0]?.peloPortao).toBe(true)
    expect(h[1]?.peloPortao).toBe(false)
    expect((prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      orderBy: { createdAt: 'desc' },
      take: JANELA_DE_JULGAMENTOS,
    })
  })

  // Julgamento antigo, de antes deste registro existir. Tratar como "pelo
  // portão" inventaria uma sequência que ninguém mediu.
  it('payload sem a marca NÃO conta como barrado pelo portão', async () => {
    const prisma = prismaFake({
      event: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          { payload: {}, createdAt: new Date() },
          { payload: null, createdAt: new Date() },
          { payload: 'texto solto', createdAt: new Date() },
          { payload: { peloPortao: 'sim' }, createdAt: new Date() },
        ]),
      },
    })
    const h = await lerHistoricoDoProjeto({ prisma, repositorio: 'dono/r' })
    expect(h.every((e) => e.peloPortao === false)).toBe(true)
  })

  it('projeto desconhecido tem histórico vazio, não erro', async () => {
    const prisma = prismaFake({ project: { findFirst: vi.fn().mockResolvedValue(null) } })
    expect(await lerHistoricoDoProjeto({ prisma, repositorio: 'x/y' })).toEqual([])
  })
})
