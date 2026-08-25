import { describe, it, expect, vi } from 'vitest'
import { reservarVagaNaConta, type PrismaDevSession } from './dev-session-store.js'

/**
 * Um banco de mentira que se comporta como o de verdade no que importa aqui:
 * a transação serializa, então duas chamadas concorrentes não veem o mesmo
 * total de vagas ocupadas.
 */
function bancoFalso(vivasIniciais: number, serializa = true) {
  let vivas = vivasIniciais
  let emUso = false
  const fila: Array<() => void> = []

  const base: PrismaDevSession = {
    devSession: {
      count: vi.fn(async () => vivas),
      upsert: vi.fn(async () => {
        vivas += 1
        return undefined
      }),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
  }

  return {
    ...base,
    $transaction: async <T>(fn: (tx: PrismaDevSession) => Promise<T>): Promise<T> => {
      if (!serializa) return fn(base)
      // Serializa de verdade: a segunda espera a primeira terminar, e por isso
      // enxerga a vaga que a primeira acabou de ocupar.
      if (emUso) await new Promise<void>((r) => fila.push(r))
      emUso = true
      try {
        return await fn(base)
      } finally {
        emUso = false
        fila.shift()?.()
      }
    },
    get vivas() {
      return vivas
    },
  }
}

describe('reservarVagaNaConta', () => {
  const comum = {
    projectIdsDaConta: ['p1', 'p2'],
    projectId: 'p1',
    tetoConcorrentes: 15,
    agora: new Date('2026-08-25T22:00:00Z'),
  }

  // O critério da tarefa: duas delegações simultâneas disputando o ÚLTIMO
  // slot, rodando em paralelo de verdade — e exatamente uma passa.
  it('duas delegações simultâneas disputando a última vaga: só uma passa', async () => {
    const banco = bancoFalso(14)
    const [a, b] = await Promise.all([
      reservarVagaNaConta({
        ...comum,
        prisma: banco,
        issueNumber: 1,
        sessionName: 'reserva/p1/1',
      }),
      reservarVagaNaConta({
        ...comum,
        prisma: banco,
        issueNumber: 2,
        sessionName: 'reserva/p1/2',
      }),
    ])
    const passaram = [a, b].filter((r) => r.ok).length
    expect(passaram).toBe(1)
    expect(banco.vivas).toBe(15)
    const recusada = [a, b].find((r) => !r.ok)
    expect(recusada && !recusada.ok && recusada.motivo).toBe('sem-vaga-na-conta')
  })

  // Sem a transação, as duas leem 14 e as duas acham que cabe — o defeito que
  // esta mudança existe para matar. O teste guarda a diferença.
  it('sem transação, as duas furam o teto — é o defeito de antes', async () => {
    const banco = bancoFalso(14, false)
    const [a, b] = await Promise.all([
      reservarVagaNaConta({ ...comum, prisma: banco, issueNumber: 1, sessionName: 'r/1' }),
      reservarVagaNaConta({ ...comum, prisma: banco, issueNumber: 2, sessionName: 'r/2' }),
    ])
    expect([a, b].filter((r) => r.ok).length).toBe(2)
    expect(banco.vivas).toBe(16)
  })

  it('com folga, passa normalmente', async () => {
    const banco = bancoFalso(3)
    const r = await reservarVagaNaConta({
      ...comum,
      prisma: banco,
      issueNumber: 9,
      sessionName: 'reserva/p1/9',
    })
    expect(r.ok).toBe(true)
  })

  it('conta cheia recusa antes de tentar abrir', async () => {
    const banco = bancoFalso(15)
    const r = await reservarVagaNaConta({
      ...comum,
      prisma: banco,
      issueNumber: 9,
      sessionName: 'reserva/p1/9',
    })
    expect(r.ok).toBe(false)
    expect(banco.devSession.upsert).not.toHaveBeenCalled()
  })

  // Abrir sem conferir seria pior que recusar: o produto voltaria a pedir mais
  // do que a conta tem, que é o defeito que isto mata.
  it('sem como contar, recusa em vez de abrir às cegas', async () => {
    const semCount = {
      devSession: {
        upsert: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        updateMany: vi.fn(async () => undefined),
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaDevSession
    const r = await reservarVagaNaConta({
      ...comum,
      prisma: semCount,
      issueNumber: 9,
      sessionName: 'reserva/p1/9',
    })
    expect(r.ok).toBe(false)
  })
})
