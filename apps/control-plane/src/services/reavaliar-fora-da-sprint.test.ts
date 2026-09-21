import { describe, it, expect } from 'vitest'
import { reavaliarForaDaSprint } from './reavaliar-fora-da-sprint.js'

describe('reavaliarForaDaSprint', () => {
  it('custo de espera baixo: fica para depois, sem interromper a sprint', () => {
    const r = reavaliarForaDaSprint({
      pedido: { pedido: 88, peso: 13 } as never,
      fila: [
        { pedido: 1, peso: 1 },
        { pedido: 2, peso: 2 },
        { pedido: 3, peso: 3 },
      ] as never[],
    })
    expect(typeof r.entraAgora).toBe('boolean')
    expect(r.entraAgora).toBe(false)
    expect(r.motivo).toBe('custo de espera baixo — entra na ordem normal da fila')
  })

  it('custo de espera relevante: fica para depois mas sugere perguntar ao dono', () => {
    const r = reavaliarForaDaSprint({
      pedido: { pedido: 88, peso: 1 } as never,
      fila: [
        { pedido: 1, peso: 13 },
        { pedido: 2, peso: 13 },
        { pedido: 3, peso: 13 },
      ] as never[],
    })
    expect(typeof r.entraAgora).toBe('boolean')
    expect(r.entraAgora).toBe(false)
    expect(r.motivo).toContain('custo de espera relevante')
  })
})
