/**
 * A reserva do lugar da issue, antes de acionar o dev externo.
 *
 * Ela é uma LINHA de verdade em `dev_sessions` porque quem decide o vencedor de
 * uma corrida é o índice único parcial do banco (uma issue, uma sessão viva) —
 * uma marca à parte poderia ser gravada por duas instâncias ao mesmo tempo.
 *
 * Mas linha de verdade tem efeito colateral: todo mundo que varre
 * `dev_sessions` passa a enxergá-la. Este arquivo existe para que quem NÃO deve
 * enxergá-la possa dizer isso em uma linha, em vez de espalhar comparações de
 * texto pelo produto.
 */

/** O prefixo do nome provisório, antes de o dev externo devolver o nome real. */
export const PREFIXO_DA_RESERVA = 'reserva/'

/** O nome provisório de uma reserva. */
export function nomeDaReserva(projectId: string, issueNumber: number): string {
  return `${PREFIXO_DA_RESERVA}${projectId}/${issueNumber}`
}

/**
 * Esta linha é só uma reserva, e não trabalho de verdade?
 *
 * Duas coisas precisam desta pergunta, e a revisão pegou as duas:
 *
 * 1. A RETROSPECTIVA conta como "abandonada" toda linha fechada que não foi
 *    mesclada. Uma reserva recusada pelo dev externo nasce e morre em segundos,
 *    sem nunca ter trabalhado — contá-la como abandono inflaria a taxa de
 *    abandono do projeto justamente porque o produto passou a recusar CEDO, que
 *    era o objetivo. A métrica dirige decisão humana de processo; alimentá-la
 *    com isso é ruído.
 *
 * 2. A VIGIA pergunta ao dev externo o estado de cada linha viva. O nome de uma
 *    reserva nunca existiu lá, então a consulta falha, e como a falha não
 *    carimba o relógio de exame, a linha era reconsultada a cada tique — não a
 *    cada dez minutos — até a varredura de abandono fechá-la horas depois.
 */
export function ehApenasReserva(sessionName: string | null | undefined): boolean {
  return typeof sessionName === 'string' && sessionName.startsWith(PREFIXO_DA_RESERVA)
}

/** Tira as reservas de uma lista de linhas, para quem só quer trabalho real. */
export function semAsReservas<T extends { sessionName: string }>(linhas: T[]): T[] {
  return linhas.filter((l) => !ehApenasReserva(l.sessionName))
}
