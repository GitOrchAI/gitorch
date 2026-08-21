import { describe, expect, it, vi } from 'vitest'
import { ligarPrDaEntrega } from './github-webhook.js'
import type { PrismaDevSession } from '../services/dev-session-store.js'

/**
 * O aviso REAL do GitHub para o PR #132 (20/08/2026, 16:58), reduzido ao que
 * este caminho lê. O branch carrega o identificador da sessão; o corpo repete.
 */
function avisoDePrAberto(over: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    pull_request: {
      number: 132,
      body:
        'Fix Dependabot schema validation by using native pnpm support.\n\n---\n' +
        '*PR created automatically by Jules for task [12112302527133030906]' +
        '(https://jules.google.com/task/12112302527133030906) started by @loureng*',
      head: { ref: 'jules-12112302527133030906-e9d57552' },
    },
    ...over,
  }
}

/** Banco de mentira com o mínimo que o caminho usa, e que registra as chamadas. */
function prismaFalso(linhas: Array<Record<string, unknown>>) {
  const update = vi.fn(async () => undefined)
  const findMany = vi.fn(async () => linhas)
  return {
    prisma: { devSession: { findMany, update } } as unknown as PrismaDevSession,
    update,
    findMany,
  }
}

const SESSAO_VIVA = {
  id: 'cmt1r48lq003x7pe7eo8pkec5',
  projectId: 'proj-1',
  issueNumber: 127,
  sessionName: 'sessions/12112302527133030906',
  state: 'IN_PROGRESS',
  pullRequestNumber: null,
}

describe('ligarPrDaEntrega', () => {
  it('grava a ligação no instante em que o PR do dev nasce', async () => {
    const { prisma, update } = prismaFalso([SESSAO_VIVA])

    const r = await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: avisoDePrAberto(),
      agora: new Date('2026-08-20T16:58:00Z'),
    })

    expect(r).toEqual({ sessionName: 'sessions/12112302527133030906', numeroDoPr: 132 })
    expect(update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/12112302527133030906' },
      data: { pullRequestNumber: 132, stateCheckedAt: new Date('2026-08-20T16:58:00Z') },
    })
  })

  it('vale também para PR reaberto', async () => {
    const { prisma, update } = prismaFalso([SESSAO_VIVA])
    const r = await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: avisoDePrAberto({ action: 'reopened' }),
    })
    expect(r).not.toBeNull()
    expect(update).toHaveBeenCalledOnce()
  })

  it('não grava de novo quando a sessão já aponta para este mesmo PR', async () => {
    const { prisma, update } = prismaFalso([{ ...SESSAO_VIVA, pullRequestNumber: 132 }])
    const r = await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: avisoDePrAberto(),
    })
    expect(r).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('pull request de humano não vira entrega do produto', async () => {
    const { prisma, update } = prismaFalso([SESSAO_VIVA])
    const r = await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: {
        action: 'opened',
        pull_request: {
          number: 99,
          body: 'Corrige o rodapé. Fixes #74',
          head: { ref: 'fix/rodape' },
        },
      },
    })
    expect(r).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('ignora eventos que não são de pull request aberto', async () => {
    const { prisma, findMany } = prismaFalso([SESSAO_VIVA])
    for (const caso of [
      { event: 'issues', payload: avisoDePrAberto() },
      { event: 'pull_request', payload: avisoDePrAberto({ action: 'synchronize' }) },
      { event: 'pull_request', payload: avisoDePrAberto({ action: 'closed' }) },
    ]) {
      const r = await ligarPrDaEntrega({ prisma, projectId: 'proj-1', ...caso })
      expect(r).toBeNull()
    }
    // Nem sequer consulta o banco nesses casos.
    expect(findMany).not.toHaveBeenCalled()
  })

  it('projeto sem nenhuma sessão viva não consulta casamento nenhum', async () => {
    const { prisma, update } = prismaFalso([])
    const r = await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: avisoDePrAberto(),
    })
    expect(r).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('só olha as sessões DO PROJETO do aviso — produto multi-inquilino', async () => {
    const { prisma, findMany } = prismaFalso([SESSAO_VIVA])
    await ligarPrDaEntrega({
      prisma,
      projectId: 'proj-1',
      event: 'pull_request',
      payload: avisoDePrAberto(),
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { closedAt: null, projectId: 'proj-1' } })
    )
  })
})
