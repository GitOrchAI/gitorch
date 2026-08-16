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
