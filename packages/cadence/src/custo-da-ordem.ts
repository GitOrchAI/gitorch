import { type PesoDeTask } from './rails'

// A CAIXA QUE SUMIU (fluxograma "A lógica da leva 2", aprovado 30/08, artifact
// bf8b036a): entre o desenho aprovado e a lista de tarefas, este losango
// nunca virou trabalho.
//
//   losango: "Sua ordem custa caro? { perda / tamanho }"
//   SIM -> "Avisa você: 'Y entregaria N antes. Quer trocar?'"
//   NÃO -> "Segue sua ordem — você sempre decide"
//
// O QUE É, em negócio: o dono escolhe a ordem dos pedidos no painel. Este
// módulo calcula se aquela ordem está custando caro — o que os outros
// pedidos perdem (tempo de espera) dividido pelo tamanho do item que está
// causando a espera — e aponta, quando vale a pena, qual pedido específico
// entregaria antes numa ordem diferente. NUNCA decide sozinho: só calcula e
// propõe (ver services/aviso-de-custo-da-ordem.ts e
// services/custo-da-ordem-do-projeto.ts, que nunca chamam
// ordem-dos-pedidos.ts a partir daqui).
//
// AS DUAS DECISÕES DO DONO (01/09) QUE FECHAM A CONTA:
//
// 1. "Perda" é a conta CLÁSSICA de fila: quanto os OUTROS pedidos ficam
//    esperando por causa da ordem escolhida. Um item grande e pouco urgente
//    na frente faz todo mundo atrás esperar. "Tamanho" é o peso do próprio
//    item, na ESCALA_DE_PESO que o produto já usa para planejar tasks
//    (1,2,3,5,8,13 — rails.ts). Esta foi a opção escolhida ENTRE TRÊS
//    justamente porque os dois números (peso e ordem) já existem hoje — o
//    dono não precisa preencher "valor do pedido" nenhum.
//
// 2. Só avisa quando a diferença for GRANDE. Proposta que aparece toda hora
//    vira ruído e o dono para de ler (o mesmo problema já vivido com a
//    rajada de avisos de rotina do Telegram em 29/08 — ver
//    services/classe-do-aviso.ts). O limiar é documentado e ajustável
//    abaixo, não escondido num número mágico.
//
// A CONTA, em termos de fila: com os pedidos em qualquer ordem, o pedido na
// posição i espera (antes de começar) a soma dos pesos de todos os pedidos
// nas posições anteriores — isso é literalmente "quanto os outros já
// consumiram da frente da fila". A ordem que minimiza a espera de TODO MUNDO
// é a clássica SPT (shortest processing time first): peso crescente. É
// resultado provado por argumento de troca — trocar um item maior à frente
// de um menor sempre reduz (ou empata) a soma das esperas, nunca aumenta.
//
// "Perda / tamanho" é medida POR PEDIDO: quanto aquele pedido específico
// espera a mais, na ordem escolhida pelo dono, do que esperaria na ordem
// ótima — dividido pelo próprio tamanho dele. Um pedido pequeno preso atrás
// de um pedido grande tem razão alta (está pagando um preço, em espera,
// muitas vezes maior que o próprio tamanho). Um pedido grande que está um
// pouco fora do lugar tem razão baixa. É essa razão que aponta QUEM é o "Y"
// do desenho.

/** Um pedido na fila, com o peso que o produto já tem hoje. */
export interface PedidoNaFila {
  /** O número do pedido — o que o dono reconhece (issue no GitHub). */
  pedido: number
  /** Tamanho na ESCALA_DE_PESO (rails.ts): 1, 2, 3, 5, 8 ou 13. */
  peso: PesoDeTask
}

/**
 * O pedido que mais vale a pena propor — o "Y" do desenho, com o número.
 */
export interface CandidatoDeTroca {
  pedido: number
  peso: PesoDeTask
  /** Quanto este pedido espera HOJE, na ordem que o dono escolheu. */
  esperaAtual: number
  /** Quanto ele esperaria na ordem que minimiza a espera de todo mundo. */
  esperaOtima: number
  /** `esperaAtual - esperaOtima`. Sempre > 0 para virar candidato. */
  perda: number
  /** `perda / peso` — a conta do losango. Quanto maior, mais caro fica ELE preso onde está. */
  razao: number
}

export type AnaliseDeCustoDaOrdem =
  | { custaCaro: true; candidato: CandidatoDeTroca }
  | { custaCaro: false; candidato: null; motivo: string }

/**
 * Abaixo disto, não há fila para otimizar: com 1 ou 2 pedidos o dono já vê a
 * ordem inteira de relance, e qualquer troca é óbvia sem ajuda nenhuma. O
 * valor deste cálculo está em achar o candidato que NÃO salta aos olhos numa
 * fila com profundidade de verdade — por isso o piso em 3.
 */
export const MIN_PEDIDOS_PARA_AVALIAR = 3

/**
 * Piso ABSOLUTO, em pontos de peso, para a perda valer aviso.
 *
 * 3 é o terceiro degrau da ESCALA_DE_PESO — o comentário de rails.ts já
 * documenta que 1 e 2 servem para ajuste fino, não para itens "de verdade".
 * Uma perda de 1 ou 2 pontos está dentro do ruído da própria estimativa;
 * avisar por isso é a rajada de mensagens de rotina que o dono já reclamou
 * (classe-do-aviso.ts) — só que aqui, dentro do produto.
 */
export const LIMIAR_PONTOS_MINIMOS = 3

/**
 * Piso RELATIVO: a perda tem que valer pelo menos o DOBRO do próprio tamanho
 * do pedido represado. Abaixo disso, o pedido está esperando um pouco mais
 * do que o normal de qualquer fila — não um preço desproporcional ao próprio
 * tamanho. Os dois pisos (absoluto e relativo) precisam passar juntos: um
 * item de peso 13 preso atrás de outro peso 13 pode ter razão alta com
 * perda pequena não sobra, e um item minúsculo pode ter razão gigante com
 * perda irrisória — nenhum dos dois sozinhos, isolado, é "caro" de verdade.
 */
export const LIMIAR_RAZAO = 2

/**
 * A ordem que minimiza a espera de todos: peso crescente (SPT), estável nos
 * empates — quem chegou primeiro na ordem do dono continua na frente entre
 * pedidos do mesmo tamanho, porque não há informação nenhuma para desempatar
 * diferente.
 */
export function ordemQueMinimizaEspera(fila: readonly PedidoNaFila[]): PedidoNaFila[] {
  return fila
    .map((pedido, indiceOriginal) => ({ pedido, indiceOriginal }))
    .sort((a, b) => a.pedido.peso - b.pedido.peso || a.indiceOriginal - b.indiceOriginal)
    .map((x) => x.pedido)
}

/** Quanto cada pedido espera ANTES de começar: a soma dos pesos à frente dele. */
function esperasNaOrdem(fila: readonly PedidoNaFila[]): Map<number, number> {
  const esperas = new Map<number, number>()
  let acumulado = 0
  for (const item of fila) {
    esperas.set(item.pedido, acumulado)
    acumulado += item.peso
  }
  return esperas
}

/**
 * Calcula se a ordem ESCOLHIDA PELO DONO está custando caro e, se estiver,
 * aponta o pedido que mais se beneficiaria de uma troca — com o número.
 *
 * NUNCA reordena nada. Só calcula. A ordem do dono prevalece sempre; quem
 * decide o que fazer com o resultado é quem chama esta função.
 */
export function analisarCustoDaOrdem(
  filaNaOrdemEscolhida: readonly PedidoNaFila[]
): AnaliseDeCustoDaOrdem {
  if (filaNaOrdemEscolhida.length < MIN_PEDIDOS_PARA_AVALIAR) {
    return {
      custaCaro: false,
      candidato: null,
      motivo:
        `menos de ${MIN_PEDIDOS_PARA_AVALIAR} pedidos na fila — não há o que otimizar; ` +
        `com uma fila tão rasa o dono já vê a ordem inteira sem ajuda.`,
    }
  }

  const esperaAtualPorPedido = esperasNaOrdem(filaNaOrdemEscolhida)
  const esperaOtimaPorPedido = esperasNaOrdem(ordemQueMinimizaEspera(filaNaOrdemEscolhida))

  let melhor: CandidatoDeTroca | null = null
  for (const item of filaNaOrdemEscolhida) {
    const esperaAtual = esperaAtualPorPedido.get(item.pedido) ?? 0
    const esperaOtima = esperaOtimaPorPedido.get(item.pedido) ?? 0
    const perda = esperaAtual - esperaOtima
    // Perda <= 0: este pedido não está pagando preço nenhum na ordem atual
    // (ou até se beneficia dela) — nunca é candidato.
    if (perda <= 0) continue

    const candidato: CandidatoDeTroca = {
      pedido: item.pedido,
      peso: item.peso,
      esperaAtual,
      esperaOtima,
      perda,
      razao: perda / item.peso,
    }

    if (
      !melhor ||
      candidato.razao > melhor.razao ||
      (candidato.razao === melhor.razao &&
        (candidato.perda > melhor.perda ||
          (candidato.perda === melhor.perda && candidato.pedido < melhor.pedido)))
    ) {
      melhor = candidato
    }
  }

  if (!melhor || melhor.perda < LIMIAR_PONTOS_MINIMOS || melhor.razao < LIMIAR_RAZAO) {
    return {
      custaCaro: false,
      candidato: null,
      motivo: melhor
        ? `o pior caso (#${melhor.pedido}, perda ${melhor.perda}, razão ${melhor.razao.toFixed(2)}) ` +
          `fica abaixo do limiar (perda ≥ ${LIMIAR_PONTOS_MINIMOS} e razão ≥ ${LIMIAR_RAZAO}) — diferença pequena, silêncio.`
        : 'a ordem escolhida já é a que minimiza a espera de todo mundo.',
    }
  }

  return { custaCaro: true, candidato: melhor }
}
