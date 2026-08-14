import { describe, it, expect } from 'vitest'
import { lerDiffDoPr, LIMITE_DE_CARACTERES } from './diff-do-pr.js'

describe('lerDiffDoPr', () => {
  it('vira a página até o fim — hoje para em 50 arquivos', async () => {
    const p1 = Array.from({ length: 100 }, (_, i) => ({ filename: `a${i}.ts`, patch: '+x' }))
    const p2 = Array.from({ length: 30 }, (_, i) => ({ filename: `b${i}.ts`, patch: '+y' }))
    const paginas = [p1, p2]
    let chamadas = 0
    const r = await lerDiffDoPr({ buscarPagina: async () => paginas[chamadas++] ?? [] })
    expect(r.arquivos).toBe(130)
    expect(r.truncado).toBe(false)
    expect(chamadas).toBe(3) // duas com conteúdo + a que devolve vazio
  })

  it('marca truncado quando estoura o limite de caracteres', async () => {
    const grande = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: 'x'.repeat(10_000),
    }))
    let chamadas = 0
    const r = await lerDiffDoPr({ buscarPagina: async () => (chamadas++ === 0 ? grande : []) })
    expect(r.truncado).toBe(true)
    expect(r.diff.length).toBeLessThanOrEqual(LIMITE_DE_CARACTERES)
  })

  it('para de virar página assim que estoura, sem gastar chamada à toa', async () => {
    const grande = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: 'x'.repeat(10_000),
    }))
    let chamadas = 0
    await lerDiffDoPr({
      buscarPagina: async () => {
        chamadas++
        return grande
      },
    })
    expect(chamadas).toBe(1)
  })

  it('PR vazio não é truncado', async () => {
    expect(await lerDiffDoPr({ buscarPagina: async () => [] })).toEqual({
      diff: '',
      arquivos: 0,
      truncado: false,
    })
  })

  it('arquivo sem trecho de mudança (binário) entra pelo nome', async () => {
    let chamadas = 0
    const r = await lerDiffDoPr({
      buscarPagina: async () => (chamadas++ === 0 ? [{ filename: 'logo.png' }] : []),
    })
    expect(r.arquivos).toBe(1)
    expect(r.diff).toContain('logo.png')
    expect(r.diff).toContain('(sem trecho de mudança legível)')
  })
})
