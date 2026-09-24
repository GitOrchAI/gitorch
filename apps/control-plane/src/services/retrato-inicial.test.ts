import { describe, it, expect, vi } from 'vitest'
import { descobrirVinculoDoRetrato, mesclarEAtualizarFicha } from './retrato-inicial.js'
import * as VinculoDaTarefa from './vinculo-da-tarefa.js'
import * as FichaDoItem from './ficha-do-item.js'

describe('descobrirVinculoDoRetrato', () => {
  it('preenche o cache com as issues citadas no corpo e chama acharTarefaDoItem ligando PR pelo corpo/branch', async () => {
    const ghGet = vi.fn().mockResolvedValue({ labels: [{ name: 'gitorch:task' }] })
    const acharTarefaSpy = vi
      .spyOn(VinculoDaTarefa, 'acharTarefaDoItem')
      .mockResolvedValue({ issueNumber: 123, origemDoVinculo: 'texto' })
    const issueCache = new Map()
    const projectV2Client = { closingIssuesDoPr: vi.fn() }

    await descobrirVinculoDoRetrato({
      numeroDoPr: 10,
      repository: 'dono/repo',
      sinaisPr: { autor: 'dev', corpo: 'fixes #123', headRefName: 'branch' },
      sessoesFechadas: [],
      projectV2Client: projectV2Client as never,
      ghGet,
      issueCache,
    })

    expect(ghGet).toHaveBeenCalledWith('/repos/dono/repo/issues/123')
    expect(issueCache.get(123)).toBe(true)
    expect(acharTarefaSpy).toHaveBeenCalled()
  })

  it('não repete o fetch se a issue já estiver no cache (idempotência)', async () => {
    const ghGet = vi.fn()
    const acharTarefaSpy = vi
      .spyOn(VinculoDaTarefa, 'acharTarefaDoItem')
      .mockResolvedValue({ issueNumber: 123, origemDoVinculo: 'texto' })
    const issueCache = new Map([[123, true]])
    const projectV2Client = { closingIssuesDoPr: vi.fn() }

    await descobrirVinculoDoRetrato({
      numeroDoPr: 10,
      repository: 'dono/repo',
      sinaisPr: { autor: 'dev', corpo: 'fixes #123', headRefName: 'branch' },
      sessoesFechadas: [],
      projectV2Client: projectV2Client as never,
      ghGet,
      issueCache,
    })

    expect(ghGet).not.toHaveBeenCalled()
    expect(acharTarefaSpy).toHaveBeenCalled()
  })
})

describe('mesclarEAtualizarFicha', () => {
  it('mescla o estado existente com status open sem sobrescrever rascunho', async () => {
    const lerFichaSpy = vi.spyOn(FichaDoItem, 'lerFichaDoItem').mockResolvedValue({
      estado: { conflito: true, rascunho: true },
    } as never)
    const atualizarFichaSpy = vi
      .spyOn(FichaDoItem, 'atualizarFichaDoItem')
      .mockResolvedValue({} as never)

    await mesclarEAtualizarFicha({
      prisma: {} as never,
      projectId: 'proj1',
      numero: 10,
      origemClassificada: 'humano',
    })

    expect(lerFichaSpy).toHaveBeenCalledWith(expect.objectContaining({ numero: 10 }))
    expect(atualizarFichaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        estado: { conflito: true, rascunho: true, status: 'open' },
        origem: 'humano',
      })
    )
  })
})
