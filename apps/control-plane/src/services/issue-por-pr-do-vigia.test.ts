import { describe, it, expect, vi } from 'vitest'
import { carregarIssuePorPr, type BancoDoIssuePorPr } from './issue-por-pr-do-vigia.js'

interface LinhaDeSessaoFake {
  pullRequestNumber: number | null
  issueNumber: number
  closedAt: Date | null
}
interface FichaFake {
  numero: number
  origem: string | null
  issueNumber: number | null
}

function banco(linhas: LinhaDeSessaoFake[], fichas: FichaFake[]) {
  const lerFichas = vi.fn(async () => fichas)
  const db: BancoDoIssuePorPr = {
    devSession: { findMany: async () => linhas },
    repoItem: { findMany: lerFichas },
  }
  return { db, lerFichas }
}

describe('carregarIssuePorPr', () => {
  it('PR sem sessão ligada cai para a ficha: #583 → issue 580 (jules_gitorch)', async () => {
    const { db } = banco([], [{ numero: 583, origem: 'jules_gitorch', issueNumber: 580 }])
    const r = await carregarIssuePorPr(db, 'p1')
    expect(r.issuePorPr.get(583)).toBe(580)
  })

  it('a sessão do dev manda: quando as duas têm o PR, vale a issue da sessão', async () => {
    const { db } = banco(
      [{ pullRequestNumber: 583, issueNumber: 111, closedAt: new Date() }],
      [{ numero: 583, origem: 'jules_gitorch', issueNumber: 580 }]
    )
    const r = await carregarIssuePorPr(db, 'p1')
    expect(r.issuePorPr.get(583)).toBe(111)
  })

  it('linhas em ordem id desc: a primeira (mais nova) do PR vence, como antes', async () => {
    const { db } = banco(
      [
        { pullRequestNumber: 5, issueNumber: 50, closedAt: null },
        { pullRequestNumber: 5, issueNumber: 40, closedAt: new Date() },
      ],
      []
    )
    const r = await carregarIssuePorPr(db, 'p1')
    expect(r.issuePorPr.get(5)).toBe(50)
  })

  it('ficha jules_fora ou sem origem NÃO vira issue (baixa confiança) — o PR segue sem origem', async () => {
    const { db } = banco(
      [],
      [
        { numero: 690, origem: 'jules_fora', issueNumber: 12 },
        { numero: 64, origem: null, issueNumber: 13 },
        { numero: 132, origem: 'jules_gitorch', issueNumber: null },
      ]
    )
    const r = await carregarIssuePorPr(db, 'p1')
    expect(r.issuePorPr.has(690)).toBe(false)
    expect(r.issuePorPr.has(64)).toBe(false)
    expect(r.issuePorPr.has(132)).toBe(false)
  })

  it('lê as fichas UMA vez por projeto, filtrando tipo pr e issue preenchida', async () => {
    const { db, lerFichas } = banco(
      [],
      [
        { numero: 1, origem: 'pessoa', issueNumber: 10 },
        { numero: 2, origem: 'jules_gitorch', issueNumber: 20 },
        { numero: 3, origem: 'assistente', issueNumber: 30 },
      ]
    )
    const r = await carregarIssuePorPr(db, 'proj-x')
    expect(lerFichas).toHaveBeenCalledTimes(1)
    expect(lerFichas).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'proj-x', tipo: 'pr', issueNumber: { not: null } },
      })
    )
    expect([...r.issuePorPr.entries()]).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ])
  })

  it('prsComSessaoViva só tem PR de linha viva (closedAt nulo) — a ficha não conta como sessão viva', async () => {
    const { db } = banco(
      [
        { pullRequestNumber: 7, issueNumber: 70, closedAt: null },
        { pullRequestNumber: 8, issueNumber: 80, closedAt: new Date() },
      ],
      [{ numero: 9, origem: 'jules_gitorch', issueNumber: 90 }]
    )
    const r = await carregarIssuePorPr(db, 'p1')
    expect([...r.prsComSessaoViva]).toEqual([7])
  })
})
