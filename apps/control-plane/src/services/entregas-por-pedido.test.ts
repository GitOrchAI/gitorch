import { describe, it, expect } from 'vitest'
import {
  julgarPedidos,
  paginar,
  inteiroDaQuery,
  grupoDaQuery,
  type SessaoDaEntrega,
} from './entregas-por-pedido.js'

// A UNIDADE DESTA TELA É O PEDIDO, NÃO A SESSÃO.
//
// Medido no banco do dono em 31/08/2026:
//
//   select count(*), count(distinct issue_number) from dev_sessions;  -- 200 | 99
//
// O cartão sempre disse "Pedido #N" e o denominador dizia 200. O dono lia
// duzentos pedidos onde havia noventa e nove. Pior: como um pedido aparecia
// várias vezes na mesma lista, a `key` do React repetia — e cartão com key
// repetida não é só um número errado, é DOM que não sai da tela (o bloqueador
// desta leva). Agrupar por pedido conserta a conta e a chave de uma vez.

const PROJETOS = [{ id: 'p1', name: 'gitorch', reguaDePronto: null }]

const sessao = (over: Partial<SessaoDaEntrega> = {}): SessaoDaEntrega => ({
  projectId: 'p1',
  issueNumber: 42,
  pullRequestNumber: 7,
  mergeCommitSha: 'deadbeef',
  deployState: 'no-ar',
  envLastVerdict: 'no-ar',
  updatedAt: new Date('2026-08-29T23:00:00Z'),
  ...over,
})

describe('julgarPedidos — uma linha por PEDIDO, não por sessão', () => {
  it('três sessões do mesmo pedido viram UM cartão', () => {
    // A forma exata do defeito: no banco do dono há 200 sessões para 99
    // pedidos, e o cartão se chama "Pedido #N".
    const r = julgarPedidos(
      [
        sessao({ updatedAt: new Date('2026-08-01T00:00:00Z') }),
        sessao({ updatedAt: new Date('2026-08-02T00:00:00Z') }),
        sessao({ updatedAt: new Date('2026-08-03T00:00:00Z') }),
      ],
      PROJETOS
    )

    expect(r.prontas).toHaveLength(1)
    expect(r.andando).toHaveLength(0)
    expect(r.prontas[0]).toMatchObject({ projeto: 'gitorch', pedido: 42 })
  })

  it('nenhum pedido aparece duas vezes, nem dentro de um grupo nem entre os dois', () => {
    // A invariante de que a `key` do cartão depende. Se ela cair, a tela volta
    // a acumular DOM ao virar a página.
    const muitas = Array.from({ length: 60 }, (_, i) =>
      sessao({
        issueNumber: 100 + (i % 20),
        deployState: i % 3 === 0 ? 'no-ar' : 'sem-publicacao',
        updatedAt: new Date(Date.UTC(2026, 7, 30, 12) - i * 3_600_000),
      })
    )
    const r = julgarPedidos(muitas, PROJETOS)

    const chaves = [...r.prontas, ...r.andando].map((e) => `${e.projeto}#${e.pedido}`)
    expect(new Set(chaves).size).toBe(chaves.length)
    expect(chaves).toHaveLength(20)
  })

  it('o pedido está pronto se ALGUMA sessão dele passou na régua', () => {
    // POR QUE "ALGUMA" E NÃO "A ÚLTIMA": os critérios da régua são fatos que
    // não se desfazem — um PR foi mesclado, uma publicação chegou ao ar. Uma
    // sessão posterior no mesmo pedido é trabalho A MAIS sobre um pedido que
    // já chegou às mãos do dono; ela não desmescla nem despublica o que já
    // está lá. Julgar pela ÚLTIMA sessão faria uma entrega em produção sumir
    // da conta no instante em que alguém abrisse um retoque sobre ela.
    const r = julgarPedidos(
      [
        sessao({ updatedAt: new Date('2026-08-01T00:00:00Z') }),
        sessao({
          deployState: 'sem-publicacao',
          mergeCommitSha: null,
          updatedAt: new Date('2026-08-20T00:00:00Z'),
        }),
      ],
      PROJETOS
    )

    expect(r.prontas).toHaveLength(1)
    expect(r.andando).toHaveLength(0)
  })

  it('prontoEm é o instante MAIS ANTIGO em que o pedido passou na régua', () => {
    // "Ficou pronto" é quando chegou lá pela primeira vez, não a última vez em
    // que a esteira mexeu na linha.
    const r = julgarPedidos(
      [
        sessao({ updatedAt: new Date('2026-08-20T00:00:00Z') }),
        sessao({ updatedAt: new Date('2026-08-05T00:00:00Z') }),
      ],
      PROJETOS
    )

    expect(r.prontas[0]?.prontoEm).toBe('2026-08-05T00:00:00.000Z')
  })

  it('pedido que não fechou tem data NULA e diz o que falta', () => {
    const r = julgarPedidos([sessao({ deployState: 'falhou' })], PROJETOS)

    expect(r.prontas).toHaveLength(0)
    expect(r.andando[0]?.prontoEm).toBeNull()
    expect(r.andando[0]?.porQueNaoFechou).toEqual(['foi mesclada, mas ainda não chegou ao ar'])
  })

  it('o que falta vem da sessão que chegou MAIS LONGE, não da mais recente', () => {
    // A sessão antiga mesclou e só falta ir ao ar; a nova nem PR tem. Dizer
    // "ainda não há entrega aberta" esconderia do dono que o trabalho está a
    // um passo do fim.
    const r = julgarPedidos(
      [
        sessao({
          deployState: 'sem-publicacao',
          updatedAt: new Date('2026-08-01T00:00:00Z'),
        }),
        sessao({
          pullRequestNumber: null,
          mergeCommitSha: null,
          deployState: null,
          updatedAt: new Date('2026-08-20T00:00:00Z'),
        }),
      ],
      PROJETOS
    )

    expect(r.andando[0]?.porQueNaoFechou).toEqual(['foi mesclada, mas ainda não chegou ao ar'])
    expect(r.andando[0]?.entrega).toBe(7)
  })

  it('cada projeto é julgado pela SUA régua', () => {
    const r = julgarPedidos(
      [
        sessao({ projectId: 'p1', issueNumber: 1, deployState: 'sem-publicacao' }),
        sessao({ projectId: 'p2', issueNumber: 2, deployState: 'sem-publicacao' }),
      ],
      [
        { id: 'p1', name: 'gitorch', reguaDePronto: null },
        { id: 'p2', name: 'patinhas', reguaDePronto: { no_ar: false } },
      ]
    )

    expect(r.prontas.map((e) => e.pedido)).toEqual([2])
    expect(r.andando.map((e) => e.pedido)).toEqual([1])
  })

  it('régua sem nenhum critério ligado: nada é declarado pronto', () => {
    // Régua vazia = o cliente ainda não disse o que é pronto para ele. O
    // produto não tem o direito de afirmar que algo está.
    const vazia = { entregou: false, mesclado: false, no_ar: false, ambiente_respondeu: false }
    const r = julgarPedidos([sessao()], [{ id: 'p1', name: 'gitorch', reguaDePronto: vazia }])

    expect(r.prontas).toHaveLength(0)
    expect(r.andando).toHaveLength(1)
  })

  it('sessão de projeto que não é do dono é ignorada, não vira cartão sem nome', () => {
    const r = julgarPedidos([sessao({ projectId: 'de_outro' })], PROJETOS)

    expect(r.prontas).toHaveLength(0)
    expect(r.andando).toHaveLength(0)
  })

  it('as prontas saem da mais recente para a mais antiga, com desempate estável', () => {
    // A MÉDIA da revisão: ordenar só por uma data que a esteira reescreve deixa
    // linhas empatadas trocando de lugar entre duas viradas de página. O
    // desempate por projeto e número torna a ordem função só dos dados.
    const mesmoInstante = new Date('2026-08-10T00:00:00Z')
    const r = julgarPedidos(
      [
        sessao({ issueNumber: 5, updatedAt: mesmoInstante }),
        sessao({ issueNumber: 9, updatedAt: mesmoInstante }),
        sessao({ issueNumber: 1, updatedAt: new Date('2026-08-20T00:00:00Z') }),
      ],
      PROJETOS
    )

    expect(r.prontas.map((e) => e.pedido)).toEqual([1, 9, 5])
  })

  it('a mesma entrada julgada duas vezes dá exatamente a mesma ordem', () => {
    const entrada = Array.from({ length: 30 }, (_, i) =>
      sessao({ issueNumber: 200 + i, updatedAt: new Date(Date.UTC(2026, 7, 1 + (i % 5), 12)) })
    )
    const a = julgarPedidos(entrada, PROJETOS)
    const b = julgarPedidos([...entrada].reverse(), PROJETOS)

    expect(a.prontas.map((e) => e.pedido)).toEqual(b.prontas.map((e) => e.pedido))
  })

  it('prontas + andando é o número de PEDIDOS distintos — o denominador do cartão', () => {
    const muitas = Array.from({ length: 40 }, (_, i) =>
      sessao({
        issueNumber: 300 + (i % 11),
        updatedAt: new Date(Date.UTC(2026, 7, 20, 12) - i * 60_000),
      })
    )
    const r = julgarPedidos(muitas, PROJETOS)

    expect(r.prontas.length + r.andando.length).toBe(11)
  })
})

describe('paginar — a página nunca vira o denominador', () => {
  const lista = Array.from({ length: 60 }, (_, i) => i)

  it('a primeira página traz o começo da lista', () => {
    expect(paginar(lista, 1, 25)).toEqual(lista.slice(0, 25))
  })

  it('a última página traz só o que sobrou', () => {
    expect(paginar(lista, 3, 25)).toHaveLength(10)
  })

  it('página além do fim é vazia — e não estoura', () => {
    expect(paginar(lista, 9, 25)).toEqual([])
  })
})

describe('inteiroDaQuery — valor inválido cai no padrão, nunca em NaN', () => {
  it('ausente vira o padrão', () => {
    expect(inteiroDaQuery(undefined, 1, 1, 100)).toBe(1)
  })

  it('texto que não é número vira o padrão', () => {
    expect(inteiroDaQuery('abc', 25, 1, 100)).toBe(25)
  })

  it('abaixo do mínimo vira o padrão', () => {
    expect(inteiroDaQuery('-3', 1, 1, 100)).toBe(1)
  })

  it('acima do teto para no teto — pedir 5000 não varre o banco', () => {
    expect(inteiroDaQuery('5000', 25, 1, 100)).toBe(100)
  })

  it('valor válido passa', () => {
    expect(inteiroDaQuery('3', 1, 1, 100)).toBe(3)
  })
})

describe('grupoDaQuery — o grupo é explícito, nunca um filtro escondido', () => {
  it('sem pedir nada, o padrão é o que a aba promete: as prontas', () => {
    expect(grupoDaQuery(undefined)).toBe('prontas')
  })

  it('grupo desconhecido cai no padrão em vez de devolver lista vazia', () => {
    expect(grupoDaQuery('sei-la')).toBe('prontas')
  })

  it('andando é pedível', () => {
    expect(grupoDaQuery('andando')).toBe('andando')
  })
})
