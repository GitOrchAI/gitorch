import { describe, it, expect } from 'vitest'
import { chaveDoRegistroDoMotor } from './registro-do-motor.js'

describe('chaveDoRegistroDoMotor', () => {
  it('é estável para a mesma ação repetida', () => {
    const a = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    const b = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    expect(a).toBe(b)
  })
  it('muda quando a ação muda (nova decisão vira novo registro)', () => {
    const a = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    const b = chaveDoRegistroDoMotor('dono/repo', 42, 'retomar')
    expect(a).not.toBe(b)
  })
})
