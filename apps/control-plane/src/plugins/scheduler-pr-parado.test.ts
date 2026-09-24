import { describe, expect, it, vi, beforeEach } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import { varrerRespostasPrParado } from './scheduler.js'
import { processarRespostaPrParado } from '../services/processar-resposta-pr-parado.js'

vi.mock('../services/processar-resposta-pr-parado.js', () => ({
  processarRespostaPrParado: vi.fn(),
}))

vi.mock('../services/project-credential.js', () => ({
  lerCredencialQueAlcancaOProjeto: vi.fn().mockResolvedValue('fake-token'),
}))

vi.mock('../services/guarda-de-autonomia.js', () => ({
  fetchDoRepositorio: vi.fn().mockReturnValue(vi.fn()),
}))

vi.mock('../services/perguntar-se-cuida.js', () => ({
  DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO: 'cuida-deste-pedido:',
}))

describe('Scheduler PR Parado - varrerRespostasPrParado', () => {
  let app: FastifyInstance
  let findManyMock: ReturnType<typeof vi.fn>
  let updateMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    app = fastify()
    findManyMock = vi.fn()
    updateMock = vi.fn()

    app.decorate('prisma', {
      agentQuestion: {
        findMany: findManyMock,
        update: updateMock,
      },
      project: {},
      devSession: {
        findFirst: vi.fn(),
      },
      event: {
        create: vi.fn(),
      },
    } as unknown as import('@prisma/client').PrismaClient)
    app.decorate('engineConnections', {
      has: vi.fn(),
    } as unknown as never) // actually let's use the correct type
  })

  it('deve consumir agentQuestion com status answered e prefixo de PR parado e chamar mesclarPr', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: 'q1',
        answer: 'pr-parado-mesclar',
        dedupKey: 'cuida-deste-pedido:owner/repo:42',
        project: { id: 'p1', wingId: 'owner/repo', userId: 'u1', autonomia: 'total' },
      },
    ])

    await varrerRespostasPrParado(app)

    expect(processarRespostaPrParado).toHaveBeenCalled()
    const callArgs = vi.mocked(processarRespostaPrParado).mock.calls[0]
    expect(callArgs![0]).toEqual({
      dedupKey: 'cuida-deste-pedido:owner/repo:42',
      resposta: 'pr-parado-mesclar',
    })
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { status: 'processed' } })
  })

  it('deve pedir ajuste', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: 'q2',
        answer: 'pr-parado-pedir-ajuste',
        dedupKey: 'cuida-deste-pedido:owner/repo:43',
        project: { id: 'p2', wingId: 'owner/repo', userId: 'u1', autonomia: 'total' },
      },
    ])

    await varrerRespostasPrParado(app)

    expect(processarRespostaPrParado).toHaveBeenCalled()
    const callArgs = vi.mocked(processarRespostaPrParado).mock.calls[0]
    expect(callArgs![0]).toEqual({
      dedupKey: 'cuida-deste-pedido:owner/repo:43',
      resposta: 'pr-parado-pedir-ajuste',
    })
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'q2' }, data: { status: 'processed' } })
  })

  it('deve fechar', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: 'q3',
        answer: 'pr-parado-fechar',
        dedupKey: 'cuida-deste-pedido:owner/repo:44',
        project: { id: 'p3', wingId: 'owner/repo', userId: 'u1', autonomia: 'total' },
      },
    ])

    await varrerRespostasPrParado(app)

    expect(processarRespostaPrParado).toHaveBeenCalled()
    const callArgs = vi.mocked(processarRespostaPrParado).mock.calls[0]
    expect(callArgs![0]).toEqual({
      dedupKey: 'cuida-deste-pedido:owner/repo:44',
      resposta: 'pr-parado-fechar',
    })
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'q3' }, data: { status: 'processed' } })
  })
})
