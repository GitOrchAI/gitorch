import { describe, expect, it } from 'vitest'
import { autorLegivel, LIMITE_DO_TEXTO_DO_DESEJO, montarDesejo } from './desejo.js'

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

// Quem assina a issue é a PESSOA. As duas portas do pedido (a tela e o
// mensageiro) escreviam essa assinatura cada uma do seu jeito: uma com o nome
// de gente, a outra com o identificador interno do banco. O mesmo dono, o mesmo
// pedido, e duas assinaturas diferentes — uma delas ilegível e, num repositório
// público, um dado interno do produto exposto sem motivo.
describe('autorLegivel — a assinatura que uma pessoa reconhece', () => {
  it('com nome e usuário, escreve os dois', () => {
    expect(autorLegivel({ nome: 'Guilherme Souza', arroba: 'guilherme' }, 'clx3k9')).toBe(
      'Guilherme Souza (@guilherme)'
    )
  })

  it('só com usuário, escreve o usuário', () => {
    expect(autorLegivel({ nome: null, arroba: 'guilherme' }, 'clx3k9')).toBe('@guilherme')
  })

  it('só com nome, escreve o nome', () => {
    expect(autorLegivel({ nome: 'Guilherme Souza', arroba: null }, 'clx3k9')).toBe(
      'Guilherme Souza'
    )
  })

  it('espaço em branco não conta como nome nem como usuário', () => {
    expect(autorLegivel({ nome: '   ', arroba: '  ' }, 'clx3k9')).toBe('clx3k9')
  })

  it('sem nada que uma pessoa reconheça, sobra o identificador da conta', () => {
    // Último recurso de propósito: uma linha "Pedido por:" vazia seria pior —
    // ninguém saberia sequer que houve um pedido de alguém.
    expect(autorLegivel({}, 'clx3k9')).toBe('clx3k9')
  })
})

describe('LIMITE_DO_TEXTO_DO_DESEJO', () => {
  it('fica abaixo do teto de corpo de issue do GitHub, com folga para o rodapé', () => {
    // O corpo carrega o pedido MAIS o rodapé (quem pediu, de onde veio), e o
    // texto ainda cresce ao ter os comandos de fechar issue neutralizados.
    expect(LIMITE_DO_TEXTO_DO_DESEJO).toBeLessThan(65_536)
  })
})
