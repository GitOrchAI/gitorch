// O texto, a chave dos cartões e a navegação da aba Entregas.
//
// POR QUE É UM MÓDULO SEPARADO, E NÃO CÓDIGO SOLTO DENTRO DO .tsx:
//
// 1. O cabeçalho desta tela dizia "PRONTAS: 0 de 50" — e as duas metades da
//    frase estavam erradas ao mesmo tempo. O "0" vinha de recontar em memória
//    as 50 sessões mais recentes (nenhuma das 15 prontas do dono estava entre
//    elas) e o "50" era o teto da consulta posando de população.
//
// 2. A `key` do <Card> era `${projeto}-${pedido}` e `pedido` NÃO é único: no
//    banco do dono há 200 sessões para 99 pedidos. Duas crianças da mesma
//    lista com a mesma key fazem o React montar o mapa de reconciliação por
//    key, o segundo fiber SOBRESCREVER o primeiro, e o fiber sombreado não ser
//    nem reaproveitado nem apagado — o nó de DOM dele FICA na tela. Medido:
//    página 1 tinha 8 colisões em 25 linhas e página 2 tinha 4, e o navegador
//    desenhava 25, depois 25+8=33, depois 33+4=37 cartões.
//
// O app web testa lógica em `.ts` (vitest com environment 'node'), e foi por
// estar solto dentro do .tsx que isto atravessou revisão sem ser conferido.
// Enquanto a tela só desenhar o que este módulo devolve, os dois defeitos têm
// teste.

/** A primeira página. Humano conta a partir de um, e a URL é do humano. */
export const PAGINA_INICIAL = 1

/**
 * Os dois grupos da aba, ambos visíveis e rotulados.
 *
 * A aba chama-se Entregas e o cabeçalho anuncia um número de entregas: a lista
 * padrão é a das prontas. O que ainda não fechou não some do produto — fica no
 * outro grupo, a um clique rotulado de distância, com o motivo escrito.
 */
export const GRUPOS = ['prontas', 'andando'] as const
export type GrupoDeEntrega = (typeof GRUPOS)[number]

/** O mínimo que um cartão precisa ter para ganhar uma chave. */
export interface CartaoIdentificavel {
  projeto: string
  pedido: number
}

/**
 * Uma key por cartão, garantidamente distintas.
 *
 * A rota já devolve um pedido por linha, então na prática o sufixo nunca entra.
 * Ele existe porque uma key repetida não falha alto: ela deixa DOM órfão na
 * tela, com o console limpo. Garantir aqui é mais barato que descobrir de novo
 * contando cartões no navegador.
 *
 * A key descreve O QUE o cartão é (projeto + pedido), nunca a posição dele na
 * página: key por índice mudaria de significado a cada virada.
 */
export function chavesDosCartoes(cartoes: readonly CartaoIdentificavel[]): string[] {
  const vistas = new Map<string, number>()
  return cartoes.map((c) => {
    const base = `${c.projeto}#${c.pedido}`
    const repetida = vistas.get(base) ?? 0
    vistas.set(base, repetida + 1)
    return repetida === 0 ? base : `${base}~${repetida + 1}`
  })
}

/**
 * O denominador do "prontas de N", na unidade do CARTÃO.
 *
 * O cartão diz "Pedido #N", então o denominador conta PEDIDOS. A nota dizia
 * "de 200 que passaram pela sua régua" onde há noventa e nove pedidos — e a
 * palavra "pedidos" entra no texto justamente para o dono poder conferir que a
 * unidade é a mesma que ele está vendo.
 *
 * `null` é DESCONHECIDO, não zero: quando a rota não manda o campo, a tela
 * cala. Escrever "de 0 que passaram pela sua régua" ao lado de um número real
 * é o default vazio que já nos custou caro.
 */
export function rotuloDoDenominador(total: number | null): string | null {
  if (total === null) return null
  const [unidade, verbo] = total === 1 ? ['pedido', 'passou'] : ['pedidos', 'passaram']
  return `de ${total} ${unidade} que ${verbo} pela sua régua`
}

/**
 * O que o cabeçalho da lista diz que ela está mostrando.
 *
 * Existe para a escolha de grupo NUNCA ser um filtro escondido: o dono lê, em
 * palavras, qual população está na tela e em que ordem.
 */
export function rotuloDoGrupo(grupo: GrupoDeEntrega, quantos: number | null): string {
  if (grupo === 'andando') {
    if (quantos === null) return 'pedidos que ainda não fecharam'
    if (quantos === 0) return 'nenhum pedido em aberto'
    if (quantos === 1) return '1 pedido que ainda não fechou, com o que falta nele'
    return `${quantos} pedidos que ainda não fecharam, com o que falta em cada um`
  }
  if (quantos === null) return 'entregas prontas'
  if (quantos === 0) return 'nenhuma entrega pronta ainda'
  if (quantos === 1) return '1 entrega pronta'
  return `${quantos} entregas prontas, da mais recente para a mais antiga`
}

export interface Navegacao {
  podeVoltar: boolean
  podeAvancar: boolean
  /** "Página 2 de 8". Vazio quando não há nada para paginar. */
  rotulo: string
}

/** O que a barra de páginas pode oferecer sem prometer página que não existe. */
export function navegacao(args: { pagina: number; paginas: number }): Navegacao {
  const { pagina, paginas } = args
  if (paginas <= 0) return { podeVoltar: false, podeAvancar: false, rotulo: '' }
  return {
    podeVoltar: pagina > PAGINA_INICIAL,
    podeAvancar: pagina < paginas,
    rotulo: `Página ${pagina} de ${paginas}`,
  }
}
