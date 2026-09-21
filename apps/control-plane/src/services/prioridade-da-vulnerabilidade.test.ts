import { describe, it, expect } from 'vitest'
import { prioridadeDaVulnerabilidade } from './prioridade-da-vulnerabilidade.js'

describe('prioridadeDaVulnerabilidade', () => {
  it('critical + runtime: sprint atual', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'critical', escopo: 'runtime' })).toBe(
      'sprint-atual'
    )
  })
  it('high + development: backlog', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'high', escopo: 'development' })).toBe(
      'backlog'
    )
  })
  it('medium + runtime: backlog (só grave vai para a sprint)', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'medium', escopo: 'runtime' })).toBe('backlog')
  })
  it('critical + escopo desconhecido: sprint atual (lado seguro — nunca subestima)', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'critical', escopo: 'desconhecido' })).toBe(
      'sprint-atual'
    )
  })
})
