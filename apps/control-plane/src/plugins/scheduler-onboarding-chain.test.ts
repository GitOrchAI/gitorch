import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { nextOnboardingStep, resolveRailsBoard } from './scheduler.js'

// Crítico 1, item (c): a mecânica da cascata de onboarding (dado o que resta
// da fila, qual é o próximo papel a disparar) isolada da decisão de entrega
// (resolveMissionDelivery, testada em mission-outcome.test.ts). Combinadas,
// as duas provam que uma missão de trilhos que entrega de verdade encadeia
// normalmente: o único gate que ficava entre elas (o contrato de entregável
// aplicado indevidamente aos trilhos) foi removido, e a mecânica de avançar
// a fila continua correta.
describe('nextOnboardingStep', () => {
  test('fila com múltiplos papéis: devolve o primeiro como próximo e o resto como remaining', () => {
    expect(nextOnboardingStep(['ra', 'po', 'sm', 'qa'])).toEqual({
      role: 'ra',
      remaining: ['po', 'sm', 'qa'],
    })
  })

  test('último papel da fila: remaining vazio, mas ainda dispara', () => {
    expect(nextOnboardingStep(['qa'])).toEqual({ role: 'qa', remaining: [] })
  })

  test('fila vazia: não há próximo papel (cascata terminou)', () => {
    expect(nextOnboardingStep([])).toBeNull()
  })

  test('sequência ausente (missão fora de uma cascata de onboarding): não há próximo papel', () => {
    expect(nextOnboardingStep(undefined)).toBeNull()
    expect(nextOnboardingStep(null)).toBeNull()
  })
})

// Crítico 2: o board dos trilhos NUNCA cai no board global de outro
// projeto — mesmo que a env global esteja setada, um projeto sem board
// próprio gravado deve ficar SEM board (trilhos do PO desligados), nunca
// herdar o board alheio.
describe('resolveRailsBoard (Crítico 2: sem fallback pro board global de outro projeto)', () => {
  const originalGlobalBoard = process.env['GITORCH_PROJECT_BOARD']

  beforeEach(() => {
    // Simula a env global do dono apontando pro board de OUTRO projeto —
    // exatamente a configuração real que causava o vazamento.
    process.env['GITORCH_PROJECT_BOARD'] = 'outro-dono/999'
  })

  afterEach(() => {
    if (originalGlobalBoard === undefined) delete process.env['GITORCH_PROJECT_BOARD']
    else process.env['GITORCH_PROJECT_BOARD'] = originalGlobalBoard
  })

  test('projeto SEM board próprio: undefined, mesmo com o board global setado (nunca herda o de outro projeto)', () => {
    const projetoSemBoard = { runtimeConfig: { envConfig: {} } }
    expect(resolveRailsBoard(projetoSemBoard)).toBeUndefined()
  })

  test('projeto sem runtimeConfig nenhum: undefined, mesmo com o board global setado', () => {
    expect(resolveRailsBoard({})).toBeUndefined()
    expect(resolveRailsBoard({ runtimeConfig: null })).toBeUndefined()
  })

  test('projeto COM board próprio: usa o board do PROJETO, não o global', () => {
    const projetoComBoard = {
      runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'meu-dono/7' } },
    }
    expect(resolveRailsBoard(projetoComBoard)).toBe('meu-dono/7')
  })

  test('sem NENHUMA env global setada, o comportamento é idêntico (a função nunca olha pro env)', () => {
    delete process.env['GITORCH_PROJECT_BOARD']
    const projetoSemBoard = { runtimeConfig: { envConfig: {} } }
    expect(resolveRailsBoard(projetoSemBoard)).toBeUndefined()
  })
})
