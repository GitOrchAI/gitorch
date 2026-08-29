import { describe, it, expect, vi } from 'vitest'
import {
  registrarJulgamento,
  lerHistoricoDoProjeto,
  lerJanelaDeBarradas,
  registrarJanelaDeBarradas,
  JANELA_DE_JULGAMENTOS,
  TIPO_DO_EVENTO,
  TIPO_DO_AVISO_DE_BARRADAS,
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

// ESTEIRA-T15 — dedupe do aviso de "N entregas barradas" (mesmo mecanismo do
// T11: EstadoDaJanela / aviso-por-janela.ts).
describe('lerJanelaDeBarradas / registrarJanelaDeBarradas', () => {
  it('sem marca nenhuma: janela limpa', async () => {
    const prisma = prismaFake()
    expect(await lerJanelaDeBarradas({ prisma, projectId: 'proj_1' })).toEqual({
      desde: null,
      avisado: false,
    })
  })

  it('última marca diz avisado: true', async () => {
    const prisma = prismaFake({
      event: {
        create: vi.fn(),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { payload: { desde: '2026-08-29T09:00:00Z', avisado: true }, createdAt: new Date() },
          ]),
      },
    })
    expect(await lerJanelaDeBarradas({ prisma, projectId: 'proj_1' })).toEqual({
      desde: new Date('2026-08-29T09:00:00Z'),
      avisado: true,
    })
  })

  it('última marca diz que já limpou (false), mesmo com uma marca "true" mais antiga', async () => {
    const prisma = prismaFake({
      event: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            payload: { desde: null, avisado: false },
            createdAt: new Date('2026-08-29T10:00:00Z'),
          },
          {
            payload: { desde: '2026-08-29T08:00:00Z', avisado: true },
            createdAt: new Date('2026-08-29T09:00:00Z'),
          },
        ]),
      },
    })
    expect(await lerJanelaDeBarradas({ prisma, projectId: 'proj_1' })).toEqual({
      desde: null,
      avisado: false,
    })
  })

  it('grava a marca com o tipo e o projeto certos', async () => {
    const prisma = prismaFake()
    await registrarJanelaDeBarradas({
      prisma,
      projectId: 'proj_1',
      estado: { desde: new Date('2026-08-29T09:00:00Z'), avisado: true },
    })
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          projectId: 'proj_1',
          type: TIPO_DO_AVISO_DE_BARRADAS,
          payload: { desde: '2026-08-29T09:00:00.000Z', avisado: true },
        },
      })
    )
  })

  it('filtra pelo projeto e pelo tipo certo ao ler', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = prismaFake({ event: { create: vi.fn(), findMany } })
    await lerJanelaDeBarradas({ prisma, projectId: 'proj_x' })
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: 'proj_x', type: TIPO_DO_AVISO_DE_BARRADAS },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
  })
})
