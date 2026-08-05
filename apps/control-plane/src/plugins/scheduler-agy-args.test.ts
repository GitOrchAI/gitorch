import { describe, expect, test } from 'vitest'
import { buildAntigravityCliArgs } from './scheduler.js'

describe('buildAntigravityCliArgs (--dangerously-skip-permissions fixa no código, não só na env var)', () => {
  test('a flag está presente mesmo com GITORCH_AGY_EXTRA_ARGS vazia/ausente', () => {
    expect(buildAntigravityCliArgs('20m', undefined)).toEqual([
      '--sandbox',
      '--print-timeout',
      '20m',
      '--dangerously-skip-permissions',
    ])
    expect(buildAntigravityCliArgs('20m', '')).toEqual([
      '--sandbox',
      '--print-timeout',
      '20m',
      '--dangerously-skip-permissions',
    ])
  })

  test('GITORCH_AGY_EXTRA_ARGS já declarando a flag não duplica — aparece uma única vez', () => {
    const args = buildAntigravityCliArgs('20m', '--dangerously-skip-permissions')

    expect(args).toEqual(['--sandbox', '--print-timeout', '20m', '--dangerously-skip-permissions'])
    expect(args.filter((arg) => arg === '--dangerously-skip-permissions')).toHaveLength(1)
  })

  test('outras flags extras da env var continuam passando, só a duplicata é filtrada', () => {
    const args = buildAntigravityCliArgs(
      '20m',
      '--dangerously-skip-permissions --some-other-flag valor'
    )

    expect(args).toEqual([
      '--sandbox',
      '--print-timeout',
      '20m',
      '--dangerously-skip-permissions',
      '--some-other-flag',
      'valor',
    ])
  })
})
