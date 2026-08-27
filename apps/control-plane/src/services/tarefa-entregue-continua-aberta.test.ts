import { describe, expect, it } from 'vitest'
import {
  CARENCIA_ANTES_DE_VARRER_MS,
  entregasQueMerecemConferencia,
  recadoDeTarefaJaEntregue,
} from './tarefa-entregue-continua-aberta.js'

const AGORA = new Date('2026-08-27T18:00:00Z')
const VELHA = new Date(AGORA.getTime() - CARENCIA_ANTES_DE_VARRER_MS - 1_000)

const linha = (
  issueNumber: number,
  mergeCommitSha: string | null,
  pullRequestNumber: number | null = null,
  updatedAt: Date = VELHA
) => ({ issueNumber, mergeCommitSha, pullRequestNumber, updatedAt })

describe('quais entregas merecem conferência', () => {
  it('sem commit de merge não entra — não há o que fechar', () => {
    expect(entregasQueMerecemConferencia([linha(10, null)], AGORA)).toEqual([])
  })

  it('a MESMA tarefa aparece uma vez só, por mais entregas que tenha', () => {
    // A tarefa #128 chegou a ter CINCO entregas por causa da redelegação.
    // Perguntar cinco vezes pelo estado dela repetiria o desperdício.
    const escolhidas = entregasQueMerecemConferencia(
      [linha(128, 'aaa'), linha(128, 'bbb'), linha(128, 'ccc'), linha(110, 'ddd')],
      AGORA
    )
    expect(escolhidas.map((e) => e.issueNumber)).toEqual([128, 110])
  })

  it('número de tarefa inválido não vira consulta', () => {
    expect(entregasQueMerecemConferencia([linha(0, 'aaa'), linha(-3, 'bbb')], AGORA)).toEqual([])
  })

  it('mantém a ordem recebida — a mais antiga é conferida primeiro', () => {
    const escolhidas = entregasQueMerecemConferencia([linha(5, 'a'), linha(9, 'b')], AGORA)
    expect(escolhidas.map((e) => e.issueNumber)).toEqual([5, 9])
  })

  it('entrega recem-mesclada NAO entra — aquela ainda e do caminho normal', () => {
    // Um teste de costura real pegou isto: a varredura e a missao de QA
    // comentavam e fechavam a MESMA tarefa no mesmo tique, deixando dois
    // comentarios identicos no repositorio do cliente.
    const agoraMesmo = new Date(AGORA.getTime() - 1_000)
    expect(entregasQueMerecemConferencia([linha(7, 'aaa', null, agoraMesmo)], AGORA)).toEqual([])
  })

  it('passada a carencia, entra — ninguem mais vai fechar', () => {
    expect(entregasQueMerecemConferencia([linha(7, 'aaa')], AGORA)).toHaveLength(1)
  })
})

describe('o recado do fechamento', () => {
  it('NÃO afirma que o produto mesclou — porque não foi ele', () => {
    const texto = recadoDeTarefaJaEntregue({ pullRequestNumber: 42, mergeCommitSha: 'abcdef1234' })
    expect(texto).not.toMatch(/O GitOrch mesclou/)
    expect(texto).toContain('#42')
    expect(texto).toContain('abcdef12')
  })

  it('sem número de PR o texto continua verdadeiro, sem citar "#null"', () => {
    const texto = recadoDeTarefaJaEntregue({
      pullRequestNumber: null,
      mergeCommitSha: 'abcdef1234',
    })
    expect(texto).not.toContain('#null')
    expect(texto).not.toContain('PR #')
    expect(texto).toContain('abcdef12')
  })

  it('convida a reabrir: entrega mesclada não é o mesmo que problema resolvido', () => {
    const texto = recadoDeTarefaJaEntregue({ pullRequestNumber: 1, mergeCommitSha: '1234567890' })
    expect(texto).toContain('reabra')
  })
})
