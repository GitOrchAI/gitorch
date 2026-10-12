import { describe, expect, it } from 'vitest'
import {
  corpoDoRegistroDeEntrega,
  jaTemRegistroDeEntrega,
  textoDePublicacaoNaoConfirmada,
  textoDoRegistroDeEntrega,
} from './registro-de-entrega.js'

describe('o texto do registro de entrega', () => {
  it('um PR: registro seco com o número e como desfazer', () => {
    expect(textoDoRegistroDeEntrega([42])).toBe(
      'Entregue pelo PR #42. Para desfazer: reabrir esta issue.'
    )
  })

  it('vários PRs: cita todos, do mais antigo ao mais novo, no plural', () => {
    expect(textoDoRegistroDeEntrega([202, 216, 218])).toBe(
      'Entregue pelos PRs #202, #216 e #218. Para desfazer: reabrir esta issue.'
    )
    expect(textoDoRegistroDeEntrega([7, 9])).toBe(
      'Entregue pelos PRs #7 e #9. Para desfazer: reabrir esta issue.'
    )
  })

  it('cita no máximo cinco, ficando com os mais novos', () => {
    expect(textoDoRegistroDeEntrega([1, 2, 3, 4, 5, 6, 7])).toBe(
      'Entregue pelos PRs #3, #4, #5, #6 e #7. Para desfazer: reabrir esta issue.'
    )
  })

  it('sem número de PR continua verdadeiro, sem citar "#null"', () => {
    const texto = textoDoRegistroDeEntrega([])
    expect(texto).toBe('Entregue por uma entrega já mesclada. Para desfazer: reabrir esta issue.')
  })

  it('não diz nada sobre quem mesclou nem pede ação a ninguém', () => {
    const texto = textoDoRegistroDeEntrega([202, 216])
    expect(texto).not.toMatch(/mesclou|produto|GitOrch|alguém|auto-merge|confira|por favor/i)
  })
})

describe('o marcador do registro', () => {
  it('o comentário leva um marcador oculto e o texto continua o mesmo', () => {
    const corpo = corpoDoRegistroDeEntrega([42])
    expect(corpo).toContain('<!--')
    expect(corpo.replace(/<!--.*?-->\n?/s, '').trim()).toBe(textoDoRegistroDeEntrega([42]))
  })

  it('reconhece o registro que já existe entre os comentários', () => {
    const existente = { body: corpoDoRegistroDeEntrega([42]) }
    expect(jaTemRegistroDeEntrega([{ body: 'outra coisa' }, existente])).toBe(true)
    expect(jaTemRegistroDeEntrega([{ body: 'outra coisa' }, { body: null }, {}])).toBe(false)
  })
})

describe('o comentário de publicação não confirmada', () => {
  it('diz o fato e o motivo, sem pedir resolução manual nem ação a ninguém', () => {
    const texto = textoDePublicacaoNaoConfirmada(42, 'Nenhuma execução apareceu para o commit.')
    expect(texto).toContain('PR #42')
    expect(texto).toContain('Nenhuma execução apareceu para o commit.')
    expect(texto).toContain('não conseguiu confirmar que a publicação dela foi ao ar')
    expect(texto).not.toMatch(/continua aberta|(?<![\p{L}])(?:até|ate|será|sera)(?![\p{L}])/iu)
    expect(texto).not.toMatch(/manualmente|resolvid|confira|por favor|revis[ãa]o humana|decida/i)
  })
})
