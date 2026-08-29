// Fonte ÚNICA de "que estado da sessão do dev assíncrono significa o quê".
// Sem rede, sem banco. Comparações sempre em UPPERCASE.
//
// POR QUE isto existe (medido ao vivo 29/08/2026): a esteira dos dois projetos
// parou porque o contador de concorrência somava TODA linha com closed_at nulo
// — inclusive as 21 (de 23) que o Jules já tinha dado como COMPLETED/FAILED.
// Sessão terminada no fornecedor NÃO ocupa vaga de concorrência lá (a vaga
// libera no instante em que a sessão termina — ver planos-do-jules na memória);
// contá-la aqui zerava a folga e o SM não delegava mais nada.
//
// DOIS CONJUNTOS, dois usos:
//  - ESTADOS_TERMINAIS: o Jules concluiu (com ou sem entrega) ou falhou. É o
//    passo terminal (sessao-terminal.ts) que decide o que fazer — nunca abandona
//    de vez, sempre redelega (D51).
//  - ESTADOS_QUE_OCUPAM_VAGA: o Jules ainda está tocando a sessão. Só esses
//    contam contra o teto de simultâneas do plano.
//
// FAIL-CLOSED para o desconhecido: o fornecedor pode introduzir estados novos.
// "Não sei" nunca vira "acabou" (ehTerminal → false) e nunca libera vaga sem
// base (ocupaVaga → true). Os dois erros seguros apontam para o mesmo lado:
// tratar o estado novo como trabalho em andamento até alguém ensinar o produto.

const TERMINAIS = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])
const OCUPAM_VAGA = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'PLANNING',
  'PAUSED',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
])

export const ESTADOS_TERMINAIS: ReadonlySet<string> = TERMINAIS
export const ESTADOS_QUE_OCUPAM_VAGA: ReadonlySet<string> = OCUPAM_VAGA

/** O Jules concluiu ou falhou — a sessão não anda mais sozinha. */
export function ehTerminal(state: string | null | undefined): boolean {
  return TERMINAIS.has((state ?? '').toUpperCase())
}

/**
 * A sessão ocupa uma das vagas simultâneas da conta do Jules?
 *
 * Terminal → false (a vaga já liberou lá). Estado de trabalho conhecido → true.
 * Estado desconhecido → true (fail-closed).
 */
export function ocupaVaga(state: string | null | undefined): boolean {
  const s = (state ?? '').toUpperCase()
  if (TERMINAIS.has(s)) return false
  return true
}
