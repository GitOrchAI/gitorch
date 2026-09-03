import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lerCadenciaMs } from './cadencia-de-varredura.js'

/**
 * A3 (fix-up L4-T3): o padrão "lê `process.env[nomeEnv]`, `Number(...)`,
 * `<= 0`/`NaN` cai pro padrão E avisa" se repetia (cadência da reconciliação
 * de dúvidas, da varredura de quadro, dos itens da sprint, do custo da
 * ordem...) — cada cópia é um lugar a mais onde a guarda pode divergir
 * (a cicatriz documentada nos comentários do próprio scheduler.ts:
 * `Number(x) ?? padrão` não protege nada — string vazia/texto/negativo
 * passam inteiros).
 */
const NOME_ENV = 'GITORCH_TESTE_CADENCIA_MS'

describe('lerCadenciaMs', () => {
  beforeEach(() => {
    delete process.env[NOME_ENV]
  })
  afterEach(() => {
    delete process.env[NOME_ENV]
  })

  it('env ausente: devolve o padrão, nunca avisa', () => {
    const onWarn = vi.fn()

    expect(lerCadenciaMs(NOME_ENV, 5000, onWarn)).toBe(5000)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('env válida: devolve o valor da env, nunca avisa', () => {
    process.env[NOME_ENV] = '9000'
    const onWarn = vi.fn()

    expect(lerCadenciaMs(NOME_ENV, 5000, onWarn)).toBe(9000)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('env não numérica (NaN): devolve o padrão e avisa com o nome da env', () => {
    process.env[NOME_ENV] = 'abc'
    const onWarn = vi.fn()

    expect(lerCadenciaMs(NOME_ENV, 5000, onWarn)).toBe(5000)
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0]?.[0]).toContain(NOME_ENV)
  })

  it('env "0": devolve o padrão e avisa (zero rodaria a cada tique)', () => {
    process.env[NOME_ENV] = '0'
    const onWarn = vi.fn()

    expect(lerCadenciaMs(NOME_ENV, 5000, onWarn)).toBe(5000)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('env negativa: devolve o padrão e avisa', () => {
    process.env[NOME_ENV] = '-100'
    const onWarn = vi.fn()

    expect(lerCadenciaMs(NOME_ENV, 5000, onWarn)).toBe(5000)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('onWarn ausente (opcional): não lança mesmo com env inválida', () => {
    process.env[NOME_ENV] = 'lixo'

    expect(lerCadenciaMs(NOME_ENV, 5000)).toBe(5000)
  })
})
