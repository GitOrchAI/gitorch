import { describe, expect, test } from 'vitest'
import { isScheduleDue } from './scheduler.js'

describe('isScheduleDue', () => {
  const now = new Date('2026-01-10T17:00:30Z')

  test('dispara quando a ocorrência do cron venceu e nunca houve disparo', () => {
    expect(isScheduleDue('0 17 * * *', null, now)).toBe(true)
  })

  test('não dispara duas vezes na mesma janela', () => {
    const lastTriggeredAt = new Date('2026-01-10T17:00:05Z')
    expect(isScheduleDue('0 17 * * *', lastTriggeredAt, now)).toBe(false)
  })

  test('dispara de novo quando uma nova janela vence', () => {
    const lastTriggeredAt = new Date('2026-01-09T17:00:05Z')
    expect(isScheduleDue('0 17 * * *', lastTriggeredAt, now)).toBe(true)
  })

  test('não dispara antes da primeira janela do dia', () => {
    const beforeWindow = new Date('2026-01-10T16:59:00Z')
    const lastTriggeredAt = new Date('2026-01-09T17:00:05Z')
    expect(isScheduleDue('0 17 * * *', lastTriggeredAt, beforeWindow)).toBe(false)
  })

  test('suporta múltiplos horários no mesmo cron', () => {
    const lastTriggeredAt = new Date('2026-01-10T05:00:10Z')
    const at11 = new Date('2026-01-10T11:00:20Z')
    expect(isScheduleDue('0 5,11,17,23 * * *', lastTriggeredAt, at11)).toBe(true)
  })

  test('cron inválido lança erro (chamador registra e ignora)', () => {
    expect(() => isScheduleDue('not-a-cron', null, now)).toThrow()
  })
})
