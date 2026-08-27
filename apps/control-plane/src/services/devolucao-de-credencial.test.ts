import { describe, expect, it, vi } from 'vitest'
import { esperarAVezDeDevolver, ESPERA_MAXIMA_PELA_TRAVA_MS } from './devolucao-de-credencial.js'

describe('esperar a vez de devolver', () => {
  it('pegou de primeira: não espera nada', async () => {
    const esperar = vi.fn(async () => undefined)
    const pegou = await esperarAVezDeDevolver({
      pegar: async () => true,
      esperar,
      agora: () => 0,
    })
    expect(pegou).toBe(true)
    expect(esperar).not.toHaveBeenCalled()
  })

  it('trava ocupada: ESPERA em vez de desistir — era aqui que a credencial se perdia', async () => {
    let tentativas = 0
    let relogio = 0
    const pegou = await esperarAVezDeDevolver({
      pegar: async () => {
        tentativas += 1
        return tentativas >= 3
      },
      esperar: async (ms) => {
        relogio += ms
      },
      agora: () => relogio,
    })
    expect(pegou).toBe(true)
    expect(tentativas).toBe(3)
  })

  it('estourou o tempo: devolve false, e quem chama devolve MESMO ASSIM', async () => {
    // Perder o único token válido é pior que uma escrita concorrente, que no
    // máximo regrava o mesmo valor. O código anterior desistia calado e matava
    // a conexão do cliente.
    let relogio = 0
    const pegou = await esperarAVezDeDevolver({
      pegar: async () => false,
      esperar: async (ms) => {
        relogio += ms
      },
      agora: () => relogio,
    })
    expect(pegou).toBe(false)
    expect(relogio).toBeGreaterThanOrEqual(ESPERA_MAXIMA_PELA_TRAVA_MS)
  })

  it('nunca fica preso para sempre numa trava que não solta', async () => {
    let relogio = 0
    await esperarAVezDeDevolver({
      pegar: async () => false,
      esperar: async (ms) => {
        relogio += ms
      },
      agora: () => relogio,
      tetoMs: 5_000,
    })
    expect(relogio).toBeLessThanOrEqual(6_000)
  })
})
