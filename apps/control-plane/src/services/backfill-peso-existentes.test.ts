import { describe, it, expect, vi } from 'vitest'
import {
  backfillPesoDosItensExistentes,
  type ItemParaBackfillDePeso,
} from './backfill-peso-existentes.js'
import { renderIssueBody } from './backlog-executor.js'
import type { DoDFields } from '@gitorch/cadence'

// D8 — "PREENCHA O QUE JÁ ESTÁ LÁ": 124 itens nasceram no quadro antes de
// `setWeight` existir (PR #417). O mecanismo novo (github-backlog.ts) só
// cobre issue NOVA; sem esta passada a feature "Sua ordem custa caro?" (D1)
// fica muda por semanas — exatamente o que já aconteceu com o campo Sprint
// (3 de 124 preenchidos). NÃO INVENTA peso: item sem "## Peso" no corpo fica
// sem peso, contado, nunca estimado.

function fields(): DoDFields {
  return {
    titulo: '[Task] x',
    goal: 'g',
    taskDetails: 'd',
    taskDescription: 'td',
    implementationGuide: 'ig',
    verificationCriteria: '- comando X devolve Y',
    dependencies: 'nenhuma',
    relatedFiles: 'a.ts',
    notes: 'n',
  }
}

function corpoComPeso(peso: 1 | 2 | 3 | 5 | 8 | 13): string {
  return renderIssueBody(fields(), 'm', { weight: peso, rationale: 'r' })
}

function item(over: Partial<ItemParaBackfillDePeso>): ItemParaBackfillDePeso {
  return { itemId: 'PVTI_1', issueNumber: 1, pesoAtual: null, corpo: null, ...over }
}

describe('backfillPesoDosItensExistentes', () => {
  it('item que já tem peso no campo: NÃO grava de novo, conta como "já tinha"', async () => {
    const gravarPeso = vi.fn()
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [item({ pesoAtual: 3, corpo: corpoComPeso(5) })],
      gravarPeso,
    })

    expect(gravarPeso).not.toHaveBeenCalled()
    expect(resultado).toEqual({
      totalItens: 1,
      jaTinhaPeso: 1,
      preenchidosAgora: 0,
      semPesoNoCorpo: 0,
      issuesSemPeso: [],
    })
  })

  it('item sem peso no campo mas com "## Peso" no corpo: grava o valor do corpo', async () => {
    const gravarPeso = vi.fn().mockResolvedValue(undefined)
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [
        item({ itemId: 'PVTI_7', issueNumber: 311, pesoAtual: null, corpo: corpoComPeso(8) }),
      ],
      gravarPeso,
    })

    expect(gravarPeso).toHaveBeenCalledExactlyOnceWith('PVTI_7', 8)
    expect(resultado).toEqual({
      totalItens: 1,
      jaTinhaPeso: 0,
      preenchidosAgora: 1,
      semPesoNoCorpo: 0,
      issuesSemPeso: [],
    })
  })

  it('item sem peso no campo E sem "## Peso" no corpo (fase/épico/feature/incidente): fica sem peso, NÃO inventa', async () => {
    const gravarPeso = vi.fn()
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [
        item({ issueNumber: 42, pesoAtual: null, corpo: '<!-- m -->\n\n## Goal\n\nx' }),
      ],
      gravarPeso,
    })

    expect(gravarPeso).not.toHaveBeenCalled()
    expect(resultado).toEqual({
      totalItens: 1,
      jaTinhaPeso: 0,
      preenchidosAgora: 0,
      semPesoNoCorpo: 1,
      issuesSemPeso: [42],
    })
  })

  it('mistura realista: já tinha + preenche do corpo + fica sem peso, contados separadamente', async () => {
    const gravarPeso = vi.fn().mockResolvedValue(undefined)
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [
        item({ itemId: 'A', issueNumber: 1, pesoAtual: 5, corpo: null }), // já tinha
        item({ itemId: 'B', issueNumber: 2, pesoAtual: null, corpo: corpoComPeso(13) }), // preenche
        item({ itemId: 'C', issueNumber: 3, pesoAtual: null, corpo: null }), // checkpoint sem corpo
        item({ itemId: 'D', issueNumber: 4, pesoAtual: null, corpo: corpoComPeso(2) }), // preenche
      ],
      gravarPeso,
    })

    expect(gravarPeso.mock.calls).toEqual([
      ['B', 13],
      ['D', 2],
    ])
    expect(resultado).toEqual({
      totalItens: 4,
      jaTinhaPeso: 1,
      preenchidosAgora: 2,
      semPesoNoCorpo: 1,
      issuesSemPeso: [3],
    })
  })

  it('peso no corpo fora da ESCALA_DE_PESO (editado à mão): fica sem peso, não força', async () => {
    const gravarPeso = vi.fn()
    const corpoFora = '<!-- m -->\n\n## Peso\n\n**99** (escala 1, 2, 3, 5, 8, 13)\n\nr'
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [item({ issueNumber: 9, corpo: corpoFora })],
      gravarPeso,
    })

    expect(gravarPeso).not.toHaveBeenCalled()
    expect(resultado.semPesoNoCorpo).toBe(1)
    expect(resultado.issuesSemPeso).toEqual([9])
  })

  it('quadro vazio: totalItens 0, nada gravado, nenhuma exceção', async () => {
    const gravarPeso = vi.fn()
    const resultado = await backfillPesoDosItensExistentes({
      listarItens: async () => [],
      gravarPeso,
    })

    expect(gravarPeso).not.toHaveBeenCalled()
    expect(resultado).toEqual({
      totalItens: 0,
      jaTinhaPeso: 0,
      preenchidosAgora: 0,
      semPesoNoCorpo: 0,
      issuesSemPeso: [],
    })
  })

  it('EM SÉRIE: uma falha ao gravar sobe, e não deixa os itens seguintes num estado indefinido', async () => {
    const gravarPeso = vi.fn().mockRejectedValueOnce(new Error('rede caiu'))
    await expect(
      backfillPesoDosItensExistentes({
        listarItens: async () => [item({ issueNumber: 1, corpo: corpoComPeso(3) })],
        gravarPeso,
      })
    ).rejects.toThrow('rede caiu')
  })
})
