import { describe, it, expect } from 'vitest'
import { pesoDoCorpoDaIssue } from './backlog-executor.js'
import { renderIssueBody } from './backlog-executor.js'
import type { DoDFields } from '@gitorch/cadence'

// D8 — backfill dos 124 itens existentes: "onde o peso já existe no corpo da
// issue, leia de lá". Este é o lado de LEITURA, inverso de `renderIssueBody`
// (que ESCREVE a seção "## Peso"). Reaproveita `lerSecaoDaIssue`
// (secao-da-issue.ts) — a mesma leitura por cabeçalho que já serve
// sm-delegation/qa-rails-mission/pedido-ao-dev — em vez de inventar uma
// segunda regra de parsing que diverge da primeira quando o formato mudar.

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

describe('pesoDoCorpoDaIssue', () => {
  it('lê o peso de um corpo real gerado por renderIssueBody (round-trip)', () => {
    const corpo = renderIssueBody(fields(), 'marker', { weight: 8, rationale: 'porque sim' })
    expect(pesoDoCorpoDaIssue(corpo)).toBe(8)
  })

  it('lê cada valor da escala, não só um', () => {
    for (const w of [1, 2, 3, 5, 8, 13] as const) {
      const corpo = renderIssueBody(fields(), 'marker', { weight: w, rationale: 'r' })
      expect(pesoDoCorpoDaIssue(corpo)).toBe(w)
    }
  })

  it('corpo sem seção "## Peso" (issue anterior ao PR #417): null, nunca inventa', () => {
    const corpo = renderIssueBody(fields(), 'marker', null)
    expect(pesoDoCorpoDaIssue(corpo)).toBeNull()
  })

  it('corpo vazio ou ausente: null', () => {
    expect(pesoDoCorpoDaIssue('')).toBeNull()
    expect(pesoDoCorpoDaIssue(null)).toBeNull()
    expect(pesoDoCorpoDaIssue(undefined)).toBeNull()
  })

  it('número fora da ESCALA_DE_PESO no corpo (editado à mão): null, não inventa nem arredonda', () => {
    const corpo = '<!-- m -->\n\n## Peso\n\n**7** (escala 1, 2, 3, 5, 8, 13)\n\nrationale'
    expect(pesoDoCorpoDaIssue(corpo)).toBeNull()
  })

  it('texto não-numérico na seção Peso: null, não quebra', () => {
    const corpo = '<!-- m -->\n\n## Peso\n\n**muito grande**\n\nrationale'
    expect(pesoDoCorpoDaIssue(corpo)).toBeNull()
  })

  it('não confunde com outra seção que também tenha número em negrito', () => {
    const corpo =
      '<!-- m -->\n\n## Goal\n\nAlgo com **99** no meio.\n\n## Peso\n\n**3** (escala 1, 2, 3, 5, 8, 13)\n\nr'
    expect(pesoDoCorpoDaIssue(corpo)).toBe(3)
  })
})
