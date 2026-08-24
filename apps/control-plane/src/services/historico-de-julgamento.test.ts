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
    event: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  } as PrismaDoHistorico
}

describe('registrarJulgamento', () => {
  it('guarda o julgamento no projeto', async () => {
    const prisma = prismaFake()
    await registrarJulgamento({ prisma, projectId: 'proj_1', peloPortao: true })
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

  // `wingId` NÃO é único global (o schema tem @@unique([userId, wingId])):
  // dois clientes podem cadastrar o mesmo repositório. Procurar o projeto por
  // endereço aqui dentro contaria a reprovação de um dono na conta do outro.
  // Por isso o projeto vem PRONTO de quem chama, que já sabe de quem é.
  it('grava no projeto que recebeu, sem procurar por endereço de repositório', async () => {
    const prisma = prismaFake()
    await registrarJulgamento({ prisma, projectId: 'proj_do_cliente_b', peloPortao: false })
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'proj_do_cliente_b' }),
      })
    )
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
    const h = await lerHistoricoDoProjeto({ prisma, projectId: 'proj_1' })
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
    const h = await lerHistoricoDoProjeto({ prisma, projectId: 'proj_1' })
    expect(h.every((e) => e.peloPortao === false)).toBe(true)
  })

  it('projeto sem julgamento nenhum tem histórico vazio, não erro', async () => {
    const prisma = prismaFake()
    expect(await lerHistoricoDoProjeto({ prisma, projectId: 'proj_novo' })).toEqual([])
  })

  // Lê SÓ deste projeto. Sem o filtro, o histórico de um cliente entraria na
  // conta do outro no mesmo repositório.
  it('filtra pelo projeto que recebeu', async () => {
    const prisma = prismaFake()
    await lerHistoricoDoProjeto({ prisma, projectId: 'proj_a' })
    expect((prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: 'proj_a', type: TIPO_DO_EVENTO },
    })
  })
})
