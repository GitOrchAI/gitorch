import { describe, expect, test } from 'vitest'
import { classificarAviso } from './classe-do-aviso.js'
import {
  recadoDeFalhaDePublicacao,
  type FalhaDePublicacao,
} from './recado-de-falha-de-publicacao.js'

const MOTIVO = 'a etapa "deploy prod" terminou com "failure".'

const FALHA = {
  wingId: 'acme',
  shaDaMescla: 'deadbeefcafe1234567890abcdef1234567890ab',
  motivo: MOTIVO,
  etapas: [
    { nome: 'build', resultado: 'success' },
    { nome: 'deploy prod', resultado: 'failure' },
    { nome: 'rollback', resultado: 'skipped' },
  ],
  numeroDoConserto: 99,
} satisfies FalhaDePublicacao

function linhas(texto: string): string[] {
  return texto.split('\n')
}

describe('recadoDeFalhaDePublicacao (#141 — legível no celular)', () => {
  test('não volta a ser um parágrafo único: motivo, etapas e conserto nunca dividem linha', () => {
    for (const linha of linhas(recadoDeFalhaDePublicacao(FALHA))) {
      const pedacos = [
        linha.includes(MOTIVO),
        linha.includes('deploy prod: failure'),
        linha.includes('#99'),
      ]
      expect(pedacos.filter(Boolean).length).toBeLessThanOrEqual(1)
    }
  })

  test('não junta etapas com ponto e vírgula: cada etapa ocupa a sua linha', () => {
    const texto = recadoDeFalhaDePublicacao(FALHA)
    expect(texto).not.toContain('; ')
    expect(texto).not.toContain('Etapas:')
    for (const etapa of FALHA.etapas) {
      expect(linhas(texto)).toContain(`• ${etapa.nome}: ${etapa.resultado}`)
    }
  })

  test('não usa Markdown: o Telegram recebe texto cru e mostraria os símbolos', () => {
    expect(recadoDeFalhaDePublicacao(FALHA)).not.toMatch(/[*_`]/)
  })

  test('não perde nenhuma das três respostas que a issue pede', () => {
    const texto = recadoDeFalhaDePublicacao(FALHA)
    expect(texto).toContain(`O que quebrou: ${MOTIVO}`)
    expect(texto).toContain('Em qual passo:')
    expect(texto).toContain('O que já foi feito: o conserto virou tarefa no repositório (#99).')
  })

  test('a primeira linha sozinha já diz de qual projeto é e que precisa de atenção', () => {
    expect(linhas(recadoDeFalhaDePublicacao(FALHA))[0]).toBe(
      'GitOrch: a publicação de acme precisa de atenção.'
    )
  })

  test('sem etapas lidas, não sobra um título "Em qual passo" vazio', () => {
    const texto = recadoDeFalhaDePublicacao({ ...FALHA, etapas: [] })
    expect(texto).not.toContain('Em qual passo')
    expect(texto).not.toContain('•')
  })

  test('sem conserto recém-aberto, não afirma nada sobre o que foi feito', () => {
    const texto = recadoDeFalhaDePublicacao({ ...FALHA, numeroDoConserto: null })
    expect(texto).not.toContain('O que já foi feito')
    expect(texto).not.toContain('#')
  })

  test('não despeja o hash inteiro de 40 caracteres numa linha de celular', () => {
    const texto = recadoDeFalhaDePublicacao(FALHA)
    expect(texto).not.toContain(FALHA.shaDaMescla)
    expect(linhas(texto)).toContain('Commit: deadbee')
  })

  test('não termina nem começa com linha em branco', () => {
    const texto = recadoDeFalhaDePublicacao({ ...FALHA, etapas: [], numeroDoConserto: null })
    expect(texto).toBe(texto.trim())
  })

  test('quebrar em linhas não tira o recado do Telegram: continua executivo, não auditoria', () => {
    expect(classificarAviso(recadoDeFalhaDePublicacao(FALHA))).toBe('executivo')
    expect(
      classificarAviso(recadoDeFalhaDePublicacao({ ...FALHA, etapas: [], numeroDoConserto: null }))
    ).toBe('executivo')
  })
})
