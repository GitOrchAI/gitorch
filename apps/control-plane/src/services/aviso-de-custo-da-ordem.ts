import type { CandidatoDeTroca } from '@gitorch/cadence'

/**
 * A frase do losango do desenho, com o número — "Y entregaria N antes. Quer
 * trocar?" — só que em pontos de peso, não em sprints.
 *
 * POR QUE NÃO "SPRINTS": o desenho original diz "Y entregaria 2 sprints
 * antes", mas o produto não mede velocidade nem capacidade por sprint em
 * lugar nenhum do código (conferido: `PESO_MAXIMO_DE_SPRINT`, em
 * packages/cadence/src/rails.ts, é o TETO de uma task, não uma taxa de
 * entrega). Converter pontos de peso em sprints exigiria inventar essa taxa
 * — um número que ninguém mediu, virando bonito e errado (a mesma armadilha
 * que a "CONFIGURAÇÃO É INDÍCIO, TESTE É PROVA" já puniu neste projeto).
 * "Pontos de peso" é a unidade que o produto JÁ usa para planejar
 * (ESCALA_DE_PESO) e que este cálculo já tem, medida — sem fabricar nada.
 */
export function formatarAvisoDeCustoDaOrdem(candidato: CandidatoDeTroca): string {
  const pontos = candidato.perda === 1 ? '1 ponto de peso' : `${candidato.perda} pontos de peso`
  return (
    `GitOrch: sua ordem atual está custando caro na fila — #${candidato.pedido} entregaria ` +
    `${pontos} mais cedo se a ordem mudasse (hoje espera ${candidato.esperaAtual}, ` +
    `esperaria ${candidato.esperaOtima} numa ordem que reduz a espera de todo mundo). ` +
    `Quer trocar? Sua ordem no quadro continua valendo até você decidir.`
  )
}
