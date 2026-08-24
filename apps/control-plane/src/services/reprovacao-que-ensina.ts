/**
 * Duas reprovações que não dizem nada sobre a entrega — e o que fazer com elas.
 *
 * A PRIMEIRA é o diff que não coube na janela de revisão. O parecer saía com
 * "approval was blocked" e mais nada: o dev lia uma reprovação, procurava o
 * defeito no código dele e não achava, porque não havia. Nove arquivos já
 * estouravam.
 *
 * A SEGUNDA é o projeto que falha sempre pelo mesmo motivo. O
 * `loureng/patinhas-3d-crafts` levou dez reprovações seguidas em quatro dias e
 * a esteira tratou cada uma como azar isolado, redelegando de novo. Ninguém
 * disse ao dono que o problema não era a entrega da vez.
 *
 * Este arquivo é a REGRA, sem banco e sem rede.
 */

/** Marca o parecer cujo motivo é o TAMANHO da entrega, não a qualidade dela. */
export const MARCA_DE_ENTREGA_GRANDE_DEMAIS = '<!-- gitorch:qa:entrega-grande-demais -->'

/**
 * Reprovações seguidas pelo mesmo motivo que deixam de ser azar.
 *
 * Três porque duas ainda são coincidência plausível — um dia ruim, uma
 * dependência quebrada que já voltou. Na terceira, insistir é o produto
 * repetindo o mesmo ciclo enquanto o dono não sabe de nada.
 */
export const REPROVACOES_ATE_ESCALAR = 3

/**
 * O pedido que o dev consegue atender quando a entrega não coube.
 *
 * Diz o número de arquivos porque é o dado que ele mede sozinho, e pede a
 * divisão em vez de "arrume" — não há o que arrumar no código.
 */
export function pedidoDeDividirAEntrega(numeroDoPr: number, arquivos: number): string {
  return (
    `Esta entrega não coube inteira na janela de revisão: o PR #${numeroDoPr} traz ` +
    `${arquivos} arquivo(s), e eu só consegui ver parte deles. Não estou apontando ` +
    `defeito no código — não cheguei a ver o código todo, e aprovar sobre o que não vi ` +
    `seria pior que recusar.\n\n` +
    `O que resolve: divida esta entrega em partes menores, cada uma com um propósito ` +
    `só, e abra uma de cada vez. Cada parte é revisada inteira e segue sozinha.`
  )
}

export interface EntregaJulgada {
  /** `true` quando a reprovação veio do PORTÃO (CI, tamanho), não do código. */
  peloPortao: boolean
  quando: Date
}

export type DecisaoSobreOProjeto =
  { acao: 'seguir' } | { acao: 'escalar'; seguidas: number; diagnostico: string }

/**
 * O projeto está com defeito próprio, ou foi só esta entrega?
 *
 * Conta as reprovações POR PORTÃO mais recentes, em sequência. Uma reprovação
 * de código no meio ZERA a conta de propósito: ela prova que a esteira
 * consegue julgar o mérito ali, e portanto o projeto não está travado — só
 * aquela entrega estava ruim. É também o caminho de volta: um projeto barrado
 * volta a andar assim que uma entrega é julgada pelo conteúdo.
 *
 * `historico` vem da mais recente para a mais antiga.
 */
export function decidirSobreOProjeto(
  historico: EntregaJulgada[],
  repositorio: string,
  teto: number = REPROVACOES_ATE_ESCALAR
): DecisaoSobreOProjeto {
  let seguidas = 0
  for (const entrega of historico) {
    if (!entrega.peloPortao) break
    seguidas += 1
  }

  if (seguidas < teto) return { acao: 'seguir' }

  return {
    acao: 'escalar',
    seguidas,
    diagnostico:
      `O repositório ${repositorio} teve ${seguidas} entregas seguidas barradas sem que ` +
      `nenhuma fosse julgada pelo conteúdo. Isso não é uma entrega ruim: é o mesmo ` +
      `obstáculo aparecendo toda vez — a verificação do projeto, ou o tamanho das ` +
      `entregas. Redelegar de novo produz a mesma parada.\n\n` +
      `Parei de reencaminhar entregas deste repositório até uma ser julgada pelo ` +
      `conteúdo. Assim que isso acontecer, ele volta a andar sozinho.`,
  }
}
