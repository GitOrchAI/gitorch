import { describe, it, expect } from 'vitest'
import { extractJson, runFormStep, RailsStepError } from './rails-runner.js'
import { RAILS_SCHEMAS } from '@gitorch/cadence'

describe('extractJson', () => {
  it('extrai o primeiro objeto balanceado no meio de prosa', () => {
    const out =
      'Claro! Aqui está:\n{"phases":[{"title":"F1","goal":"g","rationale":"r"}]}\nEspero ter ajudado.'
    expect(extractJson(out)).toEqual({ phases: [{ title: 'F1', goal: 'g', rationale: 'r' }] })
  })

  it('lida com cercas de markdown', () => {
    const out = '```json\n{"sprintGoal":"x","selectedItemIndexes":[0,1]}\n```'
    expect(extractJson(out)).toEqual({ sprintGoal: 'x', selectedItemIndexes: [0, 1] })
  })

  it('ignora chaves dentro de strings', () => {
    const out = '{"notes":"tem { chave } dentro","x":1}'
    expect(extractJson(out)).toEqual({ notes: 'tem { chave } dentro', x: 1 })
  })

  it('retorna null sem JSON', () => {
    expect(extractJson('nenhum objeto aqui')).toBeNull()
  })
})

describe('runFormStep', () => {
  it('aceita resposta válida de primeira', async () => {
    const calls: string[] = []
    const result = await runFormStep({
      schema: RAILS_SCHEMAS.poPhases,
      prompt: 'p1',
      execute: async (prompt) => {
        calls.push(prompt)
        return '{"phases":[{"title":"F1","goal":"g","rationale":"r"}]}'
      },
    })
    expect(calls).toHaveLength(1)
    expect((result as { phases: unknown[] }).phases).toHaveLength(1)
  })

  it('repara: 1ª resposta inválida → re-prompt com os erros → 2ª válida', async () => {
    const prompts: string[] = []
    let n = 0
    const result = await runFormStep({
      schema: RAILS_SCHEMAS.poPhases,
      prompt: 'p1',
      execute: async (prompt) => {
        prompts.push(prompt)
        n += 1
        return n === 1
          ? '{"phases":[{"title":"F1"}]}' // faltam goal/rationale
          : '{"phases":[{"title":"F1","goal":"g","rationale":"r"}]}'
      },
    })
    expect(n).toBe(2)
    expect(prompts[1]).toContain('goal')
    expect(prompts[1]).toContain('previous reply was invalid')
    expect((result as { phases: unknown[] }).phases).toHaveLength(1)
  })

  it('esgota repairs → RailsStepError com os erros da última tentativa', async () => {
    await expect(
      runFormStep({
        schema: RAILS_SCHEMAS.poPhases,
        prompt: 'p1',
        maxRepairs: 1,
        execute: async () => 'sem json nenhum',
      })
    ).rejects.toThrow(RailsStepError)
  })
})
