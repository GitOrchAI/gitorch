import { describe, it, expect, vi } from 'vitest'
import { tudoSobreOItem, montarContextoDoItem } from './tudo-sobre-o-item.js'

describe('tudoSobreOItem', () => {
  it('retorna null se o item não existe', async () => {
    const prisma = {
      repoItem: { findUnique: vi.fn().mockResolvedValue(null) },
      repoItemVinculos: { findUnique: vi.fn() },
    }
    const result = await tudoSobreOItem({
      prisma: prisma as never,
      projectId: 'proj-1',
      tipo: 'issue',
      numero: 1,
    })
    expect(result).toBeNull()
  })

  it('retorna o item e seus vínculos se existirem', async () => {
    const fakeItem = {
      id: 'item-1',
      projectId: 'proj-1',
      tipo: 'issue',
      numero: 1,
      estado: {},
      origem: null,
      issueNumber: null,
      entendimento: null,
    }
    const fakeVinculos = {
      id: 'v-1',
      repoItemId: 'item-1',
      hierarquia: { parents: [] },
      milestone: null,
      projectFields: null,
      labelsAndAssignees: null,
      prsLigados: null,
      sessoesJules: null,
    }

    const prisma = {
      repoItem: { findUnique: vi.fn().mockResolvedValue(fakeItem) },
      repoItemVinculos: { findUnique: vi.fn().mockResolvedValue(fakeVinculos) },
    }

    const result = await tudoSobreOItem({
      prisma: prisma as never,
      projectId: 'proj-1',
      tipo: 'issue',
      numero: 1,
    })

    expect(result).toEqual({ item: fakeItem, vinculos: fakeVinculos })
    expect(prisma.repoItemVinculos.findUnique).toHaveBeenCalledWith({
      where: { repoItemId: 'item-1' },
    })
  })
})

describe('montarContextoDoItem', () => {
  it('formata item corretamente com vínculos completos', () => {
    const item = { tipo: 'pr', numero: 42, estado: { status: 'open' } } as never
    const vinculos = {
      hierarquia: { parents: [{ number: 1 }] },
      milestone: { title: 'Sprint 1' },
      projectFields: { Status: 'In Progress' },
      sessoesJules: [{ sessionName: 'jules-123' }],
      qaReview: { estado: 'APPROVED', sha: 'abc' },
      statusCheckRollup: { state: 'SUCCESS' },
    } as never

    const resultado = montarContextoDoItem(item, vinculos)
    expect(resultado).toContain('Item: pr #42')
    expect(resultado).toContain('Sprint 1')
    expect(resultado).toContain('In Progress')
    expect(resultado).toContain('jules-123')
    expect(resultado).toContain('APPROVED')
    expect(resultado).toContain('SUCCESS')
  })

  it('formata item corretamente sem vínculos', () => {
    const item = { tipo: 'issue', numero: 10, estado: { status: 'closed' } } as never
    const resultado = montarContextoDoItem(item, null)
    expect(resultado).toContain('Item: issue #10')
    expect(resultado).toContain('Nenhum vínculo extra encontrado (grafo vazio).')
  })
})
