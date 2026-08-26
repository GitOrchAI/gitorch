import { describe, it, expect } from 'vitest'
import { criarRegistroDeMotorMorto, DESCANSO_DO_MOTOR_MORTO_MS } from './motor-em-pausa.js'

const T0 = new Date('2026-08-26T10:00:00Z')
const depois = (ms: number) => new Date(T0.getTime() + ms)

describe('criarRegistroDeMotorMorto — o motor morto sai do rodízio', () => {
  it('motor que morreu pedindo login entra em pausa', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('codex', T0)).toBe(true)
  })

  it('os outros motores seguem normalmente', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('antigravity', T0)).toBe(false)
  })

  it('a cadeia perde só o motor morto', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual([{ runtime: 'antigravity' }])
  })

  it('sucesso apaga a marca NA HORA — motor religado volta sem ninguém pedir', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarVivo('codex')
    expect(r.estaEmPausa('codex', T0)).toBe(false)
  })

  it('o tempo tambem devolve o motor — para quem religou na mão, sem missão nenhuma', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS - 1))).toBe(true)
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS))).toBe(false)
  })

  it('falha em rajada NÃO estica o descanso para sempre', () => {
    // Remarcar a cada falha faria o motor nunca mais voltar.
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarMorto('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS - 1))
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS))).toBe(false)
  })

  it('cadeia INTEIRA em pausa devolve a original — proteção não pode parar a esteira', () => {
    // Ficar sem motor nenhum seria trocar um desperdício por uma paralisação.
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarMorto('antigravity', T0)
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual(cadeia)
  })

  it('cadeia sem motor morto passa inteira', () => {
    const r = criarRegistroDeMotorMorto()
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual(cadeia)
  })
})
