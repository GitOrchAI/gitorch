import { describe, expect, test } from 'vitest'
import { validateDoD, DOD_FIELD_MAP } from '@gitorch/cadence'
import {
  aguardaSegundaLeituraDoAmbiente,
  chaveDeConserto,
  decidirConsertoDePublicacao,
  notaDeConserto,
  type EntradaDeConserto,
} from './conserto-de-publicacao.js'

const BASE = {
  repositorio: 'acme/api',
  shaDaMescla: 'deadbeefcafe1234567890abcdef1234567890ab',
  numeroDoPr: 42,
  issueDaEntrega: 7,
  marcaAnterior: null,
} satisfies Omit<EntradaDeConserto, 'evidencia'>

function publicacao(
  estado: string,
  extras: { marcaAnterior?: string | null } = {}
): EntradaDeConserto {
  return {
    ...BASE,
    ...extras,
    evidencia: {
      origem: 'publicacao',
      estado,
      motivo: 'a etapa "deploy prod" terminou em falha.',
      etapas: [
        { nome: 'build', resultado: 'success' },
        { nome: 'deploy prod', resultado: 'failure' },
      ],
    },
  }
}

function ambiente(
  veredito: string,
  observacoesSeguidas: number,
  extras: { marcaAnterior?: string | null; recusadoPelaGuarda?: boolean } = {}
): EntradaDeConserto {
  const { recusadoPelaGuarda = false, ...resto } = extras
  return {
    ...BASE,
    ...resto,
    evidencia: {
      origem: 'ambiente',
      veredito,
      motivo: '1 de 1 tela(s) testada(s) não respondeu(ram) bem: /.',
      enderecos: ['https://loja.exemplo.com'],
      recusadoPelaGuarda,
      testes: [{ caminho: '/', status: 503, ok: false }],
      observacoesSeguidas,
    },
  }
}

describe('decidirConsertoDePublicacao — quando a falha vira tarefa de conserto', () => {
  test('publicação que FALHOU abre a tarefa de conserto', () => {
    const decisao = decidirConsertoDePublicacao(publicacao('falhou'))
    expect(decisao.abrir).toBe(true)
  })

  test.each(['publicando', 'commit-errado', 'no-ar', 'sem-publicacao'])(
    'publicação em "%s" NÃO abre tarefa (não é veredito de falha desta vigília)',
    (estado) => {
      expect(decidirConsertoDePublicacao(publicacao(estado)).abrir).toBe(false)
    }
  )

  test('a MESMA falha reexaminada na varredura seguinte NÃO abre uma segunda tarefa', () => {
    const primeira = decidirConsertoDePublicacao(publicacao('falhou'))
    if (!primeira.abrir) throw new Error('a primeira decisão tinha de abrir')
    const segunda = decidirConsertoDePublicacao(
      publicacao('falhou', { marcaAnterior: primeira.chave })
    )
    expect(segunda.abrir).toBe(false)
    expect(segunda.abrir === false && segunda.motivo).toMatch(/já existe/i)
  })

  test('a marca de OUTRO commit não bloqueia o conserto do commit atual', () => {
    const decisao = decidirConsertoDePublicacao(
      publicacao('falhou', { marcaAnterior: chaveDeConserto('publicacao', 'outro-commit') })
    )
    expect(decisao.abrir).toBe(true)
  })

  test('ambiente que reprovou (a tela respondeu com código ruim) abre já na primeira leitura', () => {
    expect(decidirConsertoDePublicacao(ambiente('falhou', 1)).abrir).toBe(true)
  })

  test('projeto SEM endereço de ambiente nunca vira tarefa — não é defeito de código', () => {
    const decisao = decidirConsertoDePublicacao(ambiente('sem-endereco', 5))
    expect(decisao.abrir).toBe(false)
    expect(decisao.abrir === false && decisao.motivo).toMatch(/endereço/i)
  })

  test('ambiente inalcançável UMA vez é queda de rede, não defeito: não abre', () => {
    expect(decidirConsertoDePublicacao(ambiente('inalcancavel', 1)).abrir).toBe(false)
  })

  test('ambiente inalcançável DUAS leituras seguidas abre a tarefa', () => {
    expect(decidirConsertoDePublicacao(ambiente('inalcancavel', 2)).abrir).toBe(true)
  })

  test('endereço recusado pela guarda de rede nunca vira tarefa nem adia o fecho da entrega', () => {
    const decisao = decidirConsertoDePublicacao(
      ambiente('inalcancavel', 2, { recusadoPelaGuarda: true })
    )
    expect(decisao.abrir).toBe(false)
    expect(decisao.abrir === false && decisao.motivo).toMatch(/alcance/i)
    expect(
      aguardaSegundaLeituraDoAmbiente({
        veredito: 'inalcancavel',
        observacoesSeguidas: 1,
        recusadoPelaGuarda: true,
      })
    ).toBe(false)
  })

  test('só o ambiente inalcançável na primeira leitura adia o fecho da entrega', () => {
    const aguarda = (veredito: string, observacoesSeguidas: number): boolean =>
      aguardaSegundaLeituraDoAmbiente({
        veredito,
        observacoesSeguidas,
        recusadoPelaGuarda: false,
      })
    expect(aguarda('inalcancavel', 1)).toBe(true)
    expect(aguarda('inalcancavel', 2)).toBe(false)
    expect(aguarda('falhou', 1)).toBe(false)
    expect(aguarda('sem-endereco', 1)).toBe(false)
    expect(aguarda('passou', 1)).toBe(false)
  })

  test('ambiente que passou nunca abre tarefa', () => {
    expect(decidirConsertoDePublicacao(ambiente('passou', 3)).abrir).toBe(false)
  })

  test('publicação e ambiente têm chaves DIFERENTES para o mesmo commit', () => {
    expect(chaveDeConserto('publicacao', BASE.shaDaMescla)).not.toBe(
      chaveDeConserto('ambiente', BASE.shaDaMescla)
    )
  })
})

describe('o corpo da tarefa de conserto nasce no padrão Shrimp', () => {
  test('publicação: os 8 campos do DoD passam na validação do próprio produto', () => {
    const decisao = decidirConsertoDePublicacao(publicacao('falhou'))
    if (!decisao.abrir) throw new Error('esperava abrir')
    expect(validateDoD({ titulo: decisao.titulo, ...decisao.campos })).toEqual({
      ok: true,
      errors: [],
    })
  })

  test('ambiente: os 8 campos do DoD passam na validação do próprio produto', () => {
    const decisao = decidirConsertoDePublicacao(ambiente('falhou', 1))
    if (!decisao.abrir) throw new Error('esperava abrir')
    expect(validateDoD({ titulo: decisao.titulo, ...decisao.campos })).toEqual({
      ok: true,
      errors: [],
    })
  })

  test('o corpo publicado traz os 8 cabeçalhos canônicos, na ordem, mais o marcador', () => {
    const decisao = decidirConsertoDePublicacao(publicacao('falhou'))
    if (!decisao.abrir) throw new Error('esperava abrir')
    let cursor = -1
    for (const { header } of DOD_FIELD_MAP) {
      const posicao = decisao.corpo.indexOf(`## ${header}`)
      expect(posicao, `seção "${header}" ausente`).toBeGreaterThan(cursor)
      cursor = posicao
    }
    expect(decisao.corpo).toContain(`<!-- ${decisao.chave} -->`)
  })

  test('o Implementation Guide tem 3+ passos e o Verification Criteria 2+ critérios', () => {
    for (const entrada of [publicacao('falhou'), ambiente('falhou', 1)]) {
      const decisao = decidirConsertoDePublicacao(entrada)
      if (!decisao.abrir) throw new Error('esperava abrir')
      const passos = decisao.campos.implementationGuide
        .split('\n')
        .filter((l) => /^\s*\d+\./.test(l))
      expect(passos.length).toBeGreaterThanOrEqual(3)
      const criterios = decisao.campos.verificationCriteria
        .split('\n')
        .filter((l) => /^\s*-\s/.test(l))
      expect(criterios.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('a tarefa nasce delegável: label de tipo que o SM procura', () => {
    const decisao = decidirConsertoDePublicacao(publicacao('falhou'))
    if (!decisao.abrir) throw new Error('esperava abrir')
    expect(decisao.etiquetas).toContain('gitorch:task')
  })

  test('a evidência real vai no corpo: commit, PR, entrega de origem e as etapas que quebraram', () => {
    const decisao = decidirConsertoDePublicacao(publicacao('falhou'))
    if (!decisao.abrir) throw new Error('esperava abrir')
    expect(decisao.corpo).toContain(BASE.shaDaMescla)
    expect(decisao.corpo).toContain('#42')
    expect(decisao.corpo).toContain('#7')
    expect(decisao.corpo).toContain('deploy prod')
    expect(decisao.corpo).toContain('failure')
  })

  test('a evidência do ambiente vai no corpo: a tela que não respondeu e o código HTTP', () => {
    const decisao = decidirConsertoDePublicacao(ambiente('falhou', 1))
    if (!decisao.abrir) throw new Error('esperava abrir')
    expect(decisao.corpo).toContain('503')
    expect(decisao.corpo).toContain('/')
    expect(decisao.corpo).toContain('https://loja.exemplo.com')
  })

  test('a nota ao dono nomeia a tarefa de conserto criada', () => {
    expect(notaDeConserto(99)).toContain('#99')
  })
})
