import { describe, it, expect } from 'vitest'
import { acharTarefaDoItem } from './vinculo-da-tarefa.js'

describe('acharTarefaDoItem', () => {
  it('vínculo formal (closingIssuesReferences) vence — nem consulta o corpo/branch', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'loureng',
      corpo: undefined,
      headRefName: 'qualquer-ramo',
      sessoes: [],
      closingIssues: async () => [12],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toEqual({ issueNumber: 12, origemDoVinculo: 'formal' })
  })

  it('sem vínculo formal, recua para o texto/sessão (ehPrDelegado)', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'gitorch-bot',
      corpo: 'closes #74',
      headRefName: 'qualquer-ramo',
      sessoes: [{ issueNumber: 74, pullRequestNumber: null } as never],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => true,
    })
    expect(r).toEqual({ issueNumber: 74, origemDoVinculo: 'texto' })
  })

  it('sem vínculo formal nem texto, recua para o branch do Jules (casarPrComSessao)', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'gitorch-bot',
      corpo: undefined,
      headRefName: 'jules-121123025271330309061-e9d57552',
      sessoes: [
        {
          sessionName: 'sessions/121123025271330309061',
          pullRequestNumber: null,
          issueNumber: 55,
        } as never,
      ],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toEqual({ issueNumber: 55, origemDoVinculo: 'branch-do-jules' })
  })

  it('nenhuma pista: null', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'loureng',
      corpo: undefined,
      headRefName: 'minha-feature',
      sessoes: [],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toBeNull()
  })
})
