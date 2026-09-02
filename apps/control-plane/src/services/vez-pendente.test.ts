import { describe, it, expect, vi } from 'vitest'
import {
  registrarBastaoPendente,
  removerBastaoPendente,
  retomarVezesPendentesNoBoot,
  TENTATIVAS_MAX_NO_BOOT,
  TIPO_EVENTO_VEZ_PENDENTE_ABANDONADA,
  type VezPendenteRow,
} from './vez-pendente.js'

// D16: a fila de bastão (passar-o-bastao.ts) vive num Set em memória — some
// a cada restart do control-plane, e um bastão perdido custa até 9h de
// espera com o trabalho já pronto. Este módulo é a metade persistida: espelha
// em VezPendente o que passagemDeBastao.passar() já faz em memória, e no
// boot devolve a fila para o processo novo, disparando o papel seguinte na
// hora — sem esperar cron nem tique.

function fakePrisma() {
  return {
    vezPendente: {
      upsert: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      findMany: vi.fn(async (_args: unknown): Promise<VezPendenteRow[]> => []),
      update: vi.fn(async (_args: unknown) => ({ tentativas: 1 })),
    },
    event: {
      create: vi.fn(async (_args: unknown) => ({})),
    },
  }
}

/** Fila de vez pendente já com as linhas dadas — para os testes de boot. */
function prismaComFila(rows: VezPendenteRow[]) {
  const prisma = fakePrisma()
  prisma.vezPendente.findMany = vi.fn(async () => rows)
  return prisma
}

const UMA_LINHA: VezPendenteRow[] = [
  { id: 'v1', projectId: 'proj1', agentRole: 'po', tentativas: 0 },
]

const fakeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('registrarBastaoPendente — espelha passagemDeBastao.passar() no banco', () => {
  it('RA que termina persiste a vez do PO', async () => {
    const prisma = fakePrisma()
    await registrarBastaoPendente(prisma, 'ra', 'proj1')
    expect(prisma.vezPendente.upsert).toHaveBeenCalledWith({
      where: { projectId_agentRole: { projectId: 'proj1', agentRole: 'po' } },
      create: { projectId: 'proj1', agentRole: 'po' },
      update: {},
    })
  })

  it('papel sem seguinte (sm, qa) não escreve nada — mesma regra de PROXIMO_PAPEL', async () => {
    const prisma = fakePrisma()
    await registrarBastaoPendente(prisma, 'sm', 'proj1')
    await registrarBastaoPendente(prisma, 'qa', 'proj1')
    expect(prisma.vezPendente.upsert).not.toHaveBeenCalled()
  })

  it('upsert usa update:{} — reenfileirar não reseta o contador de tentativas de quem já esperava', async () => {
    const prisma = fakePrisma()
    await registrarBastaoPendente(prisma, 'po', 'proj1')
    const arg = prisma.vezPendente.upsert.mock.calls[0]?.[0] as { update: unknown }
    expect(arg.update).toEqual({})
  })
})

describe('removerBastaoPendente — a vez foi honrada, a linha não precisa mais sobreviver a um restart', () => {
  it('apaga por projeto+papel', async () => {
    const prisma = fakePrisma()
    await removerBastaoPendente(prisma, 'po', 'proj1')
    expect(prisma.vezPendente.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'proj1', agentRole: 'po' },
    })
  })
})

describe('retomarVezesPendentesNoBoot — a PROVA do D16: disparar sozinho na subida', () => {
  it('fila vazia: não dispara nada', async () => {
    const prisma = fakePrisma()
    const disparar = vi.fn()
    const devolver = vi.fn()
    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())
    expect(disparar).not.toHaveBeenCalled()
  })

  it('vez pendente dispara o papel seguinte IMEDIATAMENTE, sem esperar tique nem cron', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => ({ triggered: true, missionId: 'm1' }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())

    expect(disparar).toHaveBeenCalledWith('po', 'proj1')
  })

  it('disparo com sucesso: a vez foi honrada, a linha é apagada e ninguém é devolvido à fila', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => ({ triggered: true, missionId: 'm1' }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())

    expect(prisma.vezPendente.deleteMany).toHaveBeenCalledWith({ where: { id: 'v1' } })
    expect(devolver).not.toHaveBeenCalled()
  })

  it('recusa TEMPORÁRIA (motivo retryable): a linha SOBREVIVE e a vez volta para a fila em memória — o mesmo processo tenta de novo no próximo tique', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => ({ triggered: false, reason: 'busy' }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set(['busy']))

    expect(prisma.vezPendente.deleteMany).not.toHaveBeenCalled()
    expect(devolver).toHaveBeenCalledWith({ papel: 'po', projectId: 'proj1' })
  })

  it('recusa DEFINITIVA (motivo fora do conjunto retryable): a vez foi honrada (tentada de verdade) — a linha é apagada mesmo sem sucesso, e não devolve à fila', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => ({ triggered: false, reason: 'no-project' }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set(['busy']))

    expect(prisma.vezPendente.deleteMany).toHaveBeenCalledWith({ where: { id: 'v1' } })
    expect(devolver).not.toHaveBeenCalled()
  })

  it('cada retomada no boot incrementa tentativas ANTES de disparar (tentativas conta BOOTS, não recusas)', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => ({ triggered: false, reason: 'busy' }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set(['busy']))

    expect(prisma.vezPendente.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { tentativas: { increment: 1 } },
    })
  })

  it('NUNCA CRIA LAÇO: teto de tentativas esgotado desiste, escreve o motivo em Event e NÃO dispara de novo', async () => {
    const prisma = prismaComFila([
      { id: 'v1', projectId: 'proj1', agentRole: 'po', tentativas: TENTATIVAS_MAX_NO_BOOT },
    ])
    const disparar = vi.fn()
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())

    expect(disparar).not.toHaveBeenCalled()
    expect(prisma.vezPendente.deleteMany).toHaveBeenCalledWith({ where: { id: 'v1' } })
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj1',
          type: TIPO_EVENTO_VEZ_PENDENTE_ABANDONADA,
        }),
      })
    )
  })

  it('papel desconhecido gravado na linha (defeito de dado, nunca deve crashar o boot): avisa e pula, não derruba as demais', async () => {
    const prisma = prismaComFila([
      { id: 'v1', projectId: 'proj1', agentRole: 'dev-inexistente', tentativas: 0 },
      { id: 'v2', projectId: 'proj2', agentRole: 'po', tentativas: 0 },
    ])
    const disparar = vi.fn(async () => ({ triggered: true }))
    const devolver = vi.fn()

    await retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())

    expect(disparar).toHaveBeenCalledTimes(1)
    expect(disparar).toHaveBeenCalledWith('po', 'proj2')
  })

  it('disparo que rejeita (nunca deveria, mas defensivo): tratado como retryable "error" — nunca derruba o boot', async () => {
    const prisma = prismaComFila(UMA_LINHA)
    const disparar = vi.fn(async () => {
      throw new Error('rede caiu')
    })
    const devolver = vi.fn()

    await expect(
      retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set(['error']))
    ).resolves.toBeUndefined()

    expect(devolver).toHaveBeenCalledWith({ papel: 'po', projectId: 'proj1' })
    expect(prisma.vezPendente.deleteMany).not.toHaveBeenCalled()
  })

  it('leitura do banco falhando: loga e não derruba o boot (tenta de novo no próximo restart)', async () => {
    const prisma = fakePrisma()
    prisma.vezPendente.findMany = vi.fn(async () => {
      throw new Error('banco fora do ar')
    })
    const disparar = vi.fn()
    const devolver = vi.fn()

    await expect(
      retomarVezesPendentesNoBoot(prisma, fakeLog, disparar, devolver, new Set())
    ).resolves.toBeUndefined()
    expect(disparar).not.toHaveBeenCalled()
  })
})
