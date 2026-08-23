// O que fazer quando o GitHub reenvia uma entrega que já chegou.
//
// FLAGRADO AO VIVO em 23/08/2026, 19:26:43 — um segundo depois de o desejo do
// dono virar issue. A rota devolveu HTTP 500:
//
//   Invalid `prisma.webhookDelivery.create()` invocation:
//   Unique constraint failed on the fields: (`github_delivery_id`)
//
// O comentário acima daquela linha dizia "Persist webhook delivery for
// IDEMPOTENCY/retry tracking" — e usava `create`, que LANÇA em duplicata. O
// mecanismo escrito para tolerar reenvio era exatamente o que derrubava a rota.
//
// E o GitHub reenvia toda entrega que devolve 500, então o erro se
// realimentava: rajada de POSTs repetidos, todos morrendo no mesmo lugar.
// Resultado medido: ZERO missões criadas, o analista nunca acordou, e a prova
// ponta a ponta travou no primeiro passo — em silêncio, do ponto de vista de
// quem tinha acabado de pedir.

/** A linha que já existe para aquela entrega, quando existe. */
export interface EntregaJaRegistrada {
  processed: boolean
}

export type DecisaoSobreEntrega =
  /** Nunca vista: registrar e processar. */
  | { acao: 'processar' }
  /** Já vista E concluída: reenvio legítimo do GitHub, nada a fazer. */
  | { acao: 'ignorar'; motivo: string }
  /** Já vista e NÃO concluída: a tentativa anterior morreu no meio. */
  | { acao: 'retomar'; motivo: string }

/**
 * Decide o destino de uma entrega repetida.
 *
 * A DISTINÇÃO QUE IMPORTA está entre "já processei isto" e "comecei e não
 * terminei". Tratar as duas como iguais erra de um dos dois lados:
 *
 * - ignorando sempre, uma tentativa que morreu depois de gravar a linha e
 *   antes de acordar o papel perde a missão PARA SEMPRE, e em silêncio —
 *   ninguém fica sabendo que o pedido evaporou;
 * - processando sempre, um reenvio comum do GitHub vira missão duplicada.
 *
 * A marca `processed` já existia na tabela e ninguém a lia nesta decisão. Com
 * ela, cada caso vai para o seu lado, sem adivinhação.
 */
export function decidirSobreEntrega(
  existente: EntregaJaRegistrada | null | undefined
): DecisaoSobreEntrega {
  if (!existente) return { acao: 'processar' }
  if (existente.processed) {
    return { acao: 'ignorar', motivo: 'entrega repetida que já foi processada por inteiro' }
  }
  return {
    acao: 'retomar',
    motivo: 'entrega já registrada mas NÃO concluída — a tentativa anterior morreu no meio',
  }
}
