import { describe, it, expect } from 'vitest'
import {
  chavesDosCartoes,
  rotuloDoDenominador,
  rotuloDoGrupo,
  navegacao,
  PAGINA_INICIAL,
} from './entregas-paginacao'

// --- O BLOQUEADOR ------------------------------------------------------------
//
// Virar a página deixava cartões da página anterior na tela: a API devolvia 25
// e o navegador desenhava 33 na página 2 e 37 na 3.
//
// A CAUSA, medida no banco do dono em 31/08/2026: a `key` do <Card> era
// `${projeto}-${pedido}`, e `pedido` NÃO é único — há 200 sessões para 99
// pedidos. Contando as colisões por página de 25, na ordem por data:
//
//   página 1 → 25 linhas, 17 keys únicas, 8 colisões
//   página 2 → 25 linhas, 21 keys únicas, 4 colisões
//
// Quando duas crianças da mesma lista têm a mesma key, o React monta o mapa de
// reconciliação por key e o segundo fiber SOBRESCREVE o primeiro; o fiber
// sombreado não é reaproveitado nem apagado, e o nó de DOM dele FICA na tela.
// Daí a aritmética exata que o QA viu: 25 + 8 = 33, depois 33 + 4 = 37.
//
// Este módulo existe para que essa chave tenha teste. O padrão do app web é
// testar lógica em `.ts` (vitest com environment 'node'); era por estar solta
// dentro do .tsx que a chave atravessou revisão sem ninguém conferir.
describe('chavesDosCartoes — duas crianças nunca compartilham key', () => {
  it('a lista honesta (um pedido por cartão) fica com uma key por pedido', () => {
    const chaves = chavesDosCartoes([
      { projeto: 'gitorch', pedido: 10 },
      { projeto: 'gitorch', pedido: 11 },
      { projeto: 'patinhas', pedido: 10 },
    ])
    expect(new Set(chaves).size).toBe(3)
  })

  it('o mesmo pedido repetido NÃO gera key repetida', () => {
    // A forma exata do payload antigo: uma linha por SESSÃO, e o mesmo pedido
    // aparecendo várias vezes na mesma página.
    const chaves = chavesDosCartoes([
      { projeto: 'gitorch', pedido: 42 },
      { projeto: 'gitorch', pedido: 42 },
      { projeto: 'gitorch', pedido: 42 },
    ])
    expect(new Set(chaves).size).toBe(3)
  })

  it('a página de 25 com 8 colisões — o caso medido — sai com 25 keys distintas', () => {
    const pagina = Array.from({ length: 25 }, (_, i) => ({
      projeto: 'gitorch',
      // 17 pedidos distintos em 25 linhas: exatamente as 8 colisões da página 1.
      pedido: 100 + (i % 17),
    }))
    const chaves = chavesDosCartoes(pagina)
    expect(chaves).toHaveLength(25)
    expect(new Set(chaves).size).toBe(25)
  })

  it('a key não muda quando o pedido não repete — nada de key por posição', () => {
    // Key por índice mudaria de significado a cada virada de página. A key tem
    // que descrever O QUE o cartão é.
    const a = chavesDosCartoes([{ projeto: 'gitorch', pedido: 7 }])
    const b = chavesDosCartoes([
      { projeto: 'gitorch', pedido: 1 },
      { projeto: 'gitorch', pedido: 7 },
    ])
    expect(b[1]).toBe(a[0])
  })

  it('projetos diferentes com o mesmo número de pedido não colidem', () => {
    const chaves = chavesDosCartoes([
      { projeto: 'gitorch', pedido: 3 },
      { projeto: 'patinhas-3d-crafts', pedido: 3 },
    ])
    expect(new Set(chaves).size).toBe(2)
  })
})

// --- O denominador -----------------------------------------------------------
describe('rotuloDoDenominador — a unidade é a do cartão, e ausência não é zero', () => {
  it('conta pedidos, e o cartão se chama "Pedido #N"', () => {
    expect(rotuloDoDenominador(99)).toBe('de 99 pedidos que passaram pela sua régua')
  })

  it('singular quando há um só', () => {
    expect(rotuloDoDenominador(1)).toBe('de 1 pedido que passou pela sua régua')
  })

  it('campo AUSENTE não vira "de 0" — a tela cala em vez de mentir', () => {
    // O default vazio que já nos custou caro: `?? 0` colocaria "de 0 que
    // passaram pela sua régua" ao lado de um número real.
    expect(rotuloDoDenominador(null)).toBeNull()
  })

  it('zero de verdade continua sendo dito', () => {
    expect(rotuloDoDenominador(0)).toBe('de 0 pedidos que passaram pela sua régua')
  })
})

// --- O grupo é visível, nunca um filtro escondido ----------------------------
describe('rotuloDoGrupo — o dono lê no cabeçalho o que a lista está mostrando', () => {
  it('nas prontas, o cabeçalho diz que a lista é das prontas', () => {
    expect(rotuloDoGrupo('prontas', 15)).toBe(
      '15 entregas prontas, da mais recente para a mais antiga'
    )
  })

  it('no andando, o cabeçalho diz que essas NÃO fecharam', () => {
    expect(rotuloDoGrupo('andando', 84)).toBe(
      '84 pedidos que ainda não fecharam, com o que falta em cada um'
    )
  })

  it('uma só entrega pronta fala no singular', () => {
    expect(rotuloDoGrupo('prontas', 1)).toBe('1 entrega pronta')
  })

  it('nenhuma pronta é dito, não escondido', () => {
    expect(rotuloDoGrupo('prontas', 0)).toBe('nenhuma entrega pronta ainda')
  })

  it('contagem desconhecida não vira zero', () => {
    expect(rotuloDoGrupo('prontas', null)).toBe('entregas prontas')
  })
})

describe('navegacao — só oferece a página que existe', () => {
  it('na primeira página não deixa voltar', () => {
    const n = navegacao({ pagina: 1, paginas: 8 })
    expect(n.podeVoltar).toBe(false)
    expect(n.podeAvancar).toBe(true)
    expect(n.rotulo).toBe('Página 1 de 8')
  })

  it('na última página não deixa avançar', () => {
    const n = navegacao({ pagina: 8, paginas: 8 })
    expect(n.podeVoltar).toBe(true)
    expect(n.podeAvancar).toBe(false)
  })

  it('com uma página só, não navega para lado nenhum', () => {
    expect(navegacao({ pagina: 1, paginas: 1 })).toMatchObject({
      podeVoltar: false,
      podeAvancar: false,
    })
  })

  it('sem página nenhuma não navega nem estoura', () => {
    expect(navegacao({ pagina: 1, paginas: 0 })).toMatchObject({
      podeVoltar: false,
      podeAvancar: false,
      rotulo: '',
    })
  })

  it('a primeira página é 1 — humano conta a partir de um', () => {
    expect(PAGINA_INICIAL).toBe(1)
  })
})
