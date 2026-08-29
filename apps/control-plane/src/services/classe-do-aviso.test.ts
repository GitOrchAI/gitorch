import { describe, it, expect } from 'vitest'
import { classificarAviso } from './classe-do-aviso.js'

describe('classificarAviso — ESTEIRA-T15', () => {
  it('os 4 exemplos reais da rajada de 29/08 são auditoria', () => {
    expect(classificarAviso('GitOrch: 3 entregas barradas seguidas. Parei de reencaminhar.')).toBe(
      'auditoria'
    )
    expect(classificarAviso('GitOrch: 4 entregas barradas')).toBe('auditoria')
    expect(
      classificarAviso('GitOrch: a entrega da issue #318 voltou para a fila — o dev falhou.')
    ).toBe('auditoria')
  })

  it('lote de entregas voltando para a fila (plural) também é auditoria', () => {
    expect(
      classificarAviso(
        'GitOrch: 3 entregas voltaram para a fila (#1, #2, #3) — o dev concluiu ou falhou sem uma entrega que mesclasse.'
      )
    ).toBe('auditoria')
  })

  it('achado de infra do sensor (mensagem real de processar-achados-de-infra.ts) é auditoria', () => {
    expect(
      classificarAviso(
        'Encanamento do GitOrch em acme/api: título do achado. Bridge quebrado — issue de conserto #42 (GitOrchAI/gitorch).'
      )
    ).toBe('auditoria')
  })

  it('decisão pendente e marco de entrega são executivo', () => {
    expect(classificarAviso('GitOrch: a issue #12 precisa da sua decisão antes de seguir.')).toBe(
      'executivo'
    )
    expect(classificarAviso('GitOrch: a entrega de acme/api foi ao ar.')).toBe('executivo')
  })

  it('mensagem sem nenhum padrão conhecido cai no lado seguro (executivo)', () => {
    expect(classificarAviso('GitOrch: algo inesperado aconteceu, veja o log.')).toBe('executivo')
  })
})
