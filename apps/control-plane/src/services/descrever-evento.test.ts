import { describe, it, expect } from 'vitest'
import { descreverEvento, papelDoAgente, estadoDoAgente } from './descrever-evento.js'

describe('descreverEvento', () => {
  it('mapeia os tipos conhecidos para frase sem jargão', () => {
    expect(descreverEvento({ tipo: 'agent-run-qa' })).toBe(
      'A revisão de qualidade está avaliando uma entrega'
    )
    expect(descreverEvento({ tipo: 'agent_question' })).toBe(
      'Um agente parou para te perguntar algo'
    )
    expect(descreverEvento({ tipo: 'mission.completed' })).toBe('Uma tarefa terminou')
    expect(descreverEvento({ tipo: 'clone_and_start_engines' })).toBe(
      'Preparando o ambiente do projeto'
    )
  })
  it('tipo desconhecido → frase neutra, nunca inventa detalhe', () => {
    expect(descreverEvento({ tipo: 'xpto.qualquer' })).toBe('Movimento novo na esteira')
    expect(descreverEvento({ tipo: '' })).toBe('Movimento novo na esteira')
  })
})

describe('papelDoAgente', () => {
  it('extrai o papel do tipo agent-run-<role>', () => {
    expect(papelDoAgente('agent-run-po')).toBe('Produto')
    expect(papelDoAgente('agent-run-ra')).toBe('Planejamento')
    expect(papelDoAgente('agent-run-sm')).toBe('Planejamento')
    expect(papelDoAgente('agent-run-qa')).toBe('Qualidade')
  })
  it('tipo que não é papel F6 → "Agente"', () => {
    expect(papelDoAgente('agent-run-dev')).toBe('Agente')
    expect(papelDoAgente('clone_and_start_engines')).toBe('Agente')
  })
})

describe('estadoDoAgente', () => {
  it('waitingStatus presente → esperando_voce (vence tudo)', () => {
    expect(estadoDoAgente({ status: 'running', waitingStatus: 'awaiting_user' })).toBe(
      'esperando_voce'
    )
  })
  it('running ou pending → trabalhando', () => {
    expect(estadoDoAgente({ status: 'running' })).toBe('trabalhando')
    expect(estadoDoAgente({ status: 'pending', waitingStatus: null })).toBe('trabalhando')
  })
  it('failed → bloqueado', () => {
    expect(estadoDoAgente({ status: 'failed' })).toBe('bloqueado')
  })
  it('qualquer outro estado → ocioso', () => {
    expect(estadoDoAgente({ status: 'completed' })).toBe('ocioso')
    expect(estadoDoAgente({ status: 'cancelled' })).toBe('ocioso')
  })
})
