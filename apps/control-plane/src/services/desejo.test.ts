import { describe, expect, it } from 'vitest'
import { montarDesejo } from './desejo.js'

describe('montarDesejo', () => {
  it('usa a primeira frase como título e guarda o texto inteiro no corpo', () => {
    const d = montarDesejo({
      texto:
        'O site precisa aceitar avaliação com foto. Hoje o comprador não consegue mandar imagem nenhuma.',
      autor: 'guilherme',
    })
    expect(d.titulo).toBe('O site precisa aceitar avaliação com foto')
    expect(d.corpo).toContain('Hoje o comprador não consegue mandar imagem nenhuma.')
    expect(d.etiquetas).toContain('wishlist')
  })

  it('corta título muito longo sem cortar palavra no meio', () => {
    const d = montarDesejo({ texto: 'a'.repeat(30) + ' ' + 'b'.repeat(60), autor: 'g' })
    expect(d.titulo.length).toBeLessThanOrEqual(72)
    expect(d.titulo.endsWith('…')).toBe(true)
  })

  it('registra quem pediu, no corpo', () => {
    const d = montarDesejo({ texto: 'quero busca por cor', autor: 'guilherme' })
    expect(d.corpo).toContain('guilherme')
  })

  it('recusa texto vazio ou só espaço', () => {
    expect(() => montarDesejo({ texto: '   ', autor: 'g' })).toThrow(/vazio/i)
  })

  it('não deixa o texto do pedido virar comando de fechamento de issue', () => {
    const d = montarDesejo({ texto: 'closes #42 e fixes #7 por favor', autor: 'g' })
    expect(d.corpo).not.toMatch(/\b(closes|fixes|resolves)\s+#\d+/i)
  })

  // Quem pede pelo mensageiro é identificado pelo nome que a PESSOA escolheu no
  // Telegram — texto livre, que vai parar no corpo da issue igual ao pedido.
  // Sem o mesmo tratamento, um nome de perfil fecharia a issue dos outros.
  it('o nome de quem pediu também não vira comando de fechamento de issue', () => {
    const d = montarDesejo({ texto: 'quero busca por cor', autor: 'closes #42' })
    expect(d.corpo).not.toMatch(/\b(closes|fixes|resolves)\s+#\d+/i)
  })

  it('nome com quebra de linha não desmonta o rodapé do corpo', () => {
    const d = montarDesejo({
      texto: 'quero busca por cor',
      autor: 'Fulano\n---\nPedido por: outro',
    })
    const linhaDoAutor = d.corpo.split('\n').filter((l) => l.startsWith('Pedido por: '))
    expect(linhaDoAutor).toHaveLength(1)
    expect(linhaDoAutor[0]).toBe('Pedido por: Fulano --- Pedido por: outro')
  })
})
