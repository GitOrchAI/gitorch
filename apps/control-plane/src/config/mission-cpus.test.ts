import { describe, it, expect } from 'vitest'
import { resolveMissionCpus, DEFAULT_MISSION_CPUS } from './mission-cpus.js'

describe('resolveMissionCpus', () => {
  it('sem a env, usa o default', () => {
    expect(resolveMissionCpus({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MISSION_CPUS)
  })

  it('env vazia (presente, sem valor) NÃO desliga o teto — cai no default', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MISSION_CPUS
    )
  })

  it('só espaço em branco cai no default', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '   ' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MISSION_CPUS
    )
  })

  it('valor não-numérico cai no default (operador não é confiável)', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: 'abc' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MISSION_CPUS
    )
  })

  it('"0" cai no default — zero não é um teto, é desligar', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '0' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MISSION_CPUS
    )
  })

  it('negativo cai no default', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '-1' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MISSION_CPUS
    )
  })

  it('"1.5" (o próprio default) passa por inteiro', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '1.5' } as NodeJS.ProcessEnv)).toBe('1.5')
  })

  it('"2" (override válido do operador) passa por inteiro', () => {
    expect(resolveMissionCpus({ GITORCH_MISSION_CPUS: '2' } as NodeJS.ProcessEnv)).toBe('2')
  })
})
