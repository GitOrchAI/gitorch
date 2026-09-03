import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lerCadenciaMs, lerInteiroDaEnv } from './cadencia-de-varredura.js'

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

// C3 (fix-up L4-T5, CSO): mesmo padrão de `lerCadenciaMs`, mas para um TETO
// inteiro (ex.: `GITORCH_RETOMADAS_POR_PR`) em vez de milissegundos — a
// mesma cicatriz (`Number(x)` deixa passar string vazia/texto/negativo)
// vale igual aqui.
const NOME_ENV_INTEIRO = 'GITORCH_TESTE_INTEIRO'

describe('lerInteiroDaEnv', () => {
  beforeEach(() => {
    delete process.env[NOME_ENV_INTEIRO]
  })
  afterEach(() => {
    delete process.env[NOME_ENV_INTEIRO]
  })

  it('env ausente: devolve o padrão, nunca avisa', () => {
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(3)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('env válida: devolve o valor da env, nunca avisa', () => {
    process.env[NOME_ENV_INTEIRO] = '5'
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(5)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('env não numérica (NaN): devolve o padrão e avisa com o nome da env', () => {
    process.env[NOME_ENV_INTEIRO] = 'abc'
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(3)
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0]?.[0]).toContain(NOME_ENV_INTEIRO)
  })

  it('env "0": devolve o padrão e avisa', () => {
    process.env[NOME_ENV_INTEIRO] = '0'
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(3)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('env negativa: devolve o padrão e avisa', () => {
    process.env[NOME_ENV_INTEIRO] = '-2'
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(3)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('env decimal (não inteira): devolve o padrão e avisa', () => {
    process.env[NOME_ENV_INTEIRO] = '2.5'
    const onWarn = vi.fn()
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3, onWarn)).toBe(3)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('onWarn ausente (opcional): não lança mesmo com env inválida', () => {
    process.env[NOME_ENV_INTEIRO] = 'lixo'
    expect(lerInteiroDaEnv(NOME_ENV_INTEIRO, 3)).toBe(3)
  })
})
