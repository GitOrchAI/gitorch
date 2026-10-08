import { afterEach, describe, expect, it, vi } from 'vitest'
import { criarDisparoEmSegundoPlano } from './disparo-em-segundo-plano.js'

function porta<T = void>() {
  let resolver!: (valor: T) => void
  let rejeitar!: (erro: unknown) => void
  const promessa = new Promise<T>((resolve, reject) => {
    resolver = resolve
    rejeitar = reject
  })
  return { promessa, resolver, rejeitar }
}

const proximoCiclo = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('criarDisparoEmSegundoPlano', () => {
  const rejeicoesSemTratamento: unknown[] = []
  const aoRejeitar = (motivo: unknown) => rejeicoesSemTratamento.push(motivo)

  afterEach(() => {
    process.off('unhandledRejection', aoRejeitar)
    rejeicoesSemTratamento.length = 0
  })

  function montar(executar: () => Promise<void>) {
    const onWarn = vi.fn()
    const onDebug = vi.fn()
    const disparar = criarDisparoEmSegundoPlano({ nome: 'etapa-x', executar, onWarn, onDebug })
    return { disparar, onWarn, onDebug }
  }

  it('devolve na hora, sem esperar a etapa que ainda não terminou', async () => {
    const { promessa, resolver } = porta()
    const executar = vi.fn(() => promessa)
    const { disparar } = montar(executar)

    const disparou = disparar()

    // a etapa foi iniciada, mas o disparo não ficou preso nela
    expect(disparou).toBe(true)
    expect(executar).toHaveBeenCalledTimes(1)
    resolver()
    await proximoCiclo()
  })

  it('com a etapa em voo, o disparo seguinte é pulado com uma linha de debug e não roda de novo', async () => {
    const { promessa, resolver } = porta()
    const executar = vi.fn(() => promessa)
    const { disparar, onDebug, onWarn } = montar(executar)

    expect(disparar()).toBe(true)
    expect(disparar()).toBe(false)
    expect(disparar()).toBe(false)

    expect(executar).toHaveBeenCalledTimes(1)
    expect(onDebug).toHaveBeenCalledTimes(2)
    expect(String(onDebug.mock.calls[0]?.[0])).toContain('etapa-x')
    expect(onWarn).not.toHaveBeenCalled()
    resolver()
    await proximoCiclo()
  })

  it('rejeição da etapa vira aviso e nunca uma rejeição sem tratamento', async () => {
    process.on('unhandledRejection', aoRejeitar)
    const falha = new Error('banco recusou')
    const { disparar, onWarn } = montar(async () => {
      throw falha
    })

    expect(disparar()).toBe(true)
    await proximoCiclo()
    await proximoCiclo()

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toBe(falha)
    expect(String(onWarn.mock.calls[0]?.[1])).toContain('etapa-x')
    expect(rejeicoesSemTratamento).toEqual([])
  })

  it('falha síncrona da etapa também vira aviso e libera a guarda', async () => {
    process.on('unhandledRejection', aoRejeitar)
    const executar = vi.fn((): Promise<void> => {
      throw new Error('quebrou antes de devolver a promessa')
    })
    const { disparar, onWarn } = montar(executar)

    expect(disparar()).toBe(true)
    await proximoCiclo()

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(rejeicoesSemTratamento).toEqual([])
    expect(disparar()).toBe(true)
    await proximoCiclo()
  })

  it('um onWarn que lança não gera rejeição sem tratamento e a guarda é liberada', async () => {
    process.on('unhandledRejection', aoRejeitar)
    const onWarn = vi.fn(() => {
      throw new Error('o log quebrou')
    })
    const executar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('a etapa falhou'))
      .mockResolvedValueOnce(undefined)
    const disparar = criarDisparoEmSegundoPlano({
      nome: 'etapa-x',
      executar,
      onWarn,
      onDebug: vi.fn(),
    })

    expect(disparar()).toBe(true)
    await proximoCiclo()
    await proximoCiclo()

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(rejeicoesSemTratamento).toEqual([])
    expect(disparar()).toBe(true)
    await proximoCiclo()
    expect(executar).toHaveBeenCalledTimes(2)
  })

  it('um onDebug que lança não derruba quem dispara nem solta a etapa em voo', async () => {
    const { promessa, resolver } = porta()
    const executar = vi.fn(() => promessa)
    const disparar = criarDisparoEmSegundoPlano({
      nome: 'etapa-x',
      executar,
      onWarn: vi.fn(),
      onDebug: () => {
        throw new Error('o log de debug quebrou')
      },
    })

    expect(disparar()).toBe(true)
    expect(() => disparar()).not.toThrow()
    expect(disparar()).toBe(false)
    expect(executar).toHaveBeenCalledTimes(1)
    resolver()
    await proximoCiclo()
  })

  it('depois de resolvida, o próximo disparo roda de novo', async () => {
    const primeira = porta()
    const segunda = porta()
    const executar = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(primeira.promessa)
      .mockReturnValueOnce(segunda.promessa)
    const { disparar } = montar(executar)

    expect(disparar()).toBe(true)
    expect(disparar()).toBe(false)
    primeira.resolver()
    await proximoCiclo()

    expect(disparar()).toBe(true)
    expect(executar).toHaveBeenCalledTimes(2)
    segunda.resolver()
    await proximoCiclo()
  })

  it('depois de uma falha, o próximo disparo roda de novo', async () => {
    const executar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('primeira falhou'))
      .mockResolvedValueOnce(undefined)
    const { disparar, onWarn } = montar(executar)

    expect(disparar()).toBe(true)
    await proximoCiclo()
    expect(disparar()).toBe(true)
    await proximoCiclo()

    expect(executar).toHaveBeenCalledTimes(2)
    expect(onWarn).toHaveBeenCalledTimes(1)
  })
})
