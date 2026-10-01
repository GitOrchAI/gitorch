import { describe, it, expect, vi } from 'vitest'
import { tudoSobreOItem, montarContextoDoItem } from './tudo-sobre-o-item.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'

function prismaFake(linha: unknown) {
  return {
    repoItem: { findFirst: vi.fn(async () => linha) },
  }
}

const LINHA_SEM_VINCULOS = {
  id: 'item-1',
  projectId: 'proj-1',
  tipo: 'pr',
  numero: 580,
  estado: { status: 'aberto' },
  origem: 'jules_gitorch',
  issueNumber: 200,
  entendimento: null,
  vinculos: null,
}

const VINCULOS_COMPLETOS = {
  id: 'v1',
  repoItemId: 'item-1',
  hierarquia: {
    parents: [
      { number: 578, title: 'Épico pai', state: 'OPEN' },
      { number: 200, title: 'Épico avô', state: 'CLOSED' },
    ],
    subIssues: [],
  },
  milestone: { title: 'Sprint 1', number: 3, dueOn: '2026-08-13T00:00:00Z', state: 'OPEN' },
  projectFields: [
    {
      project: { id: 'PVT_1', title: 'Board' },
      status: 'Done',
      iteration: { title: 'Sprint 1', startDate: '2026-09-26', duration: 3 },
      peso: 2,
      fields: [],
    },
  ],
  labelsAndAssignees: { labels: ['bug', 'urgent'], assignees: ['loureng'] },
  prsLigados: { closedByPullRequests: [583], crossReferencedPullRequests: [848, 583] },
  sessoesJules: [
    {
      sessionName: 'sessions/1',
      issueNumber: 200,
      pullRequestNumber: 580,
      state: 'COMPLETED',
      closedAt: null,
    },
  ],
  qaReview: {
    state: 'APPROVED',
    headSha: 'sha1',
    resumo: `${MARCA_DO_PARECER}\nok tudo certo`,
    submittedAt: '2026-09-02T00:00:00Z',
  },
  statusCheckRollup: 'SUCCESS',
}

const VINCULOS_VAZIOS = {
  id: 'v2',
  repoItemId: 'item-2',
  hierarquia: { parents: [], subIssues: [] },
  milestone: null,
  projectFields: [],
  labelsAndAssignees: { labels: [], assignees: [] },
  prsLigados: { closedByPullRequests: [], crossReferencedPullRequests: [] },
  sessoesJules: [],
  qaReview: null,
  statusCheckRollup: null,
}

describe('tudoSobreOItem', () => {
  it('item não encontrado devolve null', async () => {
    const prisma = prismaFake(null)
    const r = await tudoSobreOItem({
      prisma: prisma as unknown as Parameters<typeof tudoSobreOItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 999,
    })
    expect(r).toBeNull()
    expect(prisma.repoItem.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'proj-1', numero: 999, tipo: { in: ['issue', 'pr'] } },
      include: { vinculos: true },
    })
  })

  it('item com ficha mas sem grafo ainda: vinculos null', async () => {
    const prisma = prismaFake(LINHA_SEM_VINCULOS)
    const r = await tudoSobreOItem({
      prisma: prisma as unknown as Parameters<typeof tudoSobreOItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r).not.toBeNull()
    expect(r?.vinculos).toBeNull()
    expect(r?.origem).toBe('jules_gitorch')
    expect(r?.issueNumber).toBe(200)
  })

  it('item completo: traz a ficha e o grafo inteiro', async () => {
    const prisma = prismaFake({ ...LINHA_SEM_VINCULOS, vinculos: VINCULOS_COMPLETOS })
    const r = await tudoSobreOItem({
      prisma: prisma as unknown as Parameters<typeof tudoSobreOItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r?.vinculos?.milestone).toEqual(VINCULOS_COMPLETOS.milestone)
    expect(r?.vinculos?.sessoesJules).toEqual(VINCULOS_COMPLETOS.sessoesJules)
    expect(r?.vinculos?.statusCheckRollup).toBe('SUCCESS')
  })
})

describe('montarContextoDoItem', () => {
  it('item não encontrado: null', async () => {
    const prisma = prismaFake(null)
    const r = await montarContextoDoItem({
      prisma: prisma as unknown as Parameters<typeof montarContextoDoItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 999,
    })
    expect(r).toBeNull()
  })

  it('ficha sem grafo ainda: null (nada a acrescentar)', async () => {
    const prisma = prismaFake(LINHA_SEM_VINCULOS)
    const r = await montarContextoDoItem({
      prisma: prisma as unknown as Parameters<typeof montarContextoDoItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r).toBeNull()
  })

  it('grafo completo: todas as linhas aparecem, formatação correta', async () => {
    const prisma = prismaFake({ ...LINHA_SEM_VINCULOS, vinculos: VINCULOS_COMPLETOS })
    const r = await montarContextoDoItem({
      prisma: prisma as unknown as Parameters<typeof montarContextoDoItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r).not.toBeNull()
    expect(r?.linhas).toEqual([
      'Hierarquia: #578 (aberta) → #200 (fechada)',
      'Milestone: Sprint 1 (prazo 2026-08-13, OPEN)',
      'Quadro Board: status=Done, sprint=Sprint 1 (2026-09-26, 3d), peso=2',
      'Labels: bug, urgent',
      'PRs ligados: #583, #848',
      'Sessões do Jules: 1 (ex.: sessions/1 state=COMPLETED)',
      'Último parecer do QA: APPROVED em 2026-09-02T00:00:00Z: ok tudo certo',
      'CI: SUCCESS',
    ])
    expect(r?.bloco).toBe(['Grafo de vínculos do item #580:', ...(r?.linhas ?? [])].join('\n'))
    // a marca interna do parecer nunca vaza pro texto humano
    expect(r?.bloco).not.toContain(MARCA_DO_PARECER)
  })

  it('grafo com campos vazios/nulos: linhas correspondentes omitidas, nunca "undefined"/"null" no texto', async () => {
    const prisma = prismaFake({ ...LINHA_SEM_VINCULOS, vinculos: VINCULOS_VAZIOS })
    const r = await montarContextoDoItem({
      prisma: prisma as unknown as Parameters<typeof montarContextoDoItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r).not.toBeNull()
    expect(r?.linhas).toEqual([])
    expect(r?.bloco).toBe('Grafo de vínculos do item #580:')
    expect(r?.bloco).not.toMatch(/undefined/)
    expect(r?.bloco).not.toMatch(/\bnull\b/)
  })

  it('nunca lança: erro interno (findFirst rejeita) vira null', async () => {
    const prisma = {
      repoItem: { findFirst: vi.fn(async () => Promise.reject(new Error('db explodiu'))) },
    }
    const r = await montarContextoDoItem({
      prisma: prisma as unknown as Parameters<typeof montarContextoDoItem>[0]['prisma'],
      projectId: 'proj-1',
      numero: 580,
    })
    expect(r).toBeNull()
  })
})
