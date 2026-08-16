import { describe, expect, test, vi } from 'vitest'
import { aoMesclarUmaEntrega } from './scheduler.js'
import type { LinhaDeSessao, PrismaDevSession } from '../services/dev-session-store.js'

// Tarefa 17 — mesmo motivo de `scheduler-julgamento-opcoes.test.ts` (Tarefas
// 7 e 10): `aoMesclar` já foi um ponto onde a lógica certa existia, testada
// em isolamento em `qa-rails-mission.test.ts`, e ainda assim o call site
// real dentro de `executeMissionWithFailover` (fechamento não exportado)
// podia divergir sem que suíte nenhuma percebesse — foi exatamente esse
// padrão que apagou o aviso de credencial expirada na revisão da Tarefa 16.
//
// `aoMesclarUmaEntrega` é a peça que o closure `aoMesclar:` do scheduler
// agora só REPASSA (uma linha, ver scheduler.ts). Este arquivo prova que ELA
// (não uma cópia solta) chama o `registrarMescla` de VERDADE
// (dev-session-store.ts) e que o resultado NÃO fecha a linha — a regressão
// que esta tarefa existe para nunca deixar voltar (a sessão "concluindo" no
// instante do merge, antes de qualquer veredito sobre a publicação).
function prismaFalso(linha: LinhaDeSessao | null) {
  return {
    devSession: {
      upsert: vi.fn(async (_args: unknown) => undefined),
      update: vi.fn(async (_args: unknown) => undefined),
      updateMany: vi.fn(async (_args: unknown) => undefined),
      findMany: vi.fn(async (_args: unknown) => []),
      findFirst: vi.fn(async (_args: unknown) => linha),
    },
  } as unknown as PrismaDevSession
}

function linha(over: Partial<LinhaDeSessao> = {}): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'proj_1',
    issueNumber: 1,
    sessionName: 'sessions/abc',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: 7,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    ...over,
  }
}

describe('aoMesclarUmaEntrega', () => {
  test('acha a linha viva pelo PR mesclado e GRAVA o commit — não fecha a sessão', async () => {
    const prisma = prismaFalso(linha())
    const agora = new Date('2026-01-01T00:00:00.000Z')

    await aoMesclarUmaEntrega({
      prisma,
      projectId: 'proj_1',
      numeroDoPr: 7,
      mergeCommitSha: 'deadbeef',
      agora,
    })

    expect(prisma.devSession.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'proj_1', pullRequestNumber: 7, closedAt: null },
    })
    // Prova que quem gravou foi `registrarMescla` de dev-session-store.ts
    // (mesmo shape de dados), não uma cópia solta que só parece certa.
    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/abc' },
      data: { mergeCommitSha: 'deadbeef', stateCheckedAt: agora },
    })
    // A regressão desta tarefa: ANTES, este ponto fechava a sessão
    // (`closedAt`/`closedReason: 'merged'`) no instante do merge. Prova
    // negativa — nenhuma chamada de update carrega esses campos.
    for (const chamada of (prisma.devSession.update as ReturnType<typeof vi.fn>).mock.calls) {
      const dados = (chamada[0] as { data: Record<string, unknown> }).data
      expect(dados).not.toHaveProperty('closedAt')
      expect(dados).not.toHaveProperty('closedReason')
    }
  })

  test('sem linha correspondente (PR de humano, ou sessão já fechada): não é falha, nada é gravado', async () => {
    const prisma = prismaFalso(null)

    await aoMesclarUmaEntrega({
      prisma,
      projectId: 'proj_1',
      numeroDoPr: 99,
      mergeCommitSha: 'deadbeef',
      agora: new Date(),
    })

    expect(prisma.devSession.update).not.toHaveBeenCalled()
  })
})

// Importante 4 da revisão final da branch: `aoMesclarUmaEntrega` buscava a
// linha SÓ pelo número do PR e desistia em silêncio. Mas o juiz que
// autorizou o mesmo merge (`qa-rails-mission.ts`, `linhaDaEntrega`) já usa um
// recuo pela ISSUE de origem, documentado ali com um caso real de produção:
// o número do PR às vezes só é gravado minutos depois do merge. Nessa
// janela, sem o mesmo recuo aqui, `mergeCommitSha` nunca era gravado e o
// capítulo pós-merge inteiro (Tarefa 17) era pulado para aquela entrega —
// sem qualquer registro do que aconteceu.
describe('aoMesclarUmaEntrega — Importante 4 (recuo pela issue + aviso, nunca silêncio)', () => {
  function prismaComRotas(porPr: LinhaDeSessao | null, porIssue: LinhaDeSessao | null) {
    return {
      devSession: {
        upsert: vi.fn(async (_args: unknown) => undefined),
        update: vi.fn(async (_args: unknown) => undefined),
        updateMany: vi.fn(async (_args: unknown) => undefined),
        findMany: vi.fn(async (_args: unknown) => []),
        findFirst: vi.fn(
          async (args: { where: { pullRequestNumber?: number; issueNumber?: number } }) => {
            if (args.where.pullRequestNumber !== undefined) return porPr
            if (args.where.issueNumber !== undefined) return porIssue
            return null
          }
        ),
      },
    } as unknown as PrismaDevSession
  }

  test('PR ainda não gravado na linha: acha pela ISSUE de origem e grava o commit (mesmo recuo do juiz)', async () => {
    const linhaPorIssue = linha({ sessionName: 'sessions/por-issue', issueNumber: 99 })
    const prisma = prismaComRotas(null, linhaPorIssue)
    const agora = new Date('2026-01-01T00:00:00.000Z')

    await aoMesclarUmaEntrega({
      prisma,
      projectId: 'proj_1',
      numeroDoPr: 7,
      mergeCommitSha: 'deadbeef',
      issueNumber: 99,
      agora,
    })

    expect(prisma.devSession.findFirst).toHaveBeenNthCalledWith(1, {
      where: { projectId: 'proj_1', pullRequestNumber: 7, closedAt: null },
    })
    expect(prisma.devSession.findFirst).toHaveBeenNthCalledWith(2, {
      where: { projectId: 'proj_1', issueNumber: 99, closedAt: null },
    })
    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/por-issue' },
      data: { mergeCommitSha: 'deadbeef', stateCheckedAt: agora },
    })
  })

  test('sem issueNumber (recuo por login, sem issue conhecida): não tenta o segundo recuo', async () => {
    const prisma = prismaComRotas(null, linha({ sessionName: 'sessions/nunca-achada' }))

    await aoMesclarUmaEntrega({
      prisma,
      projectId: 'proj_1',
      numeroDoPr: 7,
      mergeCommitSha: 'deadbeef',
      issueNumber: null,
      agora: new Date(),
    })

    expect(prisma.devSession.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.devSession.update).not.toHaveBeenCalled()
  })

  test('nem PR nem issue acham a linha: registra o aviso — o capítulo pós-merge não pode ser pulado em silêncio', async () => {
    const prisma = prismaComRotas(null, null)
    const avisos: string[] = []

    await aoMesclarUmaEntrega({
      prisma,
      projectId: 'proj_1',
      numeroDoPr: 42,
      mergeCommitSha: 'deadbeef',
      issueNumber: 7,
      agora: new Date(),
      onWarn: (m) => avisos.push(m),
    })

    expect(prisma.devSession.update).not.toHaveBeenCalled()
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toMatch(/#42/)
    expect(avisos[0]).toMatch(/#7/)
  })
})
