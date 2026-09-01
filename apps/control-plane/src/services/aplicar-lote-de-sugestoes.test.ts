import { describe, it, expect, vi } from 'vitest'
import { aplicarLoteDeSugestoes } from './aplicar-lote-de-sugestoes.js'
import type { ItemComDecisao } from './lote-de-sugestoes.js'

function item(over: Partial<ItemComDecisao> = {}): ItemComDecisao {
  return {
    issue: 1,
    categoria: 'ja_resolvido',
    acao: 'fechar',
    motivo: 'o código já resolve isto',
    decisao: 'aprovado',
    ...over,
  }
}

describe('aplicarLoteDeSugestoes — nada é aplicado antes do aval, e o aval é obedecido item a item', () => {
  it('item recusado: nunca chama fecharIssue', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes([item({ decisao: 'recusado' })], {
      nivel: 'cuidar',
      fecharIssue,
    })
    expect(fecharIssue).not.toHaveBeenCalled()
    expect(r[0]).toMatchObject({ issue: 1, aplicado: false })
    expect(r[0]?.motivoDoResultado).toMatch(/recusad/i)
  })

  it('item aprovado, categoria "fechar", nível "cuidar": aplica e fecha a issue', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 42, categoria: 'ja_resolvido', acao: 'fechar', decisao: 'aprovado' })],
      { nivel: 'cuidar', fecharIssue }
    )
    expect(fecharIssue).toHaveBeenCalledTimes(1)
    expect(fecharIssue.mock.calls[0]?.[0]).toBe(42)
    expect(typeof fecharIssue.mock.calls[0]?.[1]).toBe('string')
    expect(r[0]).toMatchObject({ issue: 42, aplicado: true })
  })

  it('item aprovado, categoria "juntar": o comentário cita a issue original', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    await aplicarLoteDeSugestoes(
      [
        item({
          issue: 7,
          categoria: 'repetido',
          acao: 'juntar',
          motivo: '90% de sobreposição com a issue #3',
          duplicadaDe: 3,
          decisao: 'aprovado',
        }),
      ],
      { nivel: 'cuidar', fecharIssue }
    )
    const comentario = fecharIssue.mock.calls[0]?.[1] as string
    expect(comentario).toContain('#3')
  })

  it('item aprovado, categoria "sinalizar": nunca chama fecharIssue — não existe ação de escrita', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 9, categoria: 'risco', acao: 'sinalizar', decisao: 'aprovado' })],
      { nivel: 'cuidar', fecharIssue }
    )
    expect(fecharIssue).not.toHaveBeenCalled()
    expect(r[0]).toMatchObject({ issue: 9, aplicado: false })
  })

  // A GUARDA DE AUTONOMIA — a mesma classificação de guarda-de-autonomia.ts
  // (`classificarRequisicao`: fechar/comentar issue = 'propor'), não uma
  // tabela paralela. "so_olhar" mostra e para: mesmo aprovado pelo dono, a
  // escrita é recusada, com o motivo dizendo por quê.
  it('nível "so_olhar": aprovado pelo dono mesmo assim NÃO aplica — mostra e para', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 5, categoria: 'ja_resolvido', acao: 'fechar', decisao: 'aprovado' })],
      { nivel: 'so_olhar', fecharIssue }
    )
    expect(fecharIssue).not.toHaveBeenCalled()
    expect(r[0]).toMatchObject({ issue: 5, aplicado: false })
    expect(r[0]?.motivoDoResultado).toMatch(/so_olhar|Só olhar/)
  })

  it('nível "sugerir": aprovado pelo dono APLICA (fechar/juntar são "propor", já liberado)', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 6, categoria: 'ja_resolvido', acao: 'fechar', decisao: 'aprovado' })],
      { nivel: 'sugerir', fecharIssue }
    )
    expect(fecharIssue).toHaveBeenCalledTimes(1)
    expect(r[0]).toMatchObject({ issue: 6, aplicado: true })
  })

  it('nível nulo/desconhecido cai no mais restrito — nunca aplica', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 8, categoria: 'ja_resolvido', acao: 'fechar', decisao: 'aprovado' })],
      { nivel: null, fecharIssue }
    )
    expect(fecharIssue).not.toHaveBeenCalled()
    expect(r[0]?.aplicado).toBe(false)
  })

  it('falha de rede ao fechar NÃO lança — vira resultado com o motivo real, e o lote continua', async () => {
    const fecharIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub 502'))
      .mockResolvedValueOnce(undefined)
    const r = await aplicarLoteDeSugestoes(
      [item({ issue: 1, decisao: 'aprovado' }), item({ issue: 2, decisao: 'aprovado' })],
      { nivel: 'cuidar', fecharIssue }
    )
    expect(r[0]).toMatchObject({ issue: 1, aplicado: false })
    expect(r[0]?.motivoDoResultado).toContain('GitHub 502')
    expect(r[1]).toMatchObject({ issue: 2, aplicado: true })
  })

  it('lote misto: cada item recebe seu próprio resultado, na mesma ordem', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes(
      [
        item({ issue: 1, categoria: 'ja_resolvido', acao: 'fechar', decisao: 'aprovado' }),
        item({ issue: 2, categoria: 'repetido', acao: 'juntar', decisao: 'recusado' }),
        item({ issue: 3, categoria: 'risco', acao: 'sinalizar', decisao: 'aprovado' }),
      ],
      { nivel: 'cuidar', fecharIssue }
    )
    expect(r.map((x) => x.issue)).toEqual([1, 2, 3])
    expect(r[0]?.aplicado).toBe(true)
    expect(r[1]?.aplicado).toBe(false)
    expect(r[2]?.aplicado).toBe(false)
    expect(fecharIssue).toHaveBeenCalledTimes(1)
  })

  it('lote vazio: devolve lista vazia, nunca chama fecharIssue', async () => {
    const fecharIssue = vi.fn(async (_issueNumber: number, _comentario: string) => undefined)
    const r = await aplicarLoteDeSugestoes([], { nivel: 'cuidar', fecharIssue })
    expect(r).toEqual([])
    expect(fecharIssue).not.toHaveBeenCalled()
  })
})
