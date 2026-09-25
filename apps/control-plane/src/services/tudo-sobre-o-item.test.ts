import { describe, it, expect, vi } from 'vitest'
import { tudoSobreOItem } from './tudo-sobre-o-item.js'

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
