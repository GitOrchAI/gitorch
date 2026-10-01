import { describe, expect, it } from 'vitest'
import { fecharPrsSubstituidosDaEntrega, ligarPrDaEntrega } from './github-webhook.js'
import type { LinhaDeSessao, PrismaDevSession } from '../services/dev-session-store.js'
import { marcadorDePrSubstituido } from '../services/pr-substituido.js'

// Fluxo da retomada com PR novo, ponta a ponta no que é nosso: a sessão de
// retomada fica registrada com a MESMA issue e o número do PR antigo; quando o
// dev publica o PR NOVO, o webhook o liga a essa sessão e o antigo é fechado
// como substituído. O banco é um armazenamento em memória com as três
// operações que o fluxo usa — nada é "só chamado", o resultado é conferido.

interface Linha {
  sessionName: string
  projectId: string
  issueNumber: number
  pullRequestNumber: number | null
  closedAt: Date | null
}

function bancoEmMemoria(linhas: Linha[]): PrismaDevSession {
  const casa = (l: Linha, where: Record<string, unknown>): boolean => {
    if ('closedAt' in where && where['closedAt'] === null && l.closedAt !== null) return false
    if (where['projectId'] !== undefined && where['projectId'] !== l.projectId) return false
    if (where['issueNumber'] !== undefined && where['issueNumber'] !== l.issueNumber) return false
    if (where['sessionName'] !== undefined && where['sessionName'] !== l.sessionName) return false
    const pr = where['pullRequestNumber'] as { not?: null } | undefined
    if (pr && 'not' in pr && l.pullRequestNumber === null) return false
    return true
  }
  return {
    devSession: {
      findMany: async (args: unknown) =>
        linhas.filter((l) =>
          casa(l, (args as { where: Record<string, unknown> }).where)
        ) as unknown as LinhaDeSessao[],
      findFirst: async (args: unknown) =>
        (linhas.find((l) => casa(l, (args as { where: Record<string, unknown> }).where)) ??
          null) as unknown as LinhaDeSessao | null,
      update: async (args: unknown) => {
        const { where, data } = args as {
          where: { sessionName: string }
          data: { pullRequestNumber?: number }
        }
        const alvo = linhas.find((l) => l.sessionName === where.sessionName)
        if (alvo && data.pullRequestNumber !== undefined) {
          alvo.pullRequestNumber = data.pullRequestNumber
        }
        return alvo
      },
      upsert: async () => undefined,
      updateMany: async () => undefined,
    },
  }
}

const ID_DA_RETOMADA = '12112302527133030906'

describe('retomada com PR novo: o PR antigo é fechado como substituído', () => {
  it('PR novo aberto pela sessão de retomada é ligado à tarefa e o antigo fecha', async () => {
    const linhas: Linha[] = [
      // Sessão original: fechada, dona do PR antigo #3995.
      {
        sessionName: 'sessions/999',
        projectId: 'p1',
        issueNumber: 3987,
        pullRequestNumber: 3995,
        closedAt: new Date('2026-09-20T00:00:00Z'),
      },
      // Sessão de retomada: viva, mesma issue, registrada com o PR antigo.
      {
        sessionName: `sessions/${ID_DA_RETOMADA}`,
        projectId: 'p1',
        issueNumber: 3987,
        pullRequestNumber: 3995,
        closedAt: null,
      },
    ]
    const prisma = bancoEmMemoria(linhas)

    const ligado = await ligarPrDaEntrega({
      prisma,
      projectId: 'p1',
      event: 'pull_request',
      payload: {
        action: 'opened',
        pull_request: { number: 4100, head: { ref: `jules-${ID_DA_RETOMADA}-ab12cd34` } },
      },
    })
    expect(ligado).toEqual({ sessionName: `sessions/${ID_DA_RETOMADA}`, numeroDoPr: 4100 })
    expect(linhas[1]!.pullRequestNumber).toBe(4100)

    const fechados: Array<{ numeroDoPr: number; comentario: string }> = []
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma,
      projectId: 'p1',
      sessionName: ligado!.sessionName,
      numeroDoNovoPr: ligado!.numeroDoPr,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async (n) => ({ aberto: n === 3995, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar: async (a) => {
        fechados.push(a)
      },
    })

    expect(r).toEqual([3995])
    expect(fechados).toHaveLength(1)
    expect(fechados[0]!.numeroDoPr).toBe(3995)
    expect(fechados[0]!.comentario).toContain('#4100')
    expect(fechados[0]!.comentario).toContain(marcadorDePrSubstituido(4100))
  })

  it('PR de gente na mesma issue nunca é fechado, mesmo com o PR novo da retomada', async () => {
    const linhas: Linha[] = [
      {
        sessionName: 'sessions/999',
        projectId: 'p1',
        issueNumber: 3987,
        pullRequestNumber: 3995,
        closedAt: new Date('2026-09-20T00:00:00Z'),
      },
      {
        sessionName: `sessions/${ID_DA_RETOMADA}`,
        projectId: 'p1',
        issueNumber: 3987,
        pullRequestNumber: 4100,
        closedAt: null,
      },
    ]
    const fechados: number[] = []
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma: bancoEmMemoria(linhas),
      projectId: 'p1',
      sessionName: `sessions/${ID_DA_RETOMADA}`,
      numeroDoNovoPr: 4100,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async () => ({ aberto: true, ehDoDev: false }),
      comentariosDoPr: async () => [],
      comentarEFechar: async (a) => {
        fechados.push(a.numeroDoPr)
      },
    })
    expect(r).toEqual([])
    expect(fechados).toEqual([])
  })
})
