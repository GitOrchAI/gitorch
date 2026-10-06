import { describe, it, expect } from 'vitest'
import { destinoDoAlerta, prioridadeDaVulnerabilidade } from './prioridade-da-vulnerabilidade.js'

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
  it('high + development COM correção publicada: sprint atual (há o que fazer já)', () => {
    expect(
      prioridadeDaVulnerabilidade({
        severidade: 'high',
        escopo: 'development',
        versaoCorrigida: '2.0.1',
      })
    ).toBe('sprint-atual')
  })
})

describe('destinoDoAlerta', () => {
  it('grave em produção vai para a sprint atual, com o motivo', () => {
    const d = destinoDoAlerta({ severidade: 'critical', escopo: 'runtime', versaoCorrigida: null })
    expect(d.destino).toBe('sprint-atual')
    expect(d.motivo).toMatch(/produção/)
  })
  it('média em produção vai para o backlog', () => {
    const d = destinoDoAlerta({ severidade: 'medium', escopo: 'runtime', versaoCorrigida: '1.2.3' })
    expect(d.destino).toBe('backlog')
  })
  it('só de desenvolvimento e sem correção publicada NÃO vira tarefa, e diz por quê', () => {
    for (const severidade of ['critical', 'high', 'medium', 'low'] as const) {
      const d = destinoDoAlerta({ severidade, escopo: 'development', versaoCorrigida: null })
      expect(d.destino).toBe('sem-tarefa')
      expect(d.motivo).toMatch(/desenvolvimento/)
      expect(d.motivo).toMatch(/correção/)
    }
  })
  it('só de desenvolvimento mas com correção publicada: média vai ao backlog', () => {
    const d = destinoDoAlerta({
      severidade: 'medium',
      escopo: 'development',
      versaoCorrigida: '3.0.0',
    })
    expect(d.destino).toBe('backlog')
  })
})
