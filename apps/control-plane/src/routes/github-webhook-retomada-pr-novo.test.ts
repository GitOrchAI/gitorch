import { describe, expect, it } from 'vitest'
import { fecharPrsSubstituidosDaEntrega, ligarPrDaEntrega } from './github-webhook.js'
import type { LinhaDeSessao, PrismaDevSession } from '../services/dev-session-store.js'
import { marcadorDePrSubstituido } from '../services/pr-substituido.js'
import {
  ehEntregaDoDevOuAssumida,
  prsAssumidosDaIssue,
  type ContadorDeEventos,
} from '../services/vigia-do-pr.js'

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

describe('PR da conta do dono que o vigia assumiu: o novo o substitui', () => {
  const linhas = (): Linha[] => [
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

  // O PR antigo é da conta do dono: nenhum sinal de automação nele.
  const SINAIS_DO_DONO = { autor: 'dono', labels: [], corpo: null }

  function eventos(retomadasDoVigia: number[]): ContadorDeEventos {
    return {
      event: {
        count: async ({ where }) => {
          const equals = (
            (where.AND as Array<{ payload?: { equals?: unknown } }> | undefined)?.[0]?.payload ?? {}
          ).equals
          const numero = (where.payload as { equals?: unknown } | undefined)?.equals
          return equals === 'retomar' && retomadasDoVigia.includes(numero as number) ? 1 : 0
        },
      },
    }
  }

  async function substituir(retomadasDoVigia: number[]) {
    const fechados: Array<{ numeroDoPr: number; comentario: string }> = []
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma: bancoEmMemoria(linhas()),
      projectId: 'p1',
      sessionName: `sessions/${ID_DA_RETOMADA}`,
      numeroDoNovoPr: 4100,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async (n) => ({
        aberto: true,
        ehDoDev: await ehEntregaDoDevOuAssumida(eventos(retomadasDoVigia), {
          projectId: 'p1',
          numeroDoPr: n,
          sinais: SINAIS_DO_DONO,
        }),
      }),
      comentariosDoPr: async () => [],
      comentarEFechar: async (a) => {
        fechados.push(a)
      },
    })
    return { r, fechados }
  }

  it('assumido pelo vigia: o PR novo (base principal, com arquivos) fecha o do dono, dizendo qual o substituiu', async () => {
    const { r, fechados } = await substituir([3995])
    expect(r).toEqual([3995])
    expect(fechados[0]!.comentario).toContain('Substituído por #4100')
    expect(fechados[0]!.comentario).toContain(marcadorDePrSubstituido(4100))
  })

  it('nunca assumido pelo vigia: o PR da conta do dono continua aberto', async () => {
    const { r, fechados } = await substituir([])
    expect(r).toEqual([])
    expect(fechados).toHaveLength(0)
  })
})

describe('PR do dono sem sessão original: o registro do vigia diz qual PR substituir', () => {
  // A retomada grava a sessão com o número do PR do dono; quando o PR novo é
  // ligado, a linha passa a apontar para o novo e o número do dono some de
  // `dev_sessions`. Sem outra pista, o PR do dono nunca seria achado.
  const sessaoDaRetomada: Linha = {
    sessionName: `sessions/${ID_DA_RETOMADA}`,
    projectId: 'p1',
    issueNumber: 3987,
    pullRequestNumber: 4100,
    closedAt: null,
  }

  const eventosDoVigia = [
    {
      projectId: 'p1',
      payload: { vigiaDoPr: { numeroDoPr: 3995, acao: 'retomar', issueNumber: 3987 } },
    },
    {
      projectId: 'p1',
      payload: { vigiaDoPr: { numeroDoPr: 3996, acao: 'retomar', issueNumber: 5000 } },
    },
    {
      projectId: 'p1',
      payload: { vigiaDoPr: { numeroDoPr: 3997, acao: 'escalar', issueNumber: 3987 } },
    },
    {
      projectId: 'p2',
      payload: { vigiaDoPr: { numeroDoPr: 3998, acao: 'retomar', issueNumber: 3987 } },
    },
  ]

  const bancoDeEventos = {
    event: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          projectId: string
          AND: Array<{ payload: { path: string[]; equals: unknown } }>
        }
        return eventosDoVigia.filter(
          (e) =>
            e.projectId === where.projectId &&
            where.AND.every(
              (f) =>
                (e.payload.vigiaDoPr as Record<string, unknown>)[f.payload.path[1]!] ===
                f.payload.equals
            )
        )
      },
    },
  }

  it('acha só as retomadas do vigia daquela tarefa, naquele projeto', async () => {
    expect(
      await prsAssumidosDaIssue(bancoDeEventos, { projectId: 'p1', issueNumber: 3987 })
    ).toEqual([3995])
  })

  it('o PR novo fecha o do dono achado pelo registro do vigia, mesmo sem sessão original', async () => {
    const fechados: number[] = []
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma: bancoEmMemoria([sessaoDaRetomada]),
      projectId: 'p1',
      sessionName: sessaoDaRetomada.sessionName,
      numeroDoNovoPr: 4100,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar: async (a) => {
        fechados.push(a.numeroDoPr)
      },
      prsAssumidosDaIssue: (issueNumber) =>
        prsAssumidosDaIssue(bancoDeEventos, { projectId: 'p1', issueNumber }),
    })
    expect(r).toEqual([3995])
    expect(fechados).toEqual([3995])
  })

  it('sem a pista do vigia, o PR do dono não é achado (o que faltava)', async () => {
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma: bancoEmMemoria([sessaoDaRetomada]),
      projectId: 'p1',
      sessionName: sessaoDaRetomada.sessionName,
      numeroDoNovoPr: 4100,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar: async () => undefined,
    })
    expect(r).toEqual([])
  })

  it('o PR novo nunca é candidato a ser fechado por ele mesmo', async () => {
    const eventos = {
      event: {
        findMany: async () => [
          { payload: { vigiaDoPr: { numeroDoPr: 4100, acao: 'retomar', issueNumber: 3987 } } },
        ],
      },
    }
    const r = await fecharPrsSubstituidosDaEntrega({
      prisma: bancoEmMemoria([sessaoDaRetomada]),
      projectId: 'p1',
      sessionName: sessaoDaRetomada.sessionName,
      numeroDoNovoPr: 4100,
      branchPadrao: 'main',
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [],
      comentarEFechar: async () => undefined,
      prsAssumidosDaIssue: (issueNumber) =>
        prsAssumidosDaIssue(eventos, { projectId: 'p1', issueNumber }),
    })
    expect(r).toEqual([])
  })
})
