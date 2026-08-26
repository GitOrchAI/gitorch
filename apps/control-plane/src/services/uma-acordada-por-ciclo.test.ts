import { describe, expect, it, vi } from 'vitest'
import { umaAcordadaPorCiclo } from './uma-acordada-por-ciclo.js'

describe('uma acordada por ciclo', () => {
  it('dez sessões com novidade acordam o QA UMA vez (a rajada medida em 26/08)', async () => {
    const disparar = vi.fn(async () => undefined)
    const gate = umaAcordadaPorCiclo(disparar)
    for (let i = 0; i < 10; i += 1) await gate('qa', 'proj_1')
    expect(disparar).toHaveBeenCalledTimes(1)
    expect(disparar).toHaveBeenCalledWith('qa', 'proj_1')
  })

  it('projetos diferentes continuam acordando — o gate é por papel E projeto', async () => {
    const disparar = vi.fn(async () => undefined)
    const gate = umaAcordadaPorCiclo(disparar)
    await gate('qa', 'proj_1')
    await gate('qa', 'proj_2')
    expect(disparar).toHaveBeenCalledTimes(2)
  })

  it('papéis diferentes no mesmo projeto continuam acordando', async () => {
    const disparar = vi.fn(async () => undefined)
    const gate = umaAcordadaPorCiclo(disparar)
    await gate('qa', 'proj_1')
    await gate('sm', 'proj_1')
    expect(disparar).toHaveBeenCalledTimes(2)
  })

  it('a passada SEGUINTE dispara de novo — não é teto de frequência', async () => {
    // O gate existe para que um laço sobre sessões não vire rajada, não para
    // segurar a esteira: quem limita frequência é o descanso e a agenda.
    const disparar = vi.fn(async () => undefined)
    await umaAcordadaPorCiclo(disparar)('qa', 'proj_1')
    await umaAcordadaPorCiclo(disparar)('qa', 'proj_1')
    expect(disparar).toHaveBeenCalledTimes(2)
  })

  it('propaga o erro do disparo — nunca engole falha alheia', async () => {
    const gate = umaAcordadaPorCiclo(async () => {
      throw new Error('portão de concorrência recusou')
    })
    await expect(gate('qa', 'proj_1')).rejects.toThrow('portão de concorrência recusou')
  })
})
