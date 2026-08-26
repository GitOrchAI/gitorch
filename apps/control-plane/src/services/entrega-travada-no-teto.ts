import { MAX_TENTATIVAS_DE_MERGE } from './qa-rails-mission.js'

/**
 * A entrega que bateu o teto de tentativas de mescla e nunca mais foi tentada.
 *
 * MEDIDO AO VIVO em 26/08, e é um beco sem saída permanente: os PRs #213 e
 * #194 estavam APROVADOS pelo QA, abertos, com `mergeFailures` no teto — um
 * parado desde 15/08, outro desde 21/08.
 *
 * O desenho por trás disso está certo: bater o teto e parar de tentar evita
 * que o produto fique martelando um conflito a cada tique do relógio. O
 * problema é o que vem depois. O laço de descoberta passa a PULAR a entrega
 * até o commit mudar, e o pedido de rebase ao dev só existe DENTRO da
 * tentativa de mescla — que nunca mais roda. Ninguém pede rebase, o dev nunca
 * empurra commit novo, o commit nunca muda, o teto nunca zera.
 *
 * O mecanismo que manda conflito para o dev (entregue em 26/08) só alcança
 * quem bate o teto DEPOIS dele. Quem já estava lá continuaria parado para
 * sempre — e é justamente o último elo do ciclo: sem merge, tudo o que veio
 * antes vira ensaio.
 *
 * Este resgate é uma passagem só, por commit: pede ao dev, e o commit novo que
 * ele empurrar zera o teto e devolve a entrega ao caminho normal.
 */

export type ResgateDaTravada =
  | { resgatar: true }
  /** `avisarDono` quando não há a quem pedir e o dono precisa saber. */
  | { resgatar: false; avisarDono: boolean; motivo: string }

export function decidirResgateDaTravada(args: {
  /** A entrega é nossa? Em PR alheio o produto não mexe. */
  delegado: boolean
  mergeFailures: number
  /** Há sessão viva do dev para receber o pedido? */
  temSessaoViva: boolean
  /** Já pedimos o resgate para ESTE commit? */
  jaPediuNesteHead: boolean
}): ResgateDaTravada {
  if (!args.delegado) {
    return { resgatar: false, avisarDono: false, motivo: 'a entrega não é nossa' }
  }
  if (args.mergeFailures < MAX_TENTATIVAS_DE_MERGE) {
    return {
      resgatar: false,
      avisarDono: false,
      motivo: 'ainda há tentativa de mescla pela frente — o caminho normal resolve',
    }
  }
  // Antes de qualquer coisa: já pedimos. Repetir a cada tique seria trocar o
  // silêncio por spam, e spam apaga sinal do mesmo jeito.
  if (args.jaPediuNesteHead) {
    return {
      resgatar: false,
      avisarDono: false,
      motivo: 'o resgate já foi pedido para este commit',
    }
  }
  if (!args.temSessaoViva) {
    return {
      resgatar: false,
      avisarDono: true,
      motivo:
        'a entrega travou no teto de tentativas de mescla e a sessão do dev já foi encerrada — não há a quem pedir',
    }
  }
  return { resgatar: true }
}

/**
 * A marca do resgate, por COMMIT.
 *
 * Leva o commit dentro de propósito: se o dev empurrar um novo, ela deixa de
 * casar e o resgate volta a valer — que é exatamente o que se quer, porque aí
 * o conflito é outro. Sem o commit, um pedido feito uma vez calaria o produto
 * para sempre naquela entrega.
 */
export function chaveDoResgate(headAtual: string | null): string {
  return `gitorch:resgate-do-teto:${headAtual ?? 'sem-commit'}`
}

/** O que o dev recebe. Diz o que aconteceu, o que fazer, e o que não fazer. */
export function pedidoDeResgate(numeroDoPr: number): string {
  return [
    `O pull request #${numeroDoPr} está parado: as tentativas de mesclá-lo falharam e eu parei`,
    'de tentar para não ficar martelando. Ele não anda mais sozinho.',
    '',
    'Traga a base para o seu ramo (rebase ou merge da principal), resolva os conflitos',
    'preservando o que a sua entrega faz, e empurre. Não mude nada fora do escopo da tarefa',
    'enquanto faz isso.',
    '',
    'Assim que houver commit novo, eu volto a tentar mesclar sozinho.',
  ].join('\n')
}
