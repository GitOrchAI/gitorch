import { describe, it, expect } from 'vitest'
import {
  ehTerminal,
  ocupaVaga,
  ESTADOS_TERMINAIS,
  ESTADOS_QUE_OCUPAM_VAGA,
} from './estados-de-sessao.js'

describe('ehTerminal', () => {
  it('COMPLETED, FAILED e CANCELLED são terminais (o Jules já liberou a vaga)', () => {
    expect(ehTerminal('COMPLETED')).toBe(true)
    expect(ehTerminal('FAILED')).toBe(true)
    expect(ehTerminal('CANCELLED')).toBe(true)
  })
  it('normaliza para maiúscula', () => {
    expect(ehTerminal('completed')).toBe(true)
    expect(ehTerminal('failed')).toBe(true)
  })
  it('estado de trabalho não é terminal', () => {
    for (const s of ['QUEUED', 'IN_PROGRESS', 'PLANNING', 'PAUSED', 'AWAITING_USER_FEEDBACK'])
      expect(ehTerminal(s)).toBe(false)
  })
  it('estado desconhecido NÃO é terminal (fail-closed: "não sei" nunca vira "acabou")', () => {
    expect(ehTerminal('SOMETHING_NEW')).toBe(false)
    expect(ehTerminal('')).toBe(false)
  })
})

describe('ocupaVaga', () => {
  it('sessão terminada no Jules NÃO ocupa vaga de concorrência — a vaga já liberou lá', () => {
    expect(ocupaVaga('COMPLETED')).toBe(false)
    expect(ocupaVaga('completed')).toBe(false)
    expect(ocupaVaga('FAILED')).toBe(false)
    expect(ocupaVaga('CANCELLED')).toBe(false)
  })
  it('todo estado que o Jules ainda está tocando ocupa uma vaga', () => {
    for (const s of [
      'QUEUED',
      'IN_PROGRESS',
      'PLANNING',
      'PAUSED',
      'AWAITING_PLAN_APPROVAL',
      'AWAITING_USER_FEEDBACK',
    ])
      expect(ocupaVaga(s)).toBe(true)
  })
  it('estado desconhecido OCUPA vaga (fail-closed: contar a menos superlotaria o Jules)', () => {
    expect(ocupaVaga('SOMETHING_NEW')).toBe(true)
    expect(ocupaVaga('')).toBe(true)
  })
})

describe('os conjuntos exprimem a intenção', () => {
  it('nenhum estado é terminal E ocupa vaga ao mesmo tempo', () => {
    for (const s of ESTADOS_TERMINAIS) expect(ESTADOS_QUE_OCUPAM_VAGA.has(s)).toBe(false)
  })
})
