/**
 * O aviso de quem publica FORA do alcance do GitHub (D49, cenário (e)).
 *
 * O produto só sabia confirmar publicação lendo o GitHub — deployment ou
 * execução de workflow. Nenhum dos dois alcança uma VM privada, que é o caso
 * do próprio dono e provavelmente o mais comum entre clientes reais. Sem um
 * caminho de volta, a entrega mesclada ficava presa esperando uma confirmação
 * que nunca viria: seis delas, medidas em 25/08.
 *
 * Este é o caminho de volta: o CD do cliente, que é quem de fato sabe, avisa.
 * A lei continua de pé — "no ar" só com prova. A diferença é que agora a prova
 * pode vir de quem publica, em vez de só de quem observa de fora.
 */

/** O prefixo das chaves de projeto emitidas pelo wizard. */
export const PREFIXO_DA_CHAVE = 'gitorch_'

export interface EntregaParaAviso {
  sessionName: string
  mergeCommitSha: string | null
  closedAt: Date | null
}

export type DecisaoSobreAviso =
  /** O aviso vale: grava o veredito. */
  | { acao: 'registrar'; estado: 'no-ar' | 'falhou' }
  /** Reenvio ou aviso sobre algo que o produto não acompanha: nada a fazer. */
  | { acao: 'ignorar'; motivo: string }
  /** O aviso é sobre outra versão: recusa em vez de carimbar a errada. */
  | { acao: 'recusar'; motivo: string }

/**
 * O que fazer com um aviso de publicação.
 *
 * A checagem do commit é o coração: um aviso que carimba a entrega errada é
 * pior que aviso nenhum, porque produz um "está no ar" falso — exatamente o
 * que a lei proíbe. Comparação do SHA inteiro, sem prefixo: um prefixo curto
 * casaria com commits diferentes, e "quase o mesmo commit" não é o mesmo
 * commit.
 */
export function decidirSobreAviso(args: {
  /** A entrega mesclada mais recente daquele projeto, se houver. */
  entrega: EntregaParaAviso | null
  commitAvisado: string
  sucesso: boolean
  agora: Date
}): DecisaoSobreAviso {
  if (!args.entrega || !args.entrega.mergeCommitSha) {
    return {
      acao: 'ignorar',
      motivo: 'não há entrega mesclada esperando confirmação de publicação neste projeto',
    }
  }
  if (args.entrega.closedAt) {
    return { acao: 'ignorar', motivo: 'esta entrega já foi encerrada' }
  }
  // Sem distinção de caixa: o mesmo SHA escrito de dois jeitos é o mesmo SHA,
  // e ferramentas de CD escrevem de jeitos diferentes.
  if (args.entrega.mergeCommitSha.toLowerCase() !== args.commitAvisado.trim().toLowerCase()) {
    return {
      acao: 'recusar',
      motivo:
        `o aviso é sobre o commit ${args.commitAvisado}, mas a entrega que está esperando ` +
        `confirmação é a do ${args.entrega.mergeCommitSha}`,
    }
  }
  return { acao: 'registrar', estado: args.sucesso ? 'no-ar' : 'falhou' }
}
