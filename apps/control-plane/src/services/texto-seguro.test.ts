import { describe, expect, it } from 'vitest'
import {
  cortarPorPontoDeCodigo,
  limparSurrogates,
  limparSurrogatesEmJson,
  mascararCredenciais,
  mensagemDoErro,
  resumirErro,
} from './texto-seguro.js'

const EMOJI = '\u{1F600}'
const ALTO_SOLTO = '\uD83D'
const BAIXO_SOLTO = '\uDE00'

function temSurrogateSolto(texto: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(texto)
}

describe('limparSurrogates', () => {
  it('troca o surrogate solto (alto ou baixo) por U+FFFD e deixa o par inteiro', () => {
    expect(limparSurrogates(`a${ALTO_SOLTO}b`)).toBe('a�b')
    expect(limparSurrogates(`a${BAIXO_SOLTO}b`)).toBe('a�b')
    expect(limparSurrogates(`a${EMOJI}b`)).toBe(`a${EMOJI}b`)
    expect(limparSurrogates(`fim${ALTO_SOLTO}`)).toBe('fim�')
  })

  it('o resultado sobrevive a um JSON.stringify seguido de parse sem escape de surrogate solto', () => {
    const json = JSON.stringify(limparSurrogates(`x${ALTO_SOLTO}y`))
    expect(json).not.toMatch(/\\ud[89ab]/i)
  })
})

describe('cortarPorPontoDeCodigo', () => {
  it('texto que cabe volta igual', () => {
    expect(cortarPorPontoDeCodigo('abc', 3)).toBe('abc')
    expect(cortarPorPontoDeCodigo(`ab${EMOJI}`, 3)).toBe(`ab${EMOJI}`)
  })

  it('sem sufixo: corta em N pontos de código, nunca no meio de um par', () => {
    // O emoji ocupa as unidades 1 e 2 (UTF-16); cortar em 2 unidades deixaria o alto solto.
    const cortado = cortarPorPontoDeCodigo(`a${EMOJI}${EMOJI}zzz`, 2)
    expect(cortado).toBe(`a${EMOJI}`)
    expect(temSurrogateSolto(cortado)).toBe(false)
  })

  it('com sufixo: o total, sufixo incluído, tem no máximo N pontos', () => {
    const texto = `${'x'.repeat(197)}${EMOJI}${EMOJI}${EMOJI}${EMOJI}`
    const cortado = cortarPorPontoDeCodigo(texto, 200, { sufixo: '…' })
    expect(Array.from(cortado)).toHaveLength(200)
    expect(cortado.endsWith(`${EMOJI}${EMOJI}…`)).toBe(true)
    expect(temSurrogateSolto(cortado)).toBe(false)
    expect(() => JSON.parse(JSON.stringify(cortado))).not.toThrow()
  })

  it('o emoji exatamente na fronteira (unidades 198-199) não deixa surrogate solto', () => {
    const texto = `${'x'.repeat(198)}${EMOJI}${'y'.repeat(50)}`
    const cortado = cortarPorPontoDeCodigo(texto, 200, { sufixo: '…' })
    expect(temSurrogateSolto(cortado)).toBe(false)
    expect(cortado).toBe(`${'x'.repeat(198)}${EMOJI}…`)
    expect(Array.from(cortado)).toHaveLength(200)
  })

  it('aparar tira o espaço que sobra antes do sufixo', () => {
    expect(cortarPorPontoDeCodigo('abc   def', 6, { sufixo: '…', aparar: true })).toBe('abc…')
  })

  it('surrogate solto na ENTRADA some antes do corte', () => {
    const cortado = cortarPorPontoDeCodigo(`ab${ALTO_SOLTO}cd`, 10)
    expect(cortado).toBe('ab�cd')
    expect(temSurrogateSolto(cortado)).toBe(false)
  })

  it('surrogate solto na entrada que cabe inteira também é limpo', () => {
    expect(temSurrogateSolto(cortarPorPontoDeCodigo(`${BAIXO_SOLTO}`, 5))).toBe(false)
  })
})

describe('limparSurrogatesEmJson', () => {
  it('limpa textos, chaves, listas e objetos aninhados sem mexer no resto', () => {
    const entrada = {
      a: `x${ALTO_SOLTO}`,
      [`k${BAIXO_SOLTO}`]: [`y${ALTO_SOLTO}z`, 3, true, null, { b: `${BAIXO_SOLTO}` }],
      n: 5,
    }
    const saida = limparSurrogatesEmJson(entrada)
    expect(saida).toEqual({
      a: 'x�',
      'k�': ['y�z', 3, true, null, { b: '�' }],
      n: 5,
    })
    expect(temSurrogateSolto(JSON.stringify(saida))).toBe(false)
  })

  it('valor sem problema volta igual em conteúdo', () => {
    const entrada = { a: 'ok', b: [1, 2], c: { d: EMOJI } }
    expect(limparSurrogatesEmJson(entrada)).toEqual(entrada)
  })
})

describe('mascararCredenciais', () => {
  it('troca o segredo conhecido em qualquer posição', () => {
    expect(mascararCredenciais('falhou com tok-secreto-123 no meio', ['tok-secreto-123'])).toBe(
      'falhou com *** no meio'
    )
  })

  it('troca padrões de header e de token mesmo sem conhecer o segredo', () => {
    const casos = [
      'Authorization: Bearer abc.def-123',
      'authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'Authorization: Basic dXNlcjpwYXNz',
      'Bearer abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789',
      'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
      'https://usuario:senha-secreta@api.github.com/x',
    ]
    for (const caso of casos) {
      const saida = mascararCredenciais(`erro: ${caso} fim`)
      expect(saida).not.toMatch(/abc\.def|abcdefghijkl|dXNlcjpwYXNz|senha-secreta|11ABCDEFG0/)
      expect(saida).toContain('***')
    }
  })

  it('texto sem credencial fica como está', () => {
    expect(mascararCredenciais('fetch failed: ECONNRESET')).toBe('fetch failed: ECONNRESET')
  })

  it('segredo vazio ou muito curto não apaga o texto todo', () => {
    expect(mascararCredenciais('abc', [''])).toBe('abc')
  })
})

// Tudo que pode ser lançado: `throw` aceita qualquer valor, e o caminho de erro
// não pode ser o lugar onde a próxima exceção nasce.
const SEMPRE_ILEGIVEL = {
  toString() {
    throw new Error('toString quebrou')
  },
}
const VALORES_LANCADOS: ReadonlyArray<readonly [string, unknown]> = [
  ['texto', 'falhou'],
  ['undefined', undefined],
  ['null', null],
  ['número', 42],
  ['símbolo', Symbol('s')],
  ['objeto sem message', { codigo: 'E1' }],
  ['objeto sem protótipo', Object.create(null)],
  ['objeto cujo toString lança', SEMPRE_ILEGIVEL],
  [
    'erro cujo message lança',
    Object.defineProperty(new Error('x'), 'message', {
      get() {
        throw new Error('getter quebrou')
      },
    }),
  ],
]

describe('mascararCredenciais e resumirErro aceitam qualquer entrada', () => {
  it.each(VALORES_LANCADOS)('resumirErro não lança com %s e devolve texto', (_nome, valor) => {
    const saida = resumirErro(valor, 200, ['tok-secreto-123'])
    expect(typeof saida).toBe('string')
  })

  it.each(VALORES_LANCADOS)(
    'mascararCredenciais não lança com %s e devolve texto',
    (_nome, valor) => {
      const saida = mascararCredenciais(valor as string, ['tok-secreto-123'])
      expect(typeof saida).toBe('string')
    }
  )

  it('segredos nulos, vazios ou que não são texto não derrubam nem apagam o texto', () => {
    expect(mascararCredenciais('abc', null as unknown as string[])).toBe('abc')
    expect(mascararCredenciais('abc def', [undefined, 7, null, ''] as unknown as string[])).toBe(
      'abc def'
    )
  })

  it('um erro com o token na mensagem sai sem o token, com e sem o segredo conhecido', () => {
    const com = resumirErro(new Error('falhou com tok-secreto-123 no meio'), 200, [
      'tok-secreto-123',
    ])
    expect(com).not.toContain('tok-secreto-123')
    const padrao = resumirErro(new Error('x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y'), 200)
    expect(padrao).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('um texto lançado (não-Error) com o token também sai mascarado', () => {
    expect(resumirErro('Bearer abcdefghijklmnop caiu', 200)).not.toContain('abcdefghijklmnop')
  })
})

describe('mensagemDoErro', () => {
  it('usa a mensagem de um erro e de qualquer objeto com message em texto', () => {
    expect(mensagemDoErro(new Error('rede caiu'))).toBe('rede caiu')
    expect(mensagemDoErro({ message: 'veio de outro realm' })).toBe('veio de outro realm')
  })

  it.each(VALORES_LANCADOS)('não lança com %s e devolve texto', (_nome, valor) => {
    expect(typeof mensagemDoErro(valor)).toBe('string')
  })

  it('texto lançado volta como está; undefined e null não somem em silêncio', () => {
    expect(mensagemDoErro('falhou')).toBe('falhou')
    expect(mensagemDoErro(undefined)).not.toBe('')
    expect(mensagemDoErro(null)).not.toBe('')
  })
})
